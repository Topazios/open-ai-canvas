package app

import (
	"errors"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const cloudAgentMaxOutputLimitEscalations = 1

func cloudAgentOutputLimitReached(task *model.Task) bool {
	if task == nil || task.Status != model.TaskStatusFailed {
		return false
	}
	if diagnostic := taskExecutionDiagnostic(task); diagnostic != nil && diagnostic.Code == providerOutputLimitCode {
		return true
	}
	return strings.Contains(task.Error, errProviderOutputLimit.Error()) ||
		strings.Contains(strings.ToLower(task.Error), "responses 输出达到 token 上限")
}

func (s *Service) correctCloudAgentOutputLimit(run *model.CloudAgentExecution, state *cloudAgentRuntime) error {
	return s.repo.MutateCloudAgent(run.UserID, run.ID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		failedTaskID := state.ActiveTaskID
		if state.Request.Production != nil {
			task, err := repo.TaskForUser(run.UserID, failedTaskID)
			if err != nil {
				return err
			}
			state.event(run.ID, "production_model_completed", productionModelCompletedPayload(task, state.Step, cloudAgentSafeMediaTaskError(task)))
		}
		// Failed receipts must not be replayed as the result of the recovery.
		for key, id := range state.ProductionModelReceipts {
			if id == failedTaskID {
				delete(state.ProductionModelReceipts, key)
			}
		}
		state.OutputLimitEscalated++
		state.ForceThinkingOff = true
		state.BoostStepOutputBudget = false
		state.ActiveTaskID = ""
		state.ActiveTextDraft = ""
		state.Calls = nil
		state.CallIndex = 0
		state.event(run.ID, "model_failure_recovered", map[string]any{
			"reason": "output_limit_retried", "taskId": failedTaskID,
			"text": "模型输出触及上限；已关闭思考并按原输出预算重试当前步骤一次",
		})
		return cloudAgentSave(current, state)
	})
}

// Pi events also advance the revision; reload after conflicts instead of
// losing the recovery or releasing a different active step.
func (s *Service) recoverCloudAgentOutputLimit(userID, runID, taskID string) (bool, error) {
	for attempt := 0; attempt < 8; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return false, err
		}
		state, err := cloudAgentDecode(run)
		if err != nil {
			return false, err
		}
		if cloudAgentRunTerminal(run.Status) || state.ActiveTaskID != taskID {
			return false, nil
		}
		if state.OutputLimitEscalated >= cloudAgentMaxOutputLimitEscalations {
			var recovered bool
			recovered, err = s.recoverProductionDocumentParts(run, &state)
			if err == nil {
				return recovered, nil
			}
		} else {
			err = s.correctCloudAgentOutputLimit(run, &state)
		}
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		return err == nil, err
	}
	return false, repository.ErrCreationConflict
}

// Serial story/generation steps join the same durable section scheduler after
// their ordinary reasoning-off recovery. Discovery/inventory operations keep
// their existing bounded failure behavior; they are not document submissions.
func (s *Service) recoverProductionDocumentParts(run *model.CloudAgentExecution, state *cloudAgentRuntime) (bool, error) {
	if state.Request.Production == nil {
		return false, nil
	}
	_, m, doc, err := productionLoad(s.repo, run, state)
	if err != nil || m.Plan == nil || m.Plan.Version < 2 {
		return false, err
	}
	artifacts, err := s.repo.ProductionAgentArtifacts(run.UserID, run.ID)
	if err != nil {
		return false, err
	}
	next := productionPlanNextAction(m, doc, artifacts)
	key := stringValue(next["key"])
	if next["tool"] != "production_submit" || key == "" || stringValue(next["blockedReason"]) != "" {
		return false, nil
	}
	work := productionParallelWork{Key: key, Name: stringValue(next["name"]), Dependencies: productionParallelDependencyHash(m, artifacts, key), DisableThinking: true}
	if _, exists := state.ProductionParallel[key]; exists {
		return false, nil
	}
	if err := productionSplitDocumentParts(m, doc, artifacts, &work); err != nil {
		return false, err
	}
	err = s.repo.MutateCloudAgent(run.UserID, run.ID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		task, err := repo.TaskForUser(run.UserID, state.ActiveTaskID)
		if err != nil {
			return err
		}
		state.event(run.ID, "production_model_completed", productionModelCompletedPayload(task, state.Step, cloudAgentSafeMediaTaskError(task)))
		for key, id := range state.ProductionModelReceipts {
			if id == state.ActiveTaskID {
				delete(state.ProductionModelReceipts, key)
			}
		}
		state.event(run.ID, "model_failure_recovered", map[string]any{"reason": "production_document_output_limit", "taskId": state.ActiveTaskID, "text": work.Name + "：完整输出超限，改为按章节继续，全部完成后合并校验"})
		if state.ProductionParallel == nil {
			state.ProductionParallel = map[string]productionParallelWork{}
		}
		state.ProductionParallel[key] = work
		state.ActiveTaskID, state.ActiveTextDraft = "", ""
		state.Calls, state.CallIndex = nil, 0
		return cloudAgentSave(current, state)
	})
	return err == nil, err
}
