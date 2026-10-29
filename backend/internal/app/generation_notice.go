package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Delivery requirements and local processing are independent of a provider
// failure. Terminal scheduler states remain intact so incomplete work cannot
// release dependents or be adopted as a finished result.
func generationDiagnosticNotice(diagnostic *model.TaskExecutionDiagnostic) {
	if diagnostic == nil {
		return
	}
	if diagnostic.ErrorSource == "upstream" || diagnostic.ErrorSource == "network" {
		return
	}
	diagnostic.Severity, diagnostic.ErrorSource, diagnostic.Outcome = "", "", ""
}

func generationNoticePayload(payload map[string]any, diagnostic *model.TaskExecutionDiagnostic) {
	if diagnostic == nil || diagnostic.Severity == "" {
		return
	}
	payload["severity"], payload["errorSource"], payload["outcome"] = diagnostic.Severity, diagnostic.ErrorSource, diagnostic.Outcome
	payload["phase"], payload["code"] = diagnostic.Phase, diagnostic.Code
}

func generationTaskNotice(payload map[string]any, task *model.Task) {
	if task == nil || task.Status == model.TaskStatusSucceeded || task.Status == model.TaskStatusCancelled {
		return
	}
	generationNoticePayload(payload, taskExecutionDiagnostic(task))
}

func generationLocalNotice(payload map[string]any, phase, outcome string) {
	delete(payload, "severity")
	delete(payload, "errorSource")
	delete(payload, "outcome")
	payload["phase"] = phase
}

func generationStopNotice(repo *repository.Repository, state *cloudAgentRuntime, payload map[string]any) {
	if state.ActiveTaskID != "" {
		if task, err := repo.Task(state.ActiveTaskID); err == nil {
			diagnostic := taskExecutionDiagnostic(task)
			if diagnostic != nil && (diagnostic.ErrorSource == "upstream" || diagnostic.ErrorSource == "network") {
				generationNoticePayload(payload, diagnostic)
				return
			}
		}
	}
	var notice *model.TaskExecutionDiagnostic
	for _, work := range state.ProductionParallel {
		if work.Error == "" || work.Notice == nil {
			continue
		}
		if work.Notice.ErrorSource == "upstream" || work.Notice.ErrorSource == "network" {
			notice = work.Notice
			break
		}
	}
	generationNoticePayload(payload, notice)
}

func generationRunWarning(repo *repository.Repository, state *cloudAgentRuntime, runID string) map[string]any {
	if state == nil {
		return nil
	}
	for index := len(state.Events) - 1; index >= 0; index-- {
		event := state.Events[index]
		if event.RunID != runID {
			continue
		}
		if event.Type == "run_completed" || event.Type == "run_cancelled" {
			return nil
		}
		if event.Type == "production_control" && event.Payload["action"] == "needs_revision" {
			warning := map[string]any{}
			for key, value := range event.Payload {
				warning[key] = value
			}
			warning["severity"], warning["errorSource"], warning["outcome"] = "warning", "application", "needs_revision"
			if warning["message"] == nil {
				warning["message"] = warning["text"]
			}
			return warning
		}
		if event.Type == "run_failed" && event.Payload["severity"] == "warning" {
			warning := map[string]any{}
			for key, value := range event.Payload {
				warning[key] = value
			}
			if warning["message"] == nil {
				warning["message"] = warning["text"]
			}
			return warning
		}
		if event.Type == "run_failed" {
			if event.Payload["reason"] == "production_no_progress" {
				return map[string]any{"severity": "warning", "errorSource": "application", "outcome": "needs_revision", "message": event.Payload["error"]}
			}
			return nil
		}
	}
	for _, work := range state.ProductionParallel {
		if work.Notice != nil && work.Notice.Severity == "warning" {
			return map[string]any{
				"severity": work.Notice.Severity, "errorSource": work.Notice.ErrorSource,
				"outcome": work.Notice.Outcome, "phase": work.Notice.Phase,
				"code": work.Notice.Code, "message": work.Notice.SafeMessage,
			}
		}
	}
	// Older checkpoints used a local scheduler stop without a structured
	// diagnostic. Keep that historical state visible as a warning on read.
	for index := len(state.Events) - 1; index >= 0; index-- {
		event := state.Events[index]
		if event.RunID == runID && event.Type == "run_failed" && event.Payload["reason"] == "production_no_progress" {
			return map[string]any{"severity": "warning", "errorSource": "application", "outcome": "needs_revision", "message": event.Payload["error"]}
		}
	}
	_ = repo
	return nil
}

func generationRunExternalFailure(repo *repository.Repository, state *cloudAgentRuntime, runID string) bool {
	for index := len(state.Events) - 1; index >= 0; index-- {
		event := state.Events[index]
		if event.RunID != runID || event.Type != "run_failed" {
			continue
		}
		if event.Payload["errorSource"] == "upstream" || event.Payload["errorSource"] == "network" {
			return true
		}
		if taskID := stringValue(event.Payload["taskId"]); taskID != "" {
			if task, err := repo.Task(taskID); err == nil {
				diagnostic := taskExecutionDiagnostic(task)
				return diagnostic != nil && (diagnostic.ErrorSource == "upstream" || diagnostic.ErrorSource == "network")
			}
		}
		return false
	}
	for _, work := range state.ProductionParallel {
		if work.Error != "" && work.Notice != nil && (work.Notice.ErrorSource == "upstream" || work.Notice.ErrorSource == "network") {
			return true
		}
	}
	return false
}

// Legacy local scheduler stops are internal checkpoints, not user-facing
// content warnings. Keep this helper for read compatibility without reviving
// the old warning projection.
func generationHistoricalRuntimeNotice(event CloudAgentEvent) map[string]any {
	if event.Type == "run_failed" && event.Payload["reason"] == "production_no_progress" && event.Payload["severity"] == nil {
		return map[string]any{"severity": "warning", "errorSource": "application", "outcome": "needs_revision", "message": event.Payload["error"]}
	}
	return map[string]any{}
}

func generationToolNotice(payload map[string]any, class string) {
	if class == cloudAgentToolErrorUpstream {
		return
	}
	delete(payload, "severity")
	delete(payload, "errorSource")
	delete(payload, "outcome")
}

// Read projection for older event pages: match the owner, run and task receipt,
// and clone payloads so neither persisted events nor scheduler checkpoints change.
func (s *Service) decorateGenerationEventNotices(userID, runID string, events []CloudAgentEvent) {
	ids := []string{}
	for _, event := range events {
		if event.RunID == runID && (event.Type == "production_model_completed" || event.Type == "run_failed") && event.Payload["severity"] == nil {
			if id := stringValue(event.Payload["taskId"]); id != "" {
				ids = append(ids, id)
			}
		}
	}
	tasks, err := s.repo.GenerationNoticeTasks(userID, runID, ids)
	if err != nil {
		return
	}
	byID := map[string]*model.Task{}
	for index := range tasks {
		byID[tasks[index].ID] = &tasks[index]
	}
	for index, event := range events {
		if event.RunID != runID || event.Payload["severity"] != nil || (event.Type != "production_model_completed" && event.Type != "run_failed") {
			continue
		}
		if event.Payload["errorSource"] == "upstream" || event.Payload["errorSource"] == "network" {
			continue
		}
		notice := generationHistoricalRuntimeNotice(event)
		if len(notice) == 0 {
			task := byID[stringValue(event.Payload["taskId"])]
			if task == nil || task.Status != model.TaskStatusFailed {
				continue
			}
			generationTaskNotice(notice, task)
			if len(notice) == 0 && cloudAgentOutputLimitReached(task) {
				generationNoticePayload(notice, &model.TaskExecutionDiagnostic{Severity: "warning", ErrorSource: "content", Outcome: "incomplete", Phase: "content", Code: providerOutputLimitCode})
			}
		}
		if len(notice) == 0 {
			continue
		}
		if notice["errorSource"] != "upstream" && notice["errorSource"] != "network" && !(event.Payload["reason"] == "production_no_progress" && notice["severity"] == "warning") {
			continue
		}
		payload := make(map[string]any, len(event.Payload)+len(notice))
		for key, value := range event.Payload {
			payload[key] = value
		}
		for key, value := range notice {
			payload[key] = value
		}
		events[index].Payload = payload
	}
}
