package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func (s *Service) productionFlowGraph(run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, root string) (productionFlowGraph, bool, error) {
	s.initReadCaches()
	return productionFlowBuildGraph(s.repo, run, state, m, doc, artifacts, root, false, s.flowSourceCache)
}

func productionFlowBuildGraph(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, root string, resumeHeld bool, caches ...*productionFlowSourceCache) (productionFlowGraph, bool, error) {
	source := productionFlowSourceHash(m, root, artifacts)
	rows, err := repo.ProductionFlowUnits(run.UserID, run.ID, root, source)
	if err != nil {
		return productionFlowGraph{}, false, err
	}
	g := productionFlowGraph{ResumeHeld: resumeHeld, Existing: map[string]model.ProductionFlowUnit{}, Aggregates: map[string][]model.ProductionFlowUnit{}, UserID: run.UserID, RunID: run.ID, Root: root, Source: source}
	for _, row := range rows {
		g.Existing[row.ID] = row
	}
	if root == "story" {
		sources := []map[string]any{}
		for _, source := range m.Sources {
			for _, id := range source.Pages {
				page, err := repo.ProductionAgentPage(run.UserID, id)
				if err != nil {
					return g, false, err
				}
				sources = append(sources, map[string]any{"sourceId": source.NodeID, "pageId": id, "text": page.Text})
			}
		}
		parameters := productionWorkflow(productionNode(doc, m.FrameID))["parameters"]
		params, _ := parameters.(map[string]any)
		count := int(numberValue(params["episodeCount"], 0))
		if count < 1 {
			return g, false, BadAuthRequest("缺少明确总集数，未擅自分配故事范围")
		}
		complete := productionFlowStoryGraph(&g, map[string]any{"prompt": state.Request.Prompt, "parameters": parameters, "sources": sources}, count)
		return g, complete, nil
	}
	if len(m.Plan.FlowStoryUnits) > 0 {
		adopted, err := repo.ProductionFlowUnitsByIDs(run.UserID, run.ID, m.Plan.FlowStoryUnits)
		if err != nil {
			return g, false, err
		}
		byID := map[string]model.ProductionFlowUnit{}
		for _, u := range adopted {
			byID[u.ID] = u
		}
		ordered, versions := []model.ProductionFlowUnit{}, []string{}
		for _, id := range m.Plan.FlowStoryUnits {
			u, exists := byID[id]
			if !exists || u.Status != "accepted" {
				return g, false, productionPlanConflict("规划记录缺失或未采用，未重新调用模型提取资产")
			}
			ordered = append(ordered, u)
			versions = append(versions, u.ID, productionHash(u.ResultJSON))
		}
		catalog, err := productionPlanningInventory(ordered, source)
		if err != nil {
			return g, false, err
		}
		g.Catalog = &catalog
		u, _ := g.add("catalog", "catalog", "汇总已登记资产与分集使用关系", map[string]any{"planningVersion": productionPlanningTemplate, "adoptedVersions": versions})
		if _, saved := g.Existing[u.ID]; !saved {
			g.Units[len(g.Units)-1].Status = "accepted"
			g.Units[len(g.Units)-1].ResultJSON = productionFlowJSON(catalog)
		}
		return g, true, nil
	}
	sections, bodies, err := productionFlowPublishedSources(repo, run, m, doc, artifacts, caches...)
	if err != nil {
		return g, false, err
	}
	sources := productionFlowSources(source, sections, bodies)
	if len(sources) == 0 {
		return g, false, BadAuthRequest("当前总纲没有可追溯来源，未开始空总表")
	}
	g.AuditRevision = m.Plan.InventoryAuditRevision
	complete := productionFlowInventoryGraph(&g, sources)
	return g, complete, nil
}

func productionFlowActiveIDs(g productionFlowGraph) map[string]bool {
	ids := map[string]bool{}
	for _, u := range g.Units {
		ids[u.ID] = true
	}
	return ids
}

func (s *Service) advanceProductionFlow(run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, root string) (bool, error) {
	if state.ProductionPaused || run.Status == "waiting_user" {
		return false, nil
	}
	// An edited reading copy must not restart paid extraction of a completed
	// registry. Rebuild the projection locally and preserve the edited node.
	if root == "inventory" && m.Plan.Complete && m.Plan.StoryHash == productionFlowSourceHash(m, root, artifacts) && productionValidatePlanInventory(*m.Plan) == nil {
		policy, err := s.RuntimePolicy()
		if err != nil {
			return false, err
		}
		s.storageMu.Lock()
		defer s.storageMu.Unlock()
		err = s.repo.MutateCloudAgent(run.UserID, run.ID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			fresh, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			if fresh.ProductionPaused || current.Status == "waiting_user" || cloudAgentRunTerminal(current.Status) {
				return repository.ErrCreationConflict
			}
			if err := productionFlowFence(fresh, *state); err != nil {
				return err
			}
			_, manifest, document, err := productionLoad(repo, current, &fresh)
			if err != nil {
				return err
			}
			rows, err := repo.ProductionAgentArtifacts(run.UserID, run.ID)
			if err != nil {
				return err
			}
			if manifest.Plan.StoryHash != m.Plan.StoryHash || productionPlanInventoryHash(*manifest.Plan) != productionPlanInventoryHash(*m.Plan) {
				return repository.ErrCreationConflict
			}
			if manifest.Plan.InventoryReviewVersion > 0 {
				if err := productionValidateInventoryReview(*manifest.Plan, document, manifest.FrameID, rows, true); err != nil {
					return err
				}
			}
			if err := productionSavePlanInventory(repo, current, &fresh, manifest, document, rows, policy); err != nil {
				return err
			}
			_, manifest, document, err = productionLoad(repo, current, &fresh)
			if err != nil {
				return err
			}
			rows, err = repo.ProductionAgentArtifacts(run.UserID, run.ID)
			if err != nil {
				return err
			}
			if !productionPlanArtifactValid(manifest, document, rows, "inventory") {
				return productionPlanConflict("资产总表本地汇总后仍未通过完整校验，已保留原稿，未调用模型")
			}
			fresh.event(run.ID, "production_flow_published", map[string]any{"root": root, "text": "已从登记记录重新汇总资产总表，保留人工修改稿，未调用模型"})
			return cloudAgentSave(current, &fresh)
		})
		return true, err
	}
	g, complete, err := s.productionFlowGraph(run, state, m, doc, artifacts, root)
	if err != nil {
		return false, err
	}
	// Save assignments before dispatch. A crash can leave pending work, never an
	// external request without a durable assignment in the same admission tx.
	missing := false
	for _, unit := range g.Units {
		if _, ok := g.Existing[unit.ID]; !ok {
			missing = true
			break
		}
	}
	if missing {
		policy, err := s.RuntimePolicy()
		if err != nil {
			return false, err
		}
		s.storageMu.Lock()
		defer s.storageMu.Unlock()
		err = s.repo.MutateCloudAgent(run.UserID, run.ID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			fresh, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			if fresh.ProductionPaused || current.Status == "waiting_user" || cloudAgentRunTerminal(current.Status) {
				return repository.ErrCreationConflict
			}
			if err := productionFlowFence(fresh, *state); err != nil {
				return err
			}
			for i := range g.Units {
				if err := repo.EnsureProductionFlowUnit(&g.Units[i]); err != nil {
					return err
				}
			}
			if err := productionFlowStorageQuota(repo, run.UserID, policy); err != nil {
				return err
			}
			fresh.event(run.ID, "production_flow_planned", map[string]any{"root": root, "sourceVersion": g.Source, "unitCount": len(g.Units), "text": "已保存当前阶段的工作分配，完成项将直接复用"})
			return cloudAgentSave(current, &fresh)
		})
		return true, err
	}
	for _, parent := range g.Units {
		if children := g.Aggregates[parent.ID]; len(children) > 0 {
			policy, err := s.RuntimePolicy()
			if err != nil {
				return false, err
			}
			s.storageMu.Lock()
			defer s.storageMu.Unlock()
			result, issues := productionFlowAggregate(parent, children)
			err = s.repo.MutateCloudAgent(run.UserID, run.ID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
				fresh, err := cloudAgentDecode(current)
				if err != nil {
					return err
				}
				if err := productionFlowFence(fresh, *state); err != nil {
					return err
				}
				if fresh.ProductionPaused || current.Status == "waiting_user" {
					return repository.ErrCreationConflict
				}
				for _, child := range children {
					saved, err := repo.ProductionFlowUnit(run.UserID, run.ID, child.ID)
					if err != nil {
						return err
					}
					if saved.Status != "accepted" || saved.Generation != child.Generation || saved.ResultJSON != child.ResultJSON {
						return repository.ErrCreationConflict
					}
				}
				parent.ResultJSON, parent.IssuesJSON, parent.Status = result, productionFlowJSON(issues), "accepted"
				if len(issues) > 0 {
					parent.Status = "held"
				}
				if err := repo.SaveProductionFlowUnit(&parent, parent.TaskID, parent.Generation); err != nil {
					return err
				}
				if err := productionFlowStorageQuota(repo, run.UserID, policy); err != nil {
					return err
				}
				fresh.event(run.ID, "production_flow_aggregated", map[string]any{"unitId": parent.ID, "text": "已从拆分成果本地汇总，不重复调用模型", "status": parent.Status})
				return cloudAgentSave(current, &fresh)
			})
			return true, err
		}
	}
	// Terminal responses are received even when another unit is being repaired.
	activeIDs := []string{}
	for _, u := range g.Units {
		if u.Status == "running" {
			activeIDs = append(activeIDs, u.TaskID)
		}
	}
	taskStates, err := s.repo.TaskStatesForUser(run.UserID, activeIDs)
	if err != nil {
		return false, err
	}
	statuses := map[string]model.TaskStatus{}
	for _, task := range taskStates {
		statuses[task.ID] = task.Status
	}
	settled := 0
	for _, u := range g.Units {
		if u.Status != "running" {
			continue
		}
		if status, exists := statuses[u.TaskID]; !exists {
			return false, productionPlanConflict("执行记录缺少所属任务，已停止重复派发")
		} else if !cloudAgentTaskTerminal(status) {
			continue
		}
		task, err := s.repo.TaskForUser(run.UserID, u.TaskID)
		if err != nil {
			return false, err
		}
		if cloudAgentTaskTerminal(task.Status) {
			work, ok := state.ProductionParallel[u.Key]
			if !ok || work.FlowUnitID != u.ID || work.Generation != u.Generation {
				return false, productionPlanConflict("工作单元与任务领取记录不一致，未重复发起收费请求")
			}
			if err := s.settleProductionFlow(run.UserID, run.ID, work, task); err != nil {
				return settled > 0, err
			}
			settled++
			if settled >= 16 {
				break
			}
		}
	}
	if settled > 0 {
		return true, nil
	}
	if complete {
		return true, s.publishProductionFlow(run, state, m, doc, artifacts, g)
	}
	policy, err := s.runtimeConcurrencySetting()
	if err != nil {
		return false, err
	}
	ceiling := min(policy.ConcurrencyFor(model.TaskConcurrencyAgent), policy.ChannelConcurrency)
	state.ProductionFlowControl.initialize(root, g.Source, ceiling, productionFlowRequests(g))
	limit := state.ProductionFlowControl.limit(ceiling, time.Now())
	running := 0
	held := false
	pending := false
	dispatched := 0
	for _, u := range g.Units {
		if u.Status == "running" {
			running++
		}
		held = held || u.Status == "held"
	}
	for _, u := range g.Units {
		if u.Status != "pending" && u.Status != "repair" {
			continue
		}
		pending = true
		if work := state.ProductionParallel[u.Key]; work.FlowUnitID == u.ID && work.RetryAt > time.Now().UnixMilli() {
			continue
		}
		if running >= limit {
			break
		}
		if productionFlowIsRetry(u) && state.ProductionFlowControl.RetrySpent >= state.ProductionFlowControl.RetryBudget {
			continue
		}
		err := s.enqueueProductionFlow(run, state, u)
		if errors.Is(err, repository.ErrActiveTaskLimit) {
			return dispatched > 0, nil
		}
		if err != nil {
			return dispatched > 0, err
		}
		dispatched++
		running++
		if dispatched >= 8 {
			break
		}
		// Refresh only the ownership record between admissions, not the entire
		// story, canvas and graph. Each admission retains its transaction fence.
		run, err = s.repo.CloudAgent(run.UserID, run.ID)
		if err != nil {
			return true, err
		}
		fresh, decodeErr := cloudAgentDecode(run)
		if decodeErr != nil {
			return true, decodeErr
		}
		*state = fresh
	}
	if dispatched > 0 {
		return true, nil
	}
	if pending && running == 0 && state.ProductionFlowControl.RetrySpent >= state.ProductionFlowControl.RetryBudget {
		err := s.repo.MutateCloudAgent(run.UserID, run.ID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			fresh, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			if err := productionFlowFence(fresh, *state); err != nil {
				return err
			}
			if fresh.ProductionPaused || cloudAgentRunTerminal(current.Status) || current.Status == "waiting_user" {
				return repository.ErrCreationConflict
			}
			if !fresh.ProductionFlowControl.recover(time.Now()) {
				return errProductionFlowRecoveryExhausted
			}
			fresh.event(run.ID, "production_flow_retry", map[string]any{"root": root, "retryAt": fresh.ProductionFlowControl.CooldownUntil, "text": "连续修复暂未推进，已降低并发并安排自动恢复，已保存成果保留，无需手动继续"})
			return cloudAgentSave(current, &fresh)
		})
		if errors.Is(err, errProductionFlowRecoveryExhausted) {
			return s.holdProductionFlow(run.UserID, run.ID, "多轮自动恢复后仍无有效进展，已停止重复请求并保留成果；请查看未完成步骤的具体原因")
		}
		return err == nil, err
	}
	if held && running == 0 && !pending {
		err = s.repo.MutateCloudAgent(run.UserID, run.ID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			fresh, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			current.Status = "waiting_user"
			current.FailureMessage = productionFlowHeldMessage(g.Units)
			fresh.LastError = current.FailureMessage
			fresh.event(run.ID, "production_progress", map[string]any{"text": current.FailureMessage, "root": root})
			return cloudAgentSave(current, &fresh)
		})
		return true, err
	}
	return false, nil
}

func (s *Service) enqueueProductionFlow(run *model.CloudAgentExecution, state *cloudAgentRuntime, unit model.ProductionFlowUnit) error {
	if state.ProductionPaused || cloudAgentRunTerminal(run.Status) || run.Status == "waiting_user" {
		return context.Canceled
	}
	requestUnit := productionFlowRequestUnit(unit)
	contextData := productionFlowInput(requestUnit)
	contextData["adopted"] = productionFlowValue(unit)
	contextData["repairIssues"] = json.RawMessage(unit.IssuesJSON)
	contextData["instruction"] = productionFlowInstructions(unit.Stage)
	if unit.Stage == "resolve" {
		contextData["instruction"] = productionFlowInstructions(unit.Stage) + " 同时按剧情作用填写 importance：primary 主线关键主体，secondary 主要支持主体，supporting 其他功能主体。不能按姓名或提交顺序决定主次。"
	}
	if selected, ok := contextData["selectedFields"]; ok {
		contextData["instruction"] = productionFlowInstructions(unit.Stage) + " 本次仅提交 selectedFields 指定字段：" + productionFlowJSON(selected) + "；其余内容由服务端保留并汇总。总纲只确定主线、结局、规则和任务分配，不扩写逐集正文或摄影细节。"
	}
	if productionFlowHasBatchPolicy(contextData) {
		contextData["instruction"] = stringValue(contextData["instruction"]) + productionFlowBatchInstruction(unit.Stage)
	}
	tool := map[string]any{"type": "function", "function": map[string]any{"name": productionFlowTool, "description": "只提交当前步骤内容；任务归属、版本、编号及完成状态由服务端维护。", "parameters": productionFlowSchema(requestUnit)}}
	prompt := "执行当前制作工作单元：" + unit.Name
	instructions := productionFlowInstructions(unit.Stage)
	if productionFlowHasBatchPolicy(contextData) {
		instructions += productionFlowBatchInstruction(unit.Stage)
	}
	canonical := canonicalAgentRequest{SystemPrompt: instructions, Tools: []map[string]any{tool}, ToolChoice: "auto", Messages: productionCheckpointMessages(nil, prompt, contextData, instructions), PromptCacheKey: state.Canonical.PromptCacheKey}
	var err error
	state.StepLimits, err = s.cloudAgentStepLimits()
	if err != nil {
		return err
	}
	work := productionParallelWork{FlowUnitID: unit.ID, Key: unit.Key, Name: unit.Name, Attempts: unit.Attempts + 1, Dependencies: unit.SourceHash, Step: state.Step + 1}
	if previous := state.ProductionParallel[unit.Key]; previous.FlowUnitID == unit.ID {
		work.TransientAttempts = previous.TransientAttempts
	}
	channelID, channelModelKey, logicalModelID, modelName := productionParallelModelSelection(work, *state)
	thinking := cloudAgentReasoningEnabled(state.Policy.ReasoningMode) && !state.ForceThinkingOff
	input := map[string]any{"mode": "text", "prompt": prompt, "agentRequests": map[string]any{"canonical": canonical}, "config": map[string]any{"channelId": channelID, "channelModelKey": channelModelKey, "model": firstNonEmpty(channelModelKey, modelName)}, "textOptions": map[string]any{"stream": true, "thinking": thinking, "reasoningEffort": productionFlowEffort(unit, state.Request.ReasoningEffort), "reasoningDisabled": !thinking, "maxOutputTokens": cloudAgentStepOutputBudget(state.StepLimits, state.BoostStepOutputBudget)}, "productionParallelKey": unit.Key, "productionDependencies": unit.SourceHash}
	req := CreateTaskRequest{ProjectID: state.Request.CanvasID, Type: "canvas_text", Operation: cloudAgentStepOperation, Prompt: prompt, Model: firstNonEmpty(channelModelKey, modelName), LogicalModelID: logicalModelID, Input: input}
	if err = s.enqueueCloudAgentTaskWithWork(run, state, req, nil, &work); err == nil {
		s.wakeTaskDispatcher()
	}
	return err
}

func productionFlowArguments(task *model.Task) (string, []productionFlowIssue) {
	if task.Status != model.TaskStatusSucceeded {
		return "", []productionFlowIssue{productionFlowIssueAt("protocol", "request_failed", task.ID, userFacingTaskFailure(task))}
	}
	var result struct {
		ToolCalls []cloudAgentCall `json:"toolCalls"`
		Text      string           `json:"text"`
		Content   string           `json:"content"`
	}
	if json.Unmarshal([]byte(task.ResultJSON), &result) != nil {
		return "", []productionFlowIssue{productionFlowIssueAt("protocol", "response_json", task.ID, "本地无法解析已保存响应；未判定为上游失败")}
	}
	if len(result.ToolCalls) == 1 && result.ToolCalls[0].Function.Name == productionFlowTool {
		return result.ToolCalls[0].Function.Arguments, nil
	}
	if len(result.ToolCalls) == 0 {
		raw := productionFlowNormalizeJSON(firstNonEmpty(result.Text, result.Content))
		if json.Valid([]byte(raw)) && strings.HasPrefix(raw, "{") {
			return raw, nil
		}
	}
	return "", []productionFlowIssue{productionFlowIssueAt("protocol", "response_contract", task.ID, "响应未包含当前工具调用或单一完整 JSON；原响应已保存在任务记录")}
}

func (s *Service) settleProductionFlow(userID, runID string, work productionParallelWork, task *model.Task) error {
	transient := task.Status == model.TaskStatusFailed && task.ProviderCancelStatus != model.ProviderCancelStatusRequested && task.ProviderCancelStatus != model.ProviderCancelStatusUncertain && s.cloudAgentModelTaskTransientFailure(task.ID)
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return err
	}
	return s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		unit, err := repo.ProductionFlowUnit(userID, runID, work.FlowUnitID)
		if err != nil {
			return err
		}
		// A receipt remains queryable in the task even when its writer has lost
		// its lease. Old generations never adopt, publish or advance progress.
		if unit.TaskID != task.ID || unit.Generation != work.Generation || unit.Status != "running" {
			return nil
		}
		if cloudAgentRunTerminal(current.Status) || state.ProductionPaused || current.Status == "waiting_user" {
			return nil
		}
		if state.ProductionFlowCoordinator.Generation > 0 && (state.ProductionFlowCoordinator.Owner == "" || state.ProductionFlowCoordinator.LeaseUntil <= time.Now().UnixMilli()) {
			return nil
		}
		actual := state.ProductionParallel[unit.Key]
		if actual.TaskID != task.ID || actual.Generation != unit.Generation || actual.FlowUnitID != unit.ID {
			return repository.ErrCreationConflict
		}
		_, m, _, err := productionLoad(repo, current, &state)
		if err != nil {
			return err
		}
		artifacts, err := repo.ProductionAgentArtifacts(userID, runID)
		if err != nil {
			return err
		}
		if unit.SourceHash != productionFlowSourceHash(m, unit.Root, artifacts) {
			return productionPlanConflict("来源版本已变化，旧结果保留为原版本草稿，未正式写入")
		}
		raw, issues := productionFlowArguments(task)
		if task.Status != model.TaskStatusSucceeded {
			issues = []productionFlowIssue{s.productionFlowFailure(task)}
		}
		result := unit.ResultJSON
		if len(issues) == 0 {
			result, issues = productionFlowValidate(*unit, raw)
		}
		priorTask, priorGeneration := unit.TaskID, unit.Generation
		planned, err := repo.ProductionFlowUnits(userID, runID, unit.Root, unit.SourceHash)
		if err != nil {
			return err
		}
		ceiling := min(policy.Task.AgentConcurrency, policy.Task.ChannelConcurrency)
		state.ProductionFlowControl.initialize(unit.Root, unit.SourceHash, ceiling, productionFlowRequests(productionFlowGraph{Units: planned}))
		state.ProductionFlowControl.Received++
		unit.ResultJSON = result
		unit.IssuesJSON = productionFlowJSON(issues)
		unit.Status = "accepted"
		unit.UpdatedAt = time.Now().UTC()
		if len(issues) > 0 {
			unit.Status = "repair"
			// Transport retries and content repairs have separate, durable budgets.
			if transient {
				unit.Attempts = max(0, unit.Attempts-1)
			}
			contentAttempts := unit.Attempts
			if contentAttempts > productionFlowRepairLimit || task.Status != model.TaskStatusSucceeded {
				unit.Status = "held"
			}
			if contentAttempts > productionFlowRepairLimit && task.Status == model.TaskStatusSucceeded || cloudAgentOutputLimitReached(task) {
				productionFlowRestructure(unit)
			}
			if transient {
				state.ProductionFlowControl.congestion(time.Now())
			}
			if transient && actual.TransientAttempts < productionParallelTransientRetries {
				actual.TransientAttempts++
				actual.TaskID, actual.Error, actual.QuietHold = "", "", false
				actual.RetryAt = time.Now().Add(s.productionParallelTransientBackoff(task.ID, actual.TransientAttempts)).UnixMilli()
				unit.Status = "repair"
			}
		}
		if unit.Status == "accepted" {
			state.ProductionFlowControl.accepted(ceiling)
		}
		receipt := model.ProductionFlowReceipt{ID: productionHash([]string{unit.ID, task.ID, fmt.Sprint(unit.Generation)}), UserID: userID, RunID: runID, UnitID: unit.ID, TaskID: task.ID, Generation: unit.Generation, ArgumentsJSON: raw, AdoptedJSON: result, IssuesJSON: unit.IssuesJSON}
		if err := repo.CreateProductionFlowReceipt(&receipt); err != nil {
			return err
		}
		if err := repo.SaveProductionFlowUnit(unit, priorTask, priorGeneration); err != nil {
			return err
		}
		delete(state.ProductionParallel, unit.Key)
		if unit.Status == "repair" {
			if !transient {
				actual.TaskID, actual.RetryAt = "", 0
			}
			state.ProductionParallel[unit.Key] = actual
			if transient {
				state.event(runID, "production_flow_retry", map[string]any{"unitId": unit.ID, "assetKey": unit.Key, "attempt": actual.TransientAttempts, "retryAt": actual.RetryAt, "issues": issues, "text": unit.Name + "：" + issues[0].Message + "；已安排自动重试，其他独立步骤继续执行"})
			}
		}
		if unit.Status == "held" {
			work.TransientAttempts = actual.TransientAttempts
			work.QuietHold = true
			work.Error = "当前单元待重试，已接收内容与问题记录保留"
			work.TaskID = ""
			for _, issue := range issues {
				work.ValidationIssues = append(work.ValidationIssues, cloudAgentValidationIssue{Field: issue.Target, Issue: issue.Rule, Message: issue.Message})
			}
			state.ProductionParallel[unit.Key] = work
		}
		if unit.Stage == "review" && unit.Status == "accepted" {
			var reported []productionFlowIssue
			_ = decodeFlowValue(productionFlowValue(*unit)["issues"], &reported)
			units, err := repo.ProductionFlowUnits(userID, runID, unit.Root, unit.SourceHash)
			if err != nil {
				return err
			}
			for _, issue := range reported {
				if issue.Severity != "blocking" {
					continue
				}
				for i := range units {
					target := &units[i]
					if target.Key != issue.Target || target.Status != "accepted" {
						continue
					}
					oldTask, oldGeneration := target.TaskID, target.Generation
					target.Status = "repair"
					target.IssuesJSON = productionFlowJSON([]productionFlowIssue{issue})
					if target.Attempts > productionFlowRepairLimit {
						target.Status = "held"
					}
					if err := repo.SaveProductionFlowUnit(target, oldTask, oldGeneration); err != nil {
						return err
					}
					// Even an unchanged repair must be reviewed again; an old
					// accepted review cannot certify its own blocking finding.
					for j := range units {
						review := &units[j]
						if review.Stage != "review" || review.Status != "accepted" {
							continue
						}
						sources, _ := productionFlowInput(*review)["sources"].(map[string]any)
						if _, depends := sources[target.Key]; !depends {
							continue
						}
						rt, rg := review.TaskID, review.Generation
						review.Status = "pending"
						if err := repo.SaveProductionFlowUnit(review, rt, rg); err != nil {
							return err
						}
					}
				}
			}
		}
		state.ProductionProgressStep = state.Step
		if err := productionFlowStorageQuota(repo, userID, policy); err != nil {
			return err
		}
		payload := productionModelCompletedPayload(task, work.Step, "当前返回已接收并保存校验记录")
		payload["itemName"] = unit.Name
		state.event(runID, "production_model_completed", payload)
		state.event(runID, "production_flow_saved", map[string]any{"unitId": unit.ID, "assetKey": unit.Key, "itemName": unit.Name, "stage": unit.Stage, "status": unit.Status, "taskId": task.ID, "generation": unit.Generation, "issues": issues, "text": "当前单元接收、校验结果与恢复状态已保存"})
		return cloudAgentSave(current, &state)
	})
}

func productionFlowStorageQuota(repo *repository.Repository, userID string, policy RuntimePolicySetting) error {
	usage, err := repo.UserStorageUsage(userID)
	if err != nil {
		return err
	}
	return validateTaskDataGrowthQuotaWithPolicy(usage, 0, policy.Resource)
}
