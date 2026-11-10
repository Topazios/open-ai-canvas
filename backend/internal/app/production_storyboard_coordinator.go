package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type storyboardCoordinator struct {
	Generation int    `json:"generation"`
	Owner      string `json:"owner,omitempty"`
	LeaseUntil int64  `json:"leaseUntil,omitempty"`
	ProgressAt int64  `json:"progressAt,omitempty"`
	Checkpoint string `json:"checkpoint,omitempty"`
	Activity   string `json:"activity,omitempty"`
	Recoveries int    `json:"recoveries,omitempty"`
}

type storyboardCoordinatorKey struct{}
type storyboardSessionKey struct{}

type storyboardCoordinatorFailure struct {
	generation int
	cause      error
}

func (e storyboardCoordinatorFailure) Error() string { return e.cause.Error() }
func (e storyboardCoordinatorFailure) Unwrap() error { return e.cause }

type storyboardRecoveryExpectation struct {
	Generation   int
	TaskID       string
	ExpiredLease bool
}

func storyboardCoordinatorFence(ctx context.Context, state cloudAgentRuntime) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if generation, ok := ctx.Value(storyboardCoordinatorKey{}).(int); ok && generation > 0 {
		if state.StoryboardCoordinator.Generation != generation || state.StoryboardCoordinator.Owner == "" || state.StoryboardCoordinator.LeaseUntil < time.Now().UnixMilli() {
			return context.Canceled
		}
	}
	return nil
}

func (s *Service) checkStoryboardCoordinator(ctx context.Context, userID, runID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if ctx.Value(storyboardCoordinatorKey{}) == nil {
		return nil
	}
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return err
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		return err
	}
	return storyboardCoordinatorFence(ctx, state)
}

func (s *Service) claimStoryboardCoordinator(userID, runID string) (int, error) {
	for attempt := 0; attempt < 8; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return 0, err
		}
		state, err := cloudAgentDecode(run)
		if err != nil || state.Request.Production == nil {
			return 0, err
		}
		_, m, _, err := productionLoad(s.repo, run, &state)
		if err != nil {
			return 0, err
		}
		if m.Storyboard == nil || m.Storyboard.Version != storyboardSceneVersion {
			return 0, nil
		}
		if cloudAgentRunTerminal(run.Status) || run.Status == "waiting_user" {
			return 0, context.Canceled
		}
		c := state.StoryboardCoordinator
		if c.Owner != "" && c.LeaseUntil > time.Now().UnixMilli() {
			return 0, context.Canceled
		}
		c.Generation++
		c.Owner = s.workerID + ":" + newID()
		c.LeaseUntil = time.Now().Add(90 * time.Second).UnixMilli()
		c.ProgressAt = time.Now().UnixMilli()
		if c.Checkpoint == "" {
			c.Checkpoint = productionStoredValueHash(m.Storyboard)
		}
		state.StoryboardCoordinator = c
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
			state.event(runID, "production_coordinator_claimed", map[string]any{"generation": c.Generation, "text": "主任务从检查点接管，保留已完成场次和在途子任务"})
			return cloudAgentSave(current, &state)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		return c.Generation, err
	}
	return 0, repository.ErrCreationConflict
}

// The heartbeat checks actual progress as well as liveness. Queued/running
// model calls are governed by their own configured execution timeout.
func (s *Service) renewStoryboardCoordinator(ctx context.Context, userID, runID string) error {
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
			if err := storyboardCoordinatorFence(ctx, state); err != nil {
				return err
			}
			if cloudAgentRunTerminal(current.Status) {
				return context.Canceled
			}
			c := &state.StoryboardCoordinator
			progress := productionStoredValueHash([]any{state.ProductionProgressStep, state.ActiveTaskID, state.Step, state.StoryboardAssignments})
			if progress != c.Activity {
				c.Activity = progress
				c.ProgressAt = time.Now().UnixMilli()
			}
			_, m, _, err := productionLoad(repo, current, &state)
			if err != nil {
				return err
			}
			checkpoint := productionStoredValueHash(m.Storyboard)
			if checkpoint != c.Checkpoint {
				c.Checkpoint = checkpoint
				c.Recoveries = 0
				c.ProgressAt = time.Now().UnixMilli()
			}
			busy := state.ProductionPaused || current.Status == "waiting_approval" || current.Status == "waiting_user"
			ids := []string{state.ActiveTaskID}
			for _, work := range state.ProductionParallel {
				ids = append(ids, work.TaskID)
			}
			for _, id := range ids {
				if id != "" {
					task, err := optionalTaskForUser(repo, userID, id)
					if err != nil {
						return err
					}
					if task != nil && !cloudAgentTaskTerminal(task.Status) {
						busy = true
					}
				}
			}
			if !busy && time.Now().UnixMilli()-c.ProgressAt > int64((2*time.Minute)/time.Millisecond) {
				return fmt.Errorf("主任务超过两分钟未推进检查点")
			}
			c.LeaseUntil = time.Now().Add(90 * time.Second).UnixMilli()
			return cloudAgentSave(current, &state)
		})
		if !errors.Is(err, repository.ErrCreationConflict) {
			return err
		}
	}
	return repository.ErrCreationConflict
}

func (s *Service) releaseStoryboardCoordinator(userID, runID string, generation int) {
	if generation == 0 {
		return
	}
	for attempt := 0; attempt < 4; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
			state, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			if state.StoryboardCoordinator.Generation != generation {
				return nil
			}
			state.StoryboardCoordinator.Owner = ""
			state.StoryboardCoordinator.LeaseUntil = 0
			return cloudAgentSave(current, &state)
		})
		if !errors.Is(err, repository.ErrCreationConflict) {
			return
		}
	}
}

// Only the main execution is superseded. Healthy scene ownership is untouched.
func (s *Service) recoverStoryboardCoordinator(userID, runID, reason string, manual bool, expectations ...storyboardRecoveryExpectation) (bool, error) {
	if !manual {
		return s.holdStoryboardCoordinator(userID, runID, reason, "failed", expectations...)
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return false, err
	}
	for attempt := 0; attempt < 8; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return false, err
		}
		state, err := cloudAgentDecode(run)
		if err != nil || state.Request.Production == nil {
			return false, err
		}
		_, m, _, err := productionLoad(s.repo, run, &state, productionLoadForStoryboardRetry)
		if err != nil {
			return false, err
		}
		if m.Storyboard == nil || m.Storyboard.Version != storyboardSceneVersion {
			return false, nil
		}
		if len(expectations) > 0 {
			expected := expectations[0]
			if state.StoryboardCoordinator.Generation != expected.Generation || (expected.TaskID != "" && state.ActiveTaskID != expected.TaskID) || (expected.ExpiredLease && state.StoryboardCoordinator.LeaseUntil >= time.Now().UnixMilli()) {
				return true, nil
			}
		}
		if run.Status == "completed" {
			return true, BadAuthRequest("本集分镜已完成")
		}
		if run.CleanupPending {
			return true, BadAuthRequest("任务仍在清理，请稍后重试主任务")
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			job, latest, doc, err := productionLoad(repo, current, &state, productionLoadForStoryboardRetry)
			if err != nil {
				return err
			}
			// Reset all held assignments before starting any runtime. Completed
			// shots remain in the manifest; live children survive an explicit
			// restart of a still-running coordinator.
			for key, work := range state.ProductionParallel {
				if work.Error == "" && !work.QuietHold && !state.ProductionPaused && !cloudAgentRunTerminal(run.Status) {
					continue
				}
				revokeStoryboardTask(&state, work.TaskID)
				group, scene := storyboardWorkGroup(latest, key)
				if scene == nil || scene.Complete {
					delete(state.ProductionParallel, key)
					continue
				}
				assignment := state.StoryboardAssignments[key]
				assignment.Generation++
				assignment.TaskID, assignment.Status, assignment.Recoveries = "", "queued", 0
				if state.StoryboardAssignments == nil {
					state.StoryboardAssignments = map[string]storyboardAssignment{}
				}
				state.StoryboardAssignments[key] = assignment
				group.Dependencies, group.BatchLimit = storyboardSceneDependencies(latest, key), work.BatchLimit
				group.Correction, group.StoryboardDraft = work.Correction, work.StoryboardDraft
				state.ProductionParallel[key] = group
			}
			c := &state.StoryboardCoordinator
			c.Generation++
			c.Owner = ""
			c.LeaseUntil = 0
			c.Recoveries = 0
			state.ProductionPaused = false
			state.ToolRepairs = nil
			state.ProductionRepairs = 0
			revokeStoryboardTask(&state, state.ActiveTaskID)
			for key, id := range state.ProductionModelReceipts {
				if id == state.ActiveTaskID {
					delete(state.ProductionModelReceipts, key)
				}
			}
			state.ActiveTaskID = ""
			state.Calls = nil
			state.CallIndex = 0
			state.ActiveTextDraft = ""
			state.ProductionModelKey = ""
			state.LastError = ""
			state.PiResumePrompt = "从服务端场次任务表和已保存镜头继续。不要重派健康子任务或重写合格结果；只补全缺项，再完成整集审查。"
			current.Status, current.FailureMessage = "running", ""
			state.event(runID, "production_coordinator_recovered", map[string]any{"generation": c.Generation, "reason": reason, "text": "主任务执行代次已更新；保留任务表和有效镜头"})
			if err := saveStoryboardCheckpoint(repo, current, &state, job, &latest, doc, policy); err != nil {
				return err
			}
			return cloudAgentSave(current, &state)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		if err == nil {
			s.stopCloudAgentPi(runID)
			s.cleanupRevokedStoryboardTasks(userID, runID)
		}
		return true, err
	}
	return true, repository.ErrCreationConflict
}

// Stopping must work even when canvas/source validation is the failure cause.
// Fence every owner in one transaction before attempting upstream cancellation.
func (s *Service) holdStoryboardCoordinator(userID, runID, reason, status string, expectations ...storyboardRecoveryExpectation) (bool, error) {
	for attempt := 0; attempt < 8; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return false, err
		}
		state, err := cloudAgentDecode(run)
		if err != nil || state.Request.Production == nil {
			return false, err
		}
		job, err := s.repo.ProductionAgentJob(userID, runID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		var m productionManifest
		if err := json.Unmarshal([]byte(job.ManifestJSON), &m); err != nil {
			return false, err
		}
		if m.Storyboard == nil || m.Storyboard.Version != storyboardSceneVersion {
			return false, nil
		}
		if run.Status == "completed" || (state.ProductionPaused && (run.Status == "cancelled" || ((run.Status == "failed" || run.Status == "waiting_user") && status != "cancelled"))) {
			return true, nil
		}
		if len(expectations) > 0 {
			e := expectations[0]
			if state.StoryboardCoordinator.Generation != e.Generation || (e.TaskID != "" && state.ActiveTaskID != e.TaskID) || (e.ExpiredLease && state.StoryboardCoordinator.LeaseUntil >= time.Now().UnixMilli()) {
				return true, nil
			}
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
			state.StoryboardCoordinator.Generation++
			state.StoryboardCoordinator.Owner, state.StoryboardCoordinator.LeaseUntil = "", 0
			state.ProductionPaused, state.IsGenerating = true, false
			state.LastError = reason
			revokeStoryboardTask(&state, state.ActiveTaskID)
			for key, id := range state.ProductionModelReceipts {
				if id == state.ActiveTaskID {
					delete(state.ProductionModelReceipts, key)
				}
			}
			state.ActiveTaskID = ""
			for key, work := range state.ProductionParallel {
				revokeStoryboardTask(&state, work.TaskID)
				work.TaskID, work.Error, work.QuietHold = "", "主任务已停止，等待手动重试", true
				state.ProductionParallel[key] = work
				a := state.StoryboardAssignments[key]
				a.Generation++
				a.TaskID, a.Status = "", "paused"
				if state.StoryboardAssignments == nil {
					state.StoryboardAssignments = map[string]storyboardAssignment{}
				}
				state.StoryboardAssignments[key] = a
			}
			current.Status, current.FailureMessage = status, reason
			state.event(runID, "production_coordinator_stopped", map[string]any{"reason": reason, "text": "主任务和全部子任务已停止，保留已保存镜头，等待手动重试"})
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

// Main runtime events are small, fenced transactions. Snapshots from obsolete
// sessions must not replace the session used by the new coordinator.
func (s *Service) storyboardCoordinatorEvent(ctx context.Context, userID, runID string, payload map[string]json.RawMessage) (any, error) {
	for attempt := 0; attempt < 8; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return nil, err
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			state, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			if err := storyboardCoordinatorFence(ctx, state); err != nil {
				return err
			}
			var data map[string]any
			raw, _ := json.Marshal(payload)
			if err := json.Unmarshal(raw, &data); err != nil {
				return err
			}
			switch stringValue(data["type"]) {
			case "session_snapshot":
				text := stringValue(data["sessionJSONL"])
				if text == "" {
					return nil
				}
				revision := int64(0)
				if old, err := repo.CloudAgentPiSession(userID, runID); err == nil {
					revision = old.Revision
				} else if !errors.Is(err, gorm.ErrRecordNotFound) {
					return err
				}
				return repo.SaveCloudAgentPiSession(&model.CloudAgentPiSession{RunID: runID, UserID: userID, SessionJSONL: text, UpdatedAt: time.Now()}, revision)
			case "message_start":
				state.IsGenerating = true
			case "message_end":
				role := stringValue(data["role"])
				if message, ok := data["message"].(map[string]any); ok {
					role = stringValue(message["role"])
				}
				if role == "assistant" {
					state.IsGenerating = false
					state.PiAssistantResponses++
				}
			case "error":
				state.LastError = stringValue(data["error"])
				state.IsGenerating = false
			case "message_delta":
				state.event(runID, "message_delta", map[string]any{"delta": data["delta"], "messageId": data["messageId"]})
			}
			return cloudAgentSave(current, &state)
		})
		if !errors.Is(err, repository.ErrCreationConflict) {
			return map[string]any{"ok": err == nil}, err
		}
	}
	return nil, repository.ErrCreationConflict
}
