package app

import (
	"encoding/json"
	"errors"
	"fmt"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const storyboardSceneVersion = "storyboard-scene-v4"
const storyboardSceneValidationLimit = 6

var errStoryboardModeChanged = errors.New("分镜已在检查点切换为场次并发，重新接管主任务")

func (s *Service) promoteStoryboardScenes(userID, runID string) (bool, error) {
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return false, err
	}
	state, err := cloudAgentDecode(run)
	if err != nil || state.Request.Production == nil {
		return false, err
	}
	if state.ActiveTaskID != "" || len(state.ProductionParallel) > 0 || cloudAgentRunTerminal(run.Status) {
		return false, nil
	}
	_, m, _, err := productionLoad(s.repo, run, &state)
	if err != nil {
		return false, err
	}
	if m.Storyboard == nil || (m.Storyboard.AdaptiveWork && m.Storyboard.Version == storyboardSceneVersion) || (m.Storyboard.Version != storyboardEpisodeVersion && m.Storyboard.Version != storyboardSceneVersion) {
		return false, nil
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return false, err
	}
	err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		fresh, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		job, m, doc, err := productionLoad(repo, current, &fresh)
		if err != nil {
			return err
		}
		m.Storyboard.Version = storyboardSceneVersion
		m.Storyboard.AdaptiveWork = true
		fresh.event(runID, "production_control", map[string]any{"text": "已在检查点切换为镜头工作组并发，保留已有镜头与媒体"})
		if err := saveStoryboardCheckpoint(repo, current, &fresh, job, &m, doc, policy); err != nil {
			return err
		}
		return cloudAgentSave(current, &fresh)
	})
	return err == nil, err
}

// The ledger survives completed batches; transient queue entries may be removed.
// Historical ownership transitions live in the transactional event journal.
type storyboardAssignment struct {
	Key        string   `json:"key"`
	SceneID    string   `json:"sceneId"`
	Generation int      `json:"generation"`
	TaskID     string   `json:"taskId,omitempty"`
	Status     string   `json:"status"`
	InputHash  string   `json:"inputHash"`
	Offset     int      `json:"offset"`
	ShotIDs    []string `json:"shotIds"`
	Saved      int      `json:"saved"`
	Total      int      `json:"total"`
	ClaimedAt  int64    `json:"claimedAt,omitempty"`
	Recoveries int      `json:"recoveries,omitempty"`
}

const storyboardScenePolicy = `本轮由主Agent规划和验收，服务端按镜头工作组分派子Agent并发补全，同一场次可有多个并发任务。
主Agent先完整阅读带编号正文，production_storyboard_plan划分场次、原文范围、目标冲突、时长预算、入口和出口；production_storyboard_layout一次固定各场镜头数量、稳定编号、覆盖范围、时长及空间构图基准。
主Agent可在layout中用taskGroup将连续且适合一起完成的镜头分组；复杂长镜独立成组，简单连续镜头可合组，每组最多4镜。不填则服务端按工作量分组。场次不是并发边界。只有必须读取前镜实际结果的连续动作、道具交接、服化或空间承接才填dependsOn。依赖只能指向前序镜头，不要为了排序添加串行依赖。各组必须遵循共同入口、出口与空间基准。
场次任务由服务端创建和领取，任务编码、执行代次、领取任务ID、输入版本与镜头范围由服务端管理。子Agent只能提交分配场次的plannedShots，不得重规划、不写其他场次、不自行派发任务。按assignment和nextAction.arguments回报，expectedHash/offset/sceneId原样沿用。
主Agent等待任务表完成后，用production_storyboard_review一次核对整集正文覆盖、对白、动作、时长和跨场连续性。局部内容问题用repairShotIds并在review逐镜说明问题和修改要求，保留其他镜头和规划；仅需要改变范围、镜头数量或时长预算时才用repairSceneIds重规划整场。不得因个人措辞偏好重复返修。恢复时按检查点续作，不重派健康或已完成任务。
`

// Groups are fixed by the layout, never by completion order. This keeps task
// ownership stable when sibling results arrive out of order or after restart.
func storyboardWorkGroups(m productionManifest) []productionParallelWork {
	var groups []productionParallelWork
	for _, scene := range m.Storyboard.Scenes {
		if !m.Storyboard.AdaptiveWork {
			work := productionParallelWork{Key: scene.ID, SceneID: scene.ID, Name: "场次 " + scene.ID + " · " + scene.Title}
			for _, p := range scene.Layout {
				work.ShotIDs = append(work.ShotIDs, p.ID)
			}
			groups = append(groups, work)
			continue
		}
		for start := 0; start < len(scene.Layout); {
			end := start + 1
			first := scene.Layout[start]
			for end < len(scene.Layout) && end-start < 4 {
				next := scene.Layout[end]
				if first.TaskGroup != "" {
					if next.TaskGroup != first.TaskGroup {
						break
					}
				} else if next.TaskGroup != "" || end-start >= 2 || first.Duration >= 20 || next.Duration >= 20 || next.End-first.Start > 8 {
					break
				}
				end++
			}
			key := first.ID
			if start == 0 {
				key = scene.ID
			}
			work := productionParallelWork{Key: key, SceneID: scene.ID, BatchOffset: start, Name: "镜头工作组 " + first.ID + " ~ " + scene.Layout[end-1].ID}
			for _, p := range scene.Layout[start:end] {
				work.ShotIDs = append(work.ShotIDs, p.ID)
			}
			groups = append(groups, work)
			start = end
		}
	}
	return groups
}

func storyboardWorkGroup(m productionManifest, key string) (productionParallelWork, *productionScene) {
	for _, work := range storyboardWorkGroups(m) {
		if work.Key == key {
			return work, storyboardSceneByID(m, work.SceneID)
		}
	}
	return productionParallelWork{}, nil
}

func storyboardWorkBatch(m productionManifest, work productionParallelWork) (int, []productionShotOutline) {
	group, scene := storyboardWorkGroup(m, work.Key)
	if scene == nil {
		return 0, nil
	}
	offset := group.BatchOffset
	end := offset + len(group.ShotIDs)
	for offset < end && storyboardShotDone(m, scene.Layout[offset].ID) {
		offset++
	}
	limit := work.BatchLimit
	if limit <= 0 {
		limit = 4
	}
	available := map[string]bool{}
	var plans []productionShotOutline
	for i := offset; i < end && len(plans) < limit; i++ {
		plan := scene.Layout[i]
		if storyboardShotDone(m, plan.ID) {
			break
		}
		for _, id := range plan.DependsOn {
			if !available[id] && !storyboardShotDone(m, id) && !storyboardPlannedContinuity(m, plan.ID, id) {
				return offset, plans
			}
		}
		plans = append(plans, plan)
		available[plan.ID] = true
	}
	return offset, plans
}

func storyboardSceneInputHash(scene productionScene) string {
	scene.Shots, scene.PreviousShots, scene.Complete = nil, nil, false
	return productionStoredValueHash(scene)
}

func storyboardSubmissionHash(m productionManifest, scene productionScene) string {
	if m.Storyboard.AdaptiveWork {
		return storyboardSceneInputHash(scene)
	}
	return storyboardSceneHash(scene)
}

func storyboardBatchMode(s *productionStoryboard) bool {
	return s != nil && (s.Version == storyboardEpisodeVersion || s.Version == storyboardSceneVersion)
}

func storyboardSceneByID(m productionManifest, key string) *productionScene {
	if m.Storyboard == nil {
		return nil
	}
	for i := range m.Storyboard.Scenes {
		if m.Storyboard.Scenes[i].ID == key {
			return &m.Storyboard.Scenes[i]
		}
	}
	return nil
}

// A batch stops before an unresolved external dependency. Earlier shots in this
// same batch satisfy local dependencies when atomically applied in order.
func storyboardSceneBatch(m productionManifest, scene productionScene, limit int) (int, []productionShotOutline) {
	offset, plans := storyboardEpisodeBatch(scene)
	if limit <= 0 {
		limit = 4
	}
	if len(plans) > limit {
		plans = plans[:limit]
	}
	available := map[string]bool{}
	for _, sc := range m.Storyboard.Scenes {
		for _, shot := range sc.Shots {
			available[shot.ID] = true
		}
	}
	for i, plan := range plans {
		for _, dependency := range plan.DependsOn {
			if !available[dependency] {
				return offset, plans[:i]
			}
		}
		available[plan.ID] = true
	}
	return offset, plans
}

func storyboardScenePrerequisites(m productionManifest, key string) error {
	if !storyboardHasLayout(m.Storyboard) {
		return BadAuthRequest("先完成整集场次及镜头规划")
	}
	work, scene := storyboardWorkGroup(m, key)
	if scene == nil {
		return BadAuthRequest("场次不属于当前规划")
	}
	if scene.Complete {
		return BadAuthRequest("场次已经完成")
	}
	if _, plans := storyboardWorkBatch(m, work); len(plans) == 0 {
		return BadAuthRequest("等待前置镜头完成")
	}
	return nil
}

func storyboardSceneDependencies(m productionManifest, key string) string {
	_, scene := storyboardWorkGroup(m, key)
	if scene == nil {
		return ""
	}
	if !m.Storyboard.AdaptiveWork {
		return productionStoredValueHash([]any{m.Sources, m.Storyboard.BriefPageID, *scene})
	}
	return productionStoredValueHash([]any{m.Sources, m.Storyboard.BriefPageID, storyboardSceneInputHash(*scene), m.Storyboard.Review})
}

func storyboardScenePredecessorsHash(m productionManifest, work productionParallelWork) string {
	scene := storyboardSceneByID(m, work.SceneID)
	if scene == nil {
		return ""
	}
	assigned := map[string]bool{}
	for _, id := range work.ShotIDs {
		assigned[id] = true
	}
	ids := map[string]bool{}
	var planned []productionShotOutline
	for _, p := range scene.Layout {
		if assigned[p.ID] {
			for _, id := range p.DependsOn {
				if !assigned[id] {
					if storyboardPlannedContinuity(m, p.ID, id) {
						_, outline := storyboardPlannedShot(m, id)
						planned = append(planned, *outline)
						continue
					}
					ids[id] = true
				}
			}
		}
	}
	var required []productionShot
	for _, sc := range m.Storyboard.Scenes {
		for _, shot := range sc.Shots {
			if ids[shot.ID] {
				required = append(required, shot)
			}
		}
	}
	return productionStoredValueHash([]any{required, planned})
}

// Adjacent same-scene endpoints are already fixed by the shared layout. Their
// details can be written concurrently; the main review still checks actual joins.
// Cross-scene dependencies and incomplete planning contracts remain blocking.
func storyboardPlannedContinuity(m productionManifest, shotID, predecessorID string) bool {
	if m.Storyboard == nil || !m.Storyboard.AdaptiveWork || m.Storyboard.Version != storyboardSceneVersion {
		return false
	}
	scene, plan := storyboardPlannedShot(m, shotID)
	if plan == nil || plan.Entry == "" || plan.Camera == "" {
		return false
	}
	for i, p := range scene.Layout {
		if p.ID == shotID && i > 0 {
			previous := scene.Layout[i-1]
			return previous.ID == predecessorID && previous.Exit != "" && previous.Camera != ""
		}
	}
	return false
}

func storyboardSceneReady(m productionManifest) []productionParallelWork {
	var ready []productionParallelWork
	for _, work := range storyboardWorkGroups(m) {
		if storyboardScenePrerequisites(m, work.Key) != nil {
			continue
		}
		work.Dependencies = storyboardSceneDependencies(m, work.Key)
		ready = append(ready, work)
	}
	return ready
}

func storyboardSceneContext(repo *repository.Repository, run *model.CloudAgentExecution, m productionManifest, doc map[string]any, work *productionParallelWork) (map[string]any, error) {
	_, scene := storyboardWorkGroup(m, work.Key)
	if scene == nil {
		return nil, BadAuthRequest("场次不存在")
	}
	brief, err := repo.ProductionAgentPage(run.UserID, m.Storyboard.BriefPageID)
	if err != nil {
		return nil, err
	}
	if !brief.Processed {
		return nil, BadAuthRequest("制作简报尚未完成")
	}
	ctx := map[string]any{"phase": "scene", "nextTool": "production_storyboard_submit", "sceneId": scene.ID, "expectedHash": storyboardSubmissionHash(m, *scene), "brief": json.RawMessage(brief.FactsJSON)}
	storyboardEpisodeSceneContext(ctx, m.Storyboard, *scene, storyboardBody(m, doc))
	offset, plans := storyboardWorkBatch(m, *work)
	if len(plans) == 0 {
		return nil, BadAuthRequest("当前工作组没有可领取镜头")
	}
	work.SceneID, work.BatchOffset = scene.ID, offset
	work.ShotIDs = nil
	for _, p := range plans {
		work.ShotIDs = append(work.ShotIDs, p.ID)
	}
	work.PredecessorsHash = storyboardScenePredecessorsHash(m, *work)
	ctx["offset"], ctx["plannedShots"] = offset, plans
	ctx["nextShot"] = plans[0].ID
	if len(plans) > 0 {
		planIndex := -1
		for i, item := range scene.Layout {
			if item.ID == plans[0].ID {
				planIndex = i
				break
			}
		}
		delete(ctx, "previousShot")
		if planIndex > 0 {
			ctx["previousPlannedShot"] = scene.Layout[planIndex-1]
			for _, shot := range scene.Shots {
				if shot.ID == scene.Layout[planIndex-1].ID {
					ctx["previousShot"] = shot
					break
				}
			}
		}
	}
	ctx["reviewFeedback"] = m.Storyboard.Review
	var previous []productionShot
	for _, shot := range scene.PreviousShots {
		if cloudAgentContainsString(work.ShotIDs, shot.ID) {
			_, plan := storyboardPlannedShot(m, shot.ID)
			if plan != nil && shot.Start == plan.Start && shot.End == plan.End && shot.Duration == plan.Duration {
				previous = append(previous, shot)
			}
		}
	}
	ctx["previousShots"] = previous
	dependencies := map[string]bool{}
	for _, plan := range plans {
		for _, id := range plan.DependsOn {
			dependencies[id] = true
		}
	}
	var required []productionShot
	var requiredPlans []productionShotOutline
	for _, sc := range m.Storyboard.Scenes {
		for _, plan := range sc.Layout {
			if dependencies[plan.ID] {
				requiredPlans = append(requiredPlans, plan)
			}
		}
		for _, shot := range sc.Shots {
			if dependencies[shot.ID] {
				required = append(required, shot)
			}
		}
	}
	ctx["requiredPredecessors"] = required
	ctx["requiredPredecessorPlans"] = requiredPlans
	delete(ctx, "nextPlannedShot")
	if offset+len(plans) < len(scene.Layout) {
		ctx["nextPlannedShot"] = scene.Layout[offset+len(plans)]
	}
	ctx["source"] = storyboardNumberedUnits(storyboardBody(m, doc), scene.Start, scene.End)
	ctx["executionMode"] = "scene"
	remaining := 0
	plannedIDs := map[string]bool{}
	for _, plan := range plans {
		plannedIDs[plan.ID] = true
	}
	for _, plan := range scene.Layout {
		if !storyboardShotDone(m, plan.ID) && !plannedIDs[plan.ID] {
			remaining++
		}
	}
	ctx["completeAfterBatch"] = remaining == 0
	ctx["assignment"] = map[string]any{"key": work.Key, "generation": work.Generation, "shotIds": work.ShotIDs, "inputHash": work.Dependencies}
	ctx["nextAction"] = map[string]any{"tool": "production_storyboard_submit", "arguments": map[string]any{"sceneId": scene.ID, "offset": offset, "expectedHash": storyboardSubmissionHash(m, *scene), "complete": ctx["completeAfterBatch"]}}
	ctx["instruction"] = "你是当前场次的子Agent。只补全本次plannedShots并一次submit，可提交连续前缀但不能跳镜。使用完整场次正文理解剧情，逐字保留对应对白、动作、人物状态、道具使用、光源和镜头执行细节。只读当前提供的资产编码与必要细节。严守场次入口出口及空间基准，不修改规划；其余场次由其他Agent负责。"
	ctx["instruction"] = stringValue(ctx["instruction"]) + "同场其他工作组可能并发，不等待未声明依赖的镜头。返修时以previousShots和rejectedDraft为底稿，按reviewFeedback和currentItemFeedback定向修复，保留合格内容。camera是必填字符串，不能以shotSize等字段替代。完成状态由服务端计算。"
	ctx["instruction"] = stringValue(ctx["instruction"]) + "同场相邻镜头可按requiredPredecessorPlans中已固定的出口与本镜入口并发创作；规划不是已完成结果，不得声称已读取未完成镜头，最终由主Agent审查实际衔接。只提交assignment.shotIds，source和reviewFeedback中的其他镜头仅供理解，不得跟着生成整场。goal、entry、exit、taskGroup、dependsOn是规划字段，不要复制到shots；分别落实到visual和continuity。"
	ctx["instruction"] = stringValue(ctx["instruction"]) + "reviewFeedback可能来自重规划前；编号、start、end、duration一律以本次plannedShots为准，不能从旧审查或旧稿复制。start/end是正文段号，不是时间码。"
	storyboardAttachAssets(ctx, m, doc)
	return ctx, nil
}

func storyboardSceneCallError(work productionParallelWork, args map[string]any) error {
	if stringValue(args["sceneId"]) != work.SceneID || numberValue(args["offset"], -1) != float64(work.BatchOffset) {
		return BadAuthRequest("场次或批次不属于当前任务分配")
	}
	shots := creationMaps(args["shots"])
	if len(shots) == 0 || len(shots) > len(work.ShotIDs) {
		return cloudAgentFieldError("parameters.shots", "assignment_range", fmt.Sprintf("本次只领取镜头 %v，最多 %d 镜；实际提交 %d 镜。只返回此列表的连续前缀，不提交整场或其他工作组镜头", work.ShotIDs, len(work.ShotIDs), len(shots)))
	}
	for i, shot := range shots {
		if stringValue(shot["id"]) != work.ShotIDs[i] {
			return BadAuthRequest(fmt.Sprintf("当前任务只能按顺序提交镜头 %s", work.ShotIDs[i]))
		}
	}
	return nil
}
