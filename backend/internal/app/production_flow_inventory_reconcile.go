package app

import (
	"errors"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Reconciliation reuses extraction receipts. Old registry and reading copy stay
// available until the new omissions and identity decisions publish atomically.
func productionFlowPrepareInventoryReconcile(repo *repository.Repository, current *model.CloudAgentExecution, state *cloudAgentRuntime) error {
	_, m, doc, err := productionLoad(repo, current, state)
	if err != nil {
		return err
	}
	if m.Plan == nil || m.Plan.FlowVersion != 1 || m.Plan.AssetsStarted || current.Status == "cancelled" {
		return productionPlanConflict("仅支持尚未启动资产制作的分阶段方案；已有下游资产时请创建新的方案版本")
	}
	if (current.Status == "running" || current.Status == "queued") && !state.ProductionPaused {
		return productionPlanConflict("请先暂停当前任务，等待模型调用结束后再核对总表")
	}
	ids := []string{state.ActiveTaskID}
	for _, work := range state.ProductionParallel {
		ids = append(ids, work.TaskID)
	}
	units, err := repo.ProductionFlowUnits(current.UserID, current.ID, "", "")
	if err != nil {
		return err
	}
	for _, unit := range units {
		ids = append(ids, unit.TaskID)
	}
	for _, id := range ids {
		if id == "" {
			continue
		}
		task, err := repo.TaskForUser(current.UserID, id)
		if err != nil {
			return err
		}
		if !cloudAgentTaskTerminal(task.Status) || task.ProviderCancelStatus == model.ProviderCancelStatusRequested || task.ProviderCancelStatus == model.ProviderCancelStatusUncertain {
			return productionPlanConflict("仍有模型调用执行或待核对，未重复提交收费请求")
		}
	}
	rows, err := repo.ProductionAgentArtifacts(current.UserID, current.ID)
	if err != nil {
		return err
	}
	if !productionPlanArtifactValid(m, doc, rows, "story") {
		return productionPlanConflict("请先确认当前总纲，再重新核对资产总表")
	}
	for _, row := range rows {
		if _, shared := planSection(row.Key); !shared {
			return productionPlanConflict("已有独立资产档案，未改变其身份引用；请在新方案版本中重新核对")
		}
	}
	m.Plan.InventoryAuditRevision++
	m.Plan.Complete = false
	m.Plan.PlansStarted = true
	if !cloudAgentContainsString(m.Plan.SelectedPlanKeys, "inventory") {
		m.Plan.SelectedPlanKeys = append(m.Plan.SelectedPlanKeys, "inventory")
	}
	if err := repo.UpdateProductionAgentManifest(current.UserID, current.ID, productionFlowJSON(m)); err != nil {
		return err
	}
	if err := repo.ValidateProductionAgentJob(current.UserID, current.ID, false); err != nil {
		return err
	}
	state.ActiveTaskID = ""
	for key, work := range state.ProductionParallel {
		if work.FlowUnitID != "" || key == "inventory" {
			delete(state.ProductionParallel, key)
			continue
		}
		// Rechecking identity must not discard a document's chosen model or
		// already saved chapter draft when its story dependency is unchanged.
		work.TaskID, work.Error, work.Attempts, work.ValidationAttempts, work.TransientAttempts, work.RetryAt = "", "", 0, 0, 0, 0
		work.QuietHold, work.Abandoned, work.RepairUsed, work.Notice = false, false, false, nil
		work.AutoRetryRounds, work.RepeatedValidationFailures = 0, 0
		work.ValidationSignature = ""
		work.ValidationIssues, work.ValidationProblems, work.ValidationProblemHistory = nil, nil, nil
		work.ValidationProblemCounts = nil
		state.ProductionParallel[key] = work
	}
	state.ProductionPaused = false
	state.ProductionFlowControl.RetrySpent, state.ProductionFlowControl.CooldownUntil = 0, 0
	state.ProductionFlowControl.RecoveryRounds = 0
	state.ProductionFlowControl.ManualRounds++
	state.LastError = ""
	state.ProductionFlowCoordinator.Generation++
	state.ProductionFlowCoordinator.Owner, state.ProductionFlowCoordinator.LeaseUntil = "", 0
	productionBlockRuntime(current, state)
	message := "重新核对资产总表：复用已保存的初次提取，重做声音补漏与身份归并；完成后整体替换登记，不重写总纲"
	if len(m.Plan.FlowStoryUnits) > 0 {
		message = "从已采用的核心登记与每集任务卡本地重新汇总资产总表，复用身份编码，不重复调用模型提取"
	}
	state.event(current.ID, "production_inventory_reconcile", map[string]any{"text": message, "auditRevision": m.Plan.InventoryAuditRevision})
	return cloudAgentSave(current, state)
}

func (s *Service) reconcileProductionFlowInventory(userID, runID string) error {
	for attempt := 0; attempt < 4; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			state, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			return productionFlowPrepareInventoryReconcile(repo, current, &state)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		if err != nil {
			return err
		}
		s.projectProductionAgentStatus(userID, runID)
		s.resumeCloudAgentPi(userID, runID)
		return nil
	}
	return repository.ErrCreationConflict
}
