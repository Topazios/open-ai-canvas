package app

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const storyboardLayoutVersion = "storyboard-layout-v2"

type storyboardSceneLayout struct {
	SceneID string                  `json:"sceneId"`
	Shots   []productionShotOutline `json:"shots"`
}

func storyboardHasLayout(s *productionStoryboard) bool {
	if len(s.Scenes) == 0 {
		return false
	}
	for _, scene := range s.Scenes {
		if !scene.Complete && len(scene.Layout) == 0 {
			return false
		}
	}
	return true
}

func applyStoryboardLayout(s *productionStoryboard, layouts []storyboardSceneLayout) error {
	if len(s.Scenes) == 0 || len(layouts) == 0 {
		return BadAuthRequest("先完成场次规划，再一次保存未完成场次的镜头清单")
	}
	if err := validateStoryboardPlanTiming(s.Scenes, s); err != nil {
		return err
	}
	byScene := map[string][]productionShotOutline{}
	for _, item := range layouts {
		if _, exists := byScene[item.SceneID]; exists || len(item.Shots) == 0 || len(item.Shots) > 200 {
			return BadAuthRequest("镜头清单场次重复或数量无效")
		}
		byScene[item.SceneID] = item.Shots
	}
	// Validate the complete layout before mutating any scene. Old shot receipts remain fixed.
	prior := map[string]bool{}
	for _, scene := range s.Scenes {
		if scene.Complete {
			for _, shot := range scene.Shots {
				prior[shot.ID] = true
			}
			continue
		}
		plans, ok := byScene[scene.ID]
		if !ok {
			return BadAuthRequest("镜头清单缺少未完成场次：" + scene.ID)
		}
		delete(byScene, scene.ID)
		if len(scene.Layout) > 0 && productionStoredValueHash(scene.Layout) != productionStoredValueHash(plans) {
			return BadAuthRequest("镜头清单已固定；需明确重做当前场次后才能重新规划")
		}
		check := scene
		check.Shots, check.Layout = nil, nil
		shots := []productionShot{}
		lastStart := scene.Start
		for i, plan := range plans {
			if plan.ID != fmt.Sprintf("%s-%03d", scene.ID, i+1) || plan.Start < lastStart || plan.End < plan.Start || strings.TrimSpace(plan.Goal) == "" || strings.TrimSpace(plan.Entry) == "" || strings.TrimSpace(plan.Exit) == "" || strings.TrimSpace(plan.Camera) == "" {
				return BadAuthRequest("镜头清单需按剧情顺序提供稳定编号、范围、目标、入出状态和构图基准")
			}
			for _, dependency := range plan.DependsOn {
				if !prior[dependency] {
					return BadAuthRequest("镜头依赖只能引用已规划的前序镜头：" + dependency)
				}
			}
			prior[plan.ID], lastStart = true, plan.Start
			shots = append(shots, productionShot{ID: plan.ID, Start: plan.Start, End: plan.End, Duration: plan.Duration, Visual: plan.Goal, Camera: plan.Camera, Continuity: plan.Exit})
		}
		for _, old := range scene.Shots {
			found := false
			for _, plan := range plans {
				if plan.ID == old.ID {
					found = plan.Start == old.Start && plan.End == old.End && math.Abs(plan.Duration-old.Duration) <= 0.001
				}
			}
			if !found {
				return BadAuthRequest("镜头清单不能改写已完成镜头的编号、范围或时长")
			}
		}
		// The normal submission API batches at most eight; layout validates all slots at once.
		for i := 0; i < len(shots); i += 8 {
			end := min(i+8, len(shots))
			if err := validateStoryboardShots(check, shots[i:end], end == len(shots)); err != nil {
				return err
			}
			if err := validateStoryboardTiming(check, shots[i:end], end == len(shots), s.ShotDuration, s.ShotTolerance); err != nil {
				return err
			}
			check.Shots = append(check.Shots, shots[i:end]...)
		}
	}
	if len(byScene) != 0 {
		return BadAuthRequest("镜头清单包含未知或已完成场次")
	}
	for i := range s.Scenes {
		for _, layout := range layouts {
			if s.Scenes[i].ID == layout.SceneID {
				s.Scenes[i].Layout = layout.Shots
			}
		}
	}
	if s.Version != storyboardEpisodeVersion {
		s.Version = storyboardLayoutVersion
	}
	s.ReviewHash = ""
	return nil
}

func storyboardPlannedShot(m productionManifest, key string) (*productionScene, *productionShotOutline) {
	for i := range m.Storyboard.Scenes {
		scene := &m.Storyboard.Scenes[i]
		for j := range scene.Layout {
			if scene.Layout[j].ID == key {
				return scene, &scene.Layout[j]
			}
		}
	}
	return nil, nil
}

func storyboardShotDone(m productionManifest, key string) bool {
	for _, scene := range m.Storyboard.Scenes {
		for _, shot := range scene.Shots {
			if shot.ID == key {
				return true
			}
		}
	}
	return false
}

func storyboardParallelDependencies(m productionManifest, key string) string {
	scene, plan := storyboardPlannedShot(m, key)
	if plan == nil {
		return ""
	}
	dependencies := []productionShot{}
	for _, id := range plan.DependsOn {
		for _, sc := range m.Storyboard.Scenes {
			for _, shot := range sc.Shots {
				if shot.ID == id {
					dependencies = append(dependencies, shot)
				}
			}
		}
	}
	return productionStoredValueHash([]any{m.Sources, scene.ID, scene.Entry, scene.Exit, scene.Goal, scene.Layout, plan, dependencies, m.Storyboard.BriefPageID})
}

func storyboardParallelPrerequisites(m productionManifest, key string) error {
	if !storyboardHasLayout(m.Storyboard) {
		return BadAuthRequest("先完成整集镜头清单，不能提前生成详情")
	}
	_, plan := storyboardPlannedShot(m, key)
	if plan == nil {
		return BadAuthRequest("镜头不属于当前规划版本")
	}
	for _, dependency := range plan.DependsOn {
		if !storyboardShotDone(m, dependency) {
			return BadAuthRequest("等待前置镜头：" + dependency)
		}
	}
	return nil
}

func storyboardParallelReady(m productionManifest) []productionParallelWork {
	if !storyboardHasLayout(m.Storyboard) {
		return nil
	}
	ready := []productionParallelWork{}
	for _, scene := range m.Storyboard.Scenes {
		if scene.Complete {
			continue
		}
		for _, plan := range scene.Layout {
			if storyboardShotDone(m, plan.ID) || storyboardParallelPrerequisites(m, plan.ID) != nil {
				continue
			}
			ready = append(ready, productionParallelWork{Key: plan.ID, Name: "镜头 " + plan.ID + " · " + truncateRunes(plan.Goal, 40), Dependencies: storyboardParallelDependencies(m, plan.ID)})
		}
	}
	return ready
}

func applyStoryboardExpansion(m productionManifest, doc map[string]any, sceneID string, shot productionShot) error {
	scene, plan := storyboardPlannedShot(m, shot.ID)
	if plan == nil || scene.ID != sceneID {
		return BadAuthRequest("只允许补全当前指定的占位镜头")
	}
	if err := storyboardParallelPrerequisites(m, shot.ID); err != nil {
		return err
	}
	if storyboardShotDone(m, shot.ID) {
		for _, old := range scene.Shots {
			if old.ID == shot.ID && productionStoredValueHash(old) == productionStoredValueHash(shot) {
				return nil
			}
		}
		return BadAuthRequest("该镜头已保存，不能被另一份结果覆盖")
	}
	if shot.Start != plan.Start || shot.End != plan.End || math.Abs(shot.Duration-plan.Duration) > 0.001 {
		return BadAuthRequest("镜头详情必须沿用规划的原文范围和时长")
	}
	// Reuse normal content validation with this slot's stable numeric offset.
	index := 0
	for i, p := range scene.Layout {
		if p.ID == shot.ID {
			index = i
		}
	}
	if err := validateStoryboardShot(*scene, shot, index+1); err != nil {
		return err
	}
	known := map[string]bool{}
	for _, code := range storyboardAssetMentions.FindAllString(strings.Join(storyboardBody(m, doc), "\n"), -1) {
		known[code], known[regexpStoryboardVariant.ReplaceAllString(code, "")] = true, true
	}
	for _, code := range shot.AssetIDs {
		if !known[code] {
			return BadAuthRequest("镜头引用的资产编码未出现在当前集正文：" + code)
		}
	}
	next := *scene
	next.Shots = append(append([]productionShot{}, scene.Shots...), shot)
	sort.Slice(next.Shots, func(i, j int) bool { return next.Shots[i].ID < next.Shots[j].ID })
	next.Complete = len(next.Shots) == len(next.Layout)
	if next.Complete {
		if err := validateStoryboardShots(next, nil, true); err != nil {
			return err
		}
		if err := validateStoryboardTiming(next, nil, true, m.Storyboard.ShotDuration, m.Storyboard.ShotTolerance); err != nil {
			return err
		}
		next.PreviousShots = nil
	}
	*scene = next
	m.Storyboard.ReviewHash = ""
	return nil
}

func storyboardParallelContext(repo *repository.Repository, run *model.CloudAgentExecution, m productionManifest, doc map[string]any, work productionParallelWork) (map[string]any, error) {
	if err := storyboardParallelPrerequisites(m, work.Key); err != nil {
		return nil, err
	}
	scene, plan := storyboardPlannedShot(m, work.Key)
	brief, err := repo.ProductionAgentPage(run.UserID, m.Storyboard.BriefPageID)
	if err != nil {
		return nil, err
	}
	if !brief.Processed {
		return nil, BadAuthRequest("制作简报尚未完成")
	}
	context := map[string]any{"phase": "expand", "nextTool": "production_storyboard_expand", "sceneId": scene.ID, "sceneGoal": scene.Goal, "sceneEntry": scene.Entry, "sceneExit": scene.Exit, "plannedShot": plan,
		"brief": json.RawMessage(brief.FactsJSON), "source": storyboardNumberedUnits(storyboardBody(m, doc), plan.Start, plan.End),
		"instruction": "只补全plannedShot，调用production_storyboard_expand保存，沿用sceneId及镜头ID/范围/时长。原文已提供，不读全剧或资产库。沿用共同构图与前后端点，资产编码只填本镜实际使用的正文编码。不要重新规划或生成其他镜头。"}
	for i, item := range scene.Layout {
		if item.ID == work.Key {
			if i > 0 {
				context["previousPlannedShot"] = scene.Layout[i-1]
			}
			if i+1 < len(scene.Layout) {
				context["nextPlannedShot"] = scene.Layout[i+1]
			}
		}
	}
	required := []productionShot{}
	for _, id := range plan.DependsOn {
		for _, sc := range m.Storyboard.Scenes {
			for _, shot := range sc.Shots {
				if shot.ID == id {
					required = append(required, shot)
				}
			}
		}
	}
	context["requiredPredecessors"] = required
	return context, nil
}

// Upgrade only at a model boundary, after any old in-flight response has settled.
func (s *Service) upgradeStoryboardLayout(run *model.CloudAgentExecution, state *cloudAgentRuntime) error {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	return s.repo.MutateCloudAgent(run.UserID, run.ID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		fresh, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		job, m, doc, err := productionLoad(repo, current, &fresh)
		if err != nil {
			return err
		}
		if m.Storyboard == nil || fresh.ActiveTaskID != "" || len(fresh.ProductionParallel) > 0 {
			return repository.ErrCreationConflict
		}
		m.Storyboard.Version = storyboardLayoutVersion
		if err := saveStoryboardCheckpoint(repo, current, &fresh, job, &m, doc, policy); err != nil {
			return err
		}
		return cloudAgentSave(current, &fresh)
	})
}

func projectStoryboardWorkRows(target map[string]any, state *cloudAgentRuntime) {
	meta, _ := target["metadata"].(map[string]any)
	table, _ := meta["storyboard"].(map[string]any)
	for _, row := range creationMaps(table["rows"]) {
		work, exists := state.ProductionParallel[stringValue(row["shotCode"])]
		if !exists {
			continue
		}
		row["detailTaskId"] = work.TaskID
		if row["detailStatus"] == "ready" {
			continue
		}
		if work.Error != "" {
			row["detailStatus"], row["detailError"] = "error", work.Error
		} else if work.TaskID != "" {
			row["detailStatus"] = "queued"
			delete(row, "detailError")
		} else if work.Correction != "" {
			row["detailStatus"], row["detailError"] = "retrying", work.Correction
		}
	}
}

func persistStoryboardWork(repo *repository.Repository, current *model.CloudAgentExecution, state *cloudAgentRuntime, policy RuntimePolicySetting) error {
	job, m, doc, err := productionLoad(repo, current, state)
	if err != nil {
		return err
	}
	if m.Storyboard == nil {
		return nil
	}
	return saveStoryboardCheckpoint(repo, current, state, job, &m, doc, policy)
}
