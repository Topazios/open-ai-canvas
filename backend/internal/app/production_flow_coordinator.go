package app

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const productionFlowLease = 90 * time.Second

// The coordinator lease is separate from content generations. Taking over the
// scheduler never discards successful content or duplicates in-flight calls.
func productionFlowFence(current, expected cloudAgentRuntime) error {
	c, e := current.ProductionFlowCoordinator, expected.ProductionFlowCoordinator
	if c.Generation != e.Generation || c.Owner != e.Owner || (c.Generation > 0 && (c.Owner == "" || c.LeaseUntil <= time.Now().UnixMilli())) {
		return context.Canceled
	}
	return nil
}

func (s *Service) claimProductionFlow(run *model.CloudAgentExecution, state *cloudAgentRuntime, owner string) (bool, error) {
	c := state.ProductionFlowCoordinator
	if c.Owner != "" && c.LeaseUntil <= time.Now().UnixMilli() {
		_, err := s.holdProductionFlow(run.UserID, run.ID, "主任务租约过期，保留检查点，等待手动继续", c.Generation)
		if err != nil {
			return false, err
		}
		return false, context.Canceled
	}
	if c.Owner != "" && c.Owner != owner && c.LeaseUntil > time.Now().UnixMilli() {
		return false, context.Canceled
	}
	if c.Owner == owner && c.LeaseUntil > time.Now().Add(60*time.Second).UnixMilli() {
		return false, nil
	}
	if c.Owner != owner {
		c.Generation++
	}
	checkpoint := productionStoredValueHash([]any{state.Step, state.ProductionProgressStep, state.ProductionParallel})
	if checkpoint != c.Checkpoint || c.ProgressAt == 0 {
		c.Checkpoint, c.ProgressAt = checkpoint, time.Now().UnixMilli()
	}
	if c.Owner == owner && len(state.ProductionParallel) == 0 {
		limits, err := s.cloudAgentStepLimits()
		if err != nil {
			return false, err
		}
		if limits.Timeout > 0 && time.Since(time.UnixMilli(c.ProgressAt)) > limits.Timeout {
			_, err := s.holdProductionFlow(run.UserID, run.ID, "本地调度超过配置时限没有有效进展，等待手动继续")
			if err != nil {
				return false, err
			}
			return false, context.Canceled
		}
	}
	c.Owner, c.LeaseUntil = owner, time.Now().Add(productionFlowLease).UnixMilli()
	err := s.repo.MutateCloudAgent(run.UserID, run.ID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state.ProductionFlowCoordinator = c
		return cloudAgentSave(current, state)
	})
	return true, err
}

func (s *Service) releaseProductionFlow(userID, runID, owner string) {
	for attempt := 0; attempt < 4; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return
		}
		state, err := cloudAgentDecode(run)
		if err != nil || state.ProductionFlowCoordinator.Owner != owner {
			return
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
			state, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			if state.ProductionFlowCoordinator.Owner != owner {
				return nil
			}
			state.ProductionFlowCoordinator.Owner, state.ProductionFlowCoordinator.LeaseUntil = "", 0
			return cloudAgentSave(current, &state)
		})
		if !errors.Is(err, repository.ErrCreationConflict) {
			return
		}
	}
}

// Stop and fence first; cancel provider calls afterwards. This also works when
// a deleted/edited canvas is the reason that publication failed.
func (s *Service) holdProductionFlow(userID, runID, reason string, expiredGeneration ...int) (bool, error) {
	for attempt := 0; attempt < 8; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return false, err
		}
		job, err := s.repo.ProductionAgentJob(userID, runID)
		if err != nil {
			return false, nil
		}
		var m productionManifest
		if json.Unmarshal([]byte(job.ManifestJSON), &m) != nil || m.Plan == nil || m.Plan.FlowVersion != 1 || m.Storyboard != nil {
			return false, nil
		}
		state, err := cloudAgentDecode(run)
		if err != nil {
			return true, err
		}
		if cloudAgentRunTerminal(run.Status) || state.ProductionPaused {
			return true, nil
		}
		if len(expiredGeneration) > 0 && (state.ProductionFlowCoordinator.Generation != expiredGeneration[0] || state.ProductionFlowCoordinator.LeaseUntil > time.Now().UnixMilli()) {
			return true, nil
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			units, err := repo.ProductionFlowUnits(userID, runID, "", "")
			if err != nil {
				return err
			}
			for i := range units {
				u := &units[i]
				if u.Status != "running" {
					continue
				}
				taskID, generation := u.TaskID, u.Generation
				revokeStoryboardTask(&state, taskID)
				u.Generation++
				u.Status = "held"
				u.IssuesJSON = productionFlowJSON([]productionFlowIssue{productionFlowIssueAt("execution", "coordinator_stopped", u.Key, reason)})
				if err := repo.SaveProductionFlowUnit(u, taskID, generation); err != nil {
					return err
				}
				if work, exists := state.ProductionParallel[u.Key]; exists {
					work.Generation, work.QuietHold, work.Error = u.Generation, true, "主任务已停止，保留结果，等待手动继续"
					state.ProductionParallel[u.Key] = work
				}
			}
			for key, work := range state.ProductionParallel {
				if work.FlowUnitID != "" {
					continue
				}
				revokeStoryboardTask(&state, work.TaskID)
				work.QuietHold, work.Error = true, "主任务已暂停，等待手动继续"
				state.ProductionParallel[key] = work
			}
			revokeStoryboardTask(&state, state.ActiveTaskID)
			for key, id := range state.ProductionModelReceipts {
				if id == state.ActiveTaskID {
					delete(state.ProductionModelReceipts, key)
				}
			}
			state.ActiveTaskID = ""
			state.ProductionFlowCoordinator.Generation++
			state.ProductionFlowCoordinator.Owner, state.ProductionFlowCoordinator.LeaseUntil = "", 0
			state.ProductionPaused, state.IsGenerating = true, false
			state.LastError = reason
			current.Status, current.FailureMessage = "waiting_user", reason
			state.event(runID, "production_flow_stopped", map[string]any{"text": reason, "errorSource": "application", "action": "resume", "generation": state.ProductionFlowCoordinator.Generation})
			return cloudAgentSave(current, &state)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		if err == nil {
			s.stopCloudAgentPi(runID)
			s.cleanupRevokedStoryboardTasks(userID, runID)
			s.projectProductionAgentStatus(userID, runID)
		}
		return true, err
	}
	return true, repository.ErrCreationConflict
}
