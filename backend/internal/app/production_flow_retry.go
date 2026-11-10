package app

import (
	"errors"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func productionFlowResetHeld(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, key string) error {
	_, m, doc, err := productionLoad(repo, run, state)
	if err != nil {
		return err
	}
	artifacts, err := repo.ProductionAgentArtifacts(run.UserID, run.ID)
	if err != nil {
		return err
	}
	root := productionFlowRoot(m, doc, artifacts)
	if root == "" {
		return nil
	}
	graph, _, err := productionFlowBuildGraph(repo, run, state, m, doc, artifacts, root, true)
	if err != nil {
		return err
	}
	units := graph.Units
	matched := key == ""
	resumed := false
	for i := range units {
		u := &units[i]
		if key != "" && key != u.Key && key != u.Root && !strings.HasPrefix(u.Key, key+"/part/") {
			continue
		}
		if u.Status != "held" {
			continue
		}
		matched = true
		resumed = true
		if u.TaskID != "" {
			task, err := repo.TaskForUser(run.UserID, u.TaskID)
			if err != nil {
				return err
			}
			if !cloudAgentTaskTerminal(task.Status) || task.ProviderCancelStatus == model.ProviderCancelStatusRequested || task.ProviderCancelStatus == model.ProviderCancelStatusUncertain {
				return productionPlanConflict("原调用仍在执行或待核对，未重复提交收费请求")
			}
			// A stopped coordinator may have missed a successful receipt. Re-read
			// that response under the new ownership instead of paying to recreate it.
			if task.Status == model.TaskStatusSucceeded && strings.Contains(u.IssuesJSON, "coordinator_stopped") {
				oldTask, oldGeneration := u.TaskID, u.Generation
				u.Status = "running"
				if err := repo.SaveProductionFlowUnit(u, oldTask, oldGeneration); err != nil {
					return err
				}
				work := state.ProductionParallel[u.Key]
				work.TaskID, work.Generation, work.Error, work.QuietHold = u.TaskID, u.Generation, "", false
				state.ProductionParallel[u.Key] = work
				continue
			}
		}
		oldTask, oldGeneration := u.TaskID, u.Generation
		u.Status = "repair"
		if u.Attempts > productionFlowRepairLimit {
			productionFlowRestructure(u)
		}
		if u.SplitJSON != "" {
			u.Status = "split"
		}
		u.TaskID = ""
		// A manual decision opens one bounded repair round, not a fresh set of
		// blind retries for every field. Existing split plans are always reused.
		u.Attempts = min(u.Attempts, productionFlowRepairLimit)
		u.Generation++
		if err := repo.SaveProductionFlowUnit(u, oldTask, oldGeneration); err != nil {
			return err
		}
		delete(state.ProductionParallel, u.Key)
	}
	if !matched {
		return productionPlanConflict("此项已不属于当前有效任务范围，请刷新任务详情")
	}
	if resumed || key == "" {
		state.ProductionFlowControl.ManualRounds++
		state.ProductionFlowControl.RetrySpent = 0
		state.ProductionFlowControl.RecoveryRounds = 0
		state.ProductionFlowControl.Successes = 0
		state.ProductionFlowControl.ConsecutiveFailures = 0
		state.ProductionFlowControl.CooldownUntil = 0
		state.ProductionFlowControl.Window = max(1, state.ProductionFlowControl.Window)
	}
	return nil
}

func (s *Service) retryProductionFlow(userID, runID, key string) error {
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
			_, m, _, err := productionLoad(repo, current, &state)
			if err != nil {
				return err
			}
			if m.Plan == nil || m.Plan.FlowVersion != 1 || !strings.HasPrefix(key, "flow/") {
				return BadAuthRequest("当前不是分阶段制作工作单元")
			}
			units, err := repo.ProductionFlowUnits(userID, runID, "", "")
			if err != nil {
				return err
			}
			found := false
			for _, u := range units {
				if u.Key == key && u.Status == "held" {
					found = true
				}
			}
			if !found {
				return productionPlanConflict("此项没有待重试的失败单元，已完成内容不会重新生成")
			}
			if err := productionFlowResetHeld(repo, current, &state, key); err != nil {
				return err
			}
			state.ProductionPaused = false
			state.LastError, current.FailureMessage = "", ""
			state.ProductionFlowCoordinator.Generation++
			state.ProductionFlowCoordinator.Owner, state.ProductionFlowCoordinator.LeaseUntil = "", 0
			productionBlockRuntime(current, &state)
			state.event(runID, "production_flow_retry", map[string]any{"assetKey": key, "text": "手动重试当前未完成单元，沿用已保存内容与问题"})
			return cloudAgentSave(current, &state)
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
