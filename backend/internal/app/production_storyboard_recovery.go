package app

import (
	"context"
	"errors"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const storyboardRecoveryLimit = 3
const storyboardReapInterval = time.Minute
const storyboardCancelGrace = 30 * time.Second

func revokeStoryboardTask(state *cloudAgentRuntime, taskID string) {
	if taskID == "" {
		return
	}
	if state.RevokedProductionTasks == nil {
		state.RevokedProductionTasks = map[string]int64{}
	}
	state.RevokedProductionTasks[taskID] = time.Now().UnixMilli()
}

// Revocation and removal of ownership commit before attempting external cancel.
// A failed provider cancellation cannot keep the logical assignment locked.
func (s *Service) retryStoryboardScene(userID, runID, key string, automatic bool, expectedTask string) error {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	for attempt := 0; attempt < 8; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			state, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			job, m, doc, err := productionLoad(repo, current, &state)
			if err != nil {
				return err
			}
			if m.Storyboard == nil || m.Storyboard.Version != storyboardSceneVersion {
				return BadAuthRequest("当前任务不是场次并发分镜")
			}
			if state.ProductionPaused || current.Status == "waiting_user" || cloudAgentRunTerminal(current.Status) {
				return BadAuthRequest("整集任务已停止，请先重试主任务")
			}
			group, scene := storyboardWorkGroup(m, key)
			if scene == nil {
				return BadAuthRequest("场次不存在")
			}
			if scene.Complete {
				return nil
			}
			old := state.ProductionParallel[key]
			if automatic && (old.TaskID == "" || old.TaskID != expectedTask) {
				return nil
			}
			if automatic && cloudAgentRunTerminal(current.Status) {
				return nil
			}
			revokeStoryboardTask(&state, old.TaskID)
			a := state.StoryboardAssignments[key]
			if state.StoryboardAssignments == nil {
				state.StoryboardAssignments = map[string]storyboardAssignment{}
			}
			a.Generation++
			a.TaskID, a.Status = "", "queued"
			if automatic {
				a.Recoveries++
			} else {
				a.Recoveries = 0
			}
			state.StoryboardAssignments[key] = a
			if state.ProductionParallel == nil {
				state.ProductionParallel = map[string]productionParallelWork{}
			}
			next := group
			next.Dependencies, next.BatchLimit = storyboardSceneDependencies(m, key), old.BatchLimit
			next.Correction, next.StoryboardDraft = old.Correction, old.StoryboardDraft
			if automatic && a.Recoveries > storyboardRecoveryLimit {
				next.Error, next.QuietHold = "本场自动恢复已达上限，可手动重派", true
			}
			state.ProductionParallel[key] = next
			if !automatic {
				state.ProductionPaused, state.LastError = false, ""
				if current.Status == "failed" || current.Status == "waiting_user" {
					current.Status, current.FailureMessage = "running", ""
				}
			}
			state.event(runID, "production_scene_revoked", map[string]any{"assignment": a, "taskId": old.TaskID, "text": "旧任务分配已废弃，保留已保存镜头，从当前检查点重新领取"})
			if err := saveStoryboardCheckpoint(repo, current, &state, job, &m, doc, policy); err != nil {
				return err
			}
			return cloudAgentSave(current, &state)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		if err == nil {
			s.cleanupRevokedStoryboardTasks(userID, runID)
			s.startCloudAgentPi(userID, runID)
		}
		return err
	}
	return repository.ErrCreationConflict
}

func (s *Service) cleanupRevokedStoryboardTasks(userID, runID string) {
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		return
	}
	for id := range state.RevokedProductionTasks {
		task, err := optionalTaskForUser(s.repo, userID, id)
		if err != nil {
			continue
		}
		if task != nil && !cloudAgentTaskTerminal(task.Status) {
			ctx, cancel := context.WithTimeout(context.Background(), storyboardCancelGrace)
			_, err = s.taskLifecycle().cancelTaskWithIntent(ctx, userID, id, model.TaskCancellationIntent{Source: model.TaskCancellationParentCancelled, ActorID: userID})
			cancel()
			if err != nil {
				continue
			}
		}
		// Internal cancellation aborts the owned worker; receipts/billing remain.
		for retry := 0; retry < 4; retry++ {
			latest, err := s.repo.CloudAgent(userID, runID)
			if err != nil {
				break
			}
			err = s.repo.MutateCloudAgent(userID, runID, latest.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
				fresh, err := cloudAgentDecode(current)
				if err != nil {
					return err
				}
				delete(fresh.RevokedProductionTasks, id)
				return cloudAgentSave(current, &fresh)
			})
			if !errors.Is(err, repository.ErrCreationConflict) {
				break
			}
		}
	}
}

func (s *Service) reapStoryboardRun(run model.CloudAgentExecution) {
	s.cleanupRevokedStoryboardTasks(run.UserID, run.ID)
	state, err := cloudAgentDecode(&run)
	if err != nil || state.Request.Production == nil {
		return
	}
	if state.ProductionPaused || cloudAgentRunTerminal(run.Status) || run.Status == "waiting_user" {
		return
	}
	if c := state.ProductionFlowCoordinator; c.Owner != "" && c.LeaseUntil < time.Now().UnixMilli() {
		_, _ = s.holdProductionFlow(run.UserID, run.ID, "主任务租约过期，成果保留，等待手动继续", c.Generation)
		return
	}
	if state.StoryboardCoordinator.Owner != "" && state.StoryboardCoordinator.LeaseUntil < time.Now().UnixMilli() {
		_, _ = s.recoverStoryboardCoordinator(run.UserID, run.ID, "主任务租约过期", false, storyboardRecoveryExpectation{Generation: state.StoryboardCoordinator.Generation, ExpiredLease: true})
		return
	}
	limits, err := s.cloudAgentStepLimits()
	if err != nil {
		return
	}
	if state.StoryboardCoordinator.Generation > 0 && state.ActiveTaskID != "" {
		task, err := optionalTaskForUser(s.repo, run.UserID, state.ActiveTaskID)
		if err == nil && (task == nil || (task.Status == model.TaskStatusRunning && limits.Timeout > 0 && task.StartedAt != nil && time.Since(*task.StartedAt) > limits.Timeout+storyboardCancelGrace)) {
			_, _ = s.recoverStoryboardCoordinator(run.UserID, run.ID, "主模型调用超过执行期限", false, storyboardRecoveryExpectation{Generation: state.StoryboardCoordinator.Generation, TaskID: state.ActiveTaskID})
			return
		}
	}
	for key, work := range state.ProductionParallel {
		if (work.SceneID == "" && work.FlowUnitID == "") || work.TaskID == "" || work.QuietHold {
			continue
		}
		task, err := optionalTaskForUser(s.repo, run.UserID, work.TaskID)
		if err != nil {
			continue
		}
		// Queue time is not execution time; a healthy queued task must not be
		// replaced just because another user currently owns the model slot.
		expired := task == nil || (task.Status == model.TaskStatusRunning && limits.Timeout > 0 && task.StartedAt != nil && time.Since(*task.StartedAt) > limits.Timeout+storyboardCancelGrace)
		if expired {
			if work.FlowUnitID != "" {
				_, _ = s.holdProductionFlow(run.UserID, run.ID, "工作单元超过配置的执行期限，已停止调度，等待手动继续")
				return
			}
			_ = s.retryStoryboardScene(run.UserID, run.ID, key, true, work.TaskID)
		}
	}
}

func (s *Service) startStoryboardReaper() {
	s.runWorkerLoop(func(ctx context.Context) {
		ticker := time.NewTicker(storyboardReapInterval)
		defer ticker.Stop()
		for {
			revokedCursor := ""
			for ctx.Err() == nil {
				runs, err := s.repo.CloudAgentsWithRevokedTasksAfter(revokedCursor, 50)
				if err != nil {
					break
				}
				for _, run := range runs {
					revokedCursor = run.ID
					s.cleanupRevokedStoryboardTasks(run.UserID, run.ID)
				}
				if len(runs) < 50 {
					break
				}
			}
			cursor := ""
			for ctx.Err() == nil {
				runs, err := s.repo.ActiveCloudAgentsAfter(cursor, 50)
				if err != nil {
					break
				}
				for _, run := range runs {
					cursor = run.ID
					s.reapStoryboardRun(run)
				}
				if len(runs) < 50 {
					break
				}
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
}
