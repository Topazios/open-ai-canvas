package app

import (
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/model"
)

const cloudAgentToolAttemptLimit = 3

type cloudAgentToolRepair struct {
	GroupID                    string                      `json:"groupId"`
	Attempt                    int                         `json:"attempt"`
	Fingerprint                string                      `json:"fingerprint,omitempty"`
	CallID                     string                      `json:"callId,omitempty"`
	ProductionProgressStep     int                         `json:"productionProgressStep,omitempty"`
	ValidationIssues           []cloudAgentValidationIssue `json:"validationIssues,omitempty"`
	ValidationProblemSignature string                      `json:"validationProblemSignature,omitempty"`
	ValidationMessage          string                      `json:"validationMessage,omitempty"`
}

func cloudAgentRetryReceipt(groupID string, attempt int, status string) map[string]any {
	terminal := status == "exhausted"
	severity := "warning"
	return map[string]any{
		"groupId": groupID, "attempt": attempt, "maxAttempts": cloudAgentToolAttemptLimit,
		"status": status, "severity": severity, "terminal": terminal,
	}
}

// Production repair identity is the server-owned progress checkpoint, never
// model arguments or a caller-selected resource key. Only explicitly typed,
// pre-execution errors are repairable.
func cloudAgentTrackToolRepair(runID string, state *cloudAgentRuntime, call cloudAgentCall, result any, err error, payload map[string]any) bool {
	previous, exists := state.ToolRepairs[call.Function.Name]
	if err == nil {
		if exists {
			payload["retry"] = cloudAgentRetryReceipt(previous.GroupID, previous.Attempt, "recovered")
			delete(state.ToolRepairs, call.Function.Name)
		}
		return false
	}
	detail, _ := result.(map[string]any)
	var argumentErr *cloudAgentArgumentError
	if !errors.As(err, &argumentErr) || detail["taskSubmitted"] == true || detail["phase"] == "completion" {
		return false
	}
	if state.ToolRepairs == nil {
		state.ToolRepairs = map[string]cloudAgentToolRepair{}
	}
	if state.Request.Production != nil && strings.HasPrefix(call.Function.Name, "production_") {
		// The server-owned progress checkpoint defines the current production
		// item. Model-provided resource fields and tool names cannot reset the
		// recovery allowance for that checkpoint.
		fingerprint := productionHash([]any{"production_checkpoint", state.ProductionProgressStep})
		previousKey := call.Function.Name
		for toolName, candidate := range state.ToolRepairs {
			if toolName == productionRuntimeContinuationRepairKey || !strings.HasPrefix(toolName, "production_") || candidate.ProductionProgressStep != state.ProductionProgressStep {
				continue
			}
			if !exists || candidate.Attempt > previous.Attempt {
				previous, exists, previousKey = candidate, true, toolName
			}
		}
		if previous.Fingerprint != fingerprint {
			previous, exists, previousKey = cloudAgentToolRepair{Fingerprint: fingerprint}, false, call.Function.Name
		}
		if previousKey != call.Function.Name {
			delete(state.ToolRepairs, previousKey)
		}
		issues := cloudAgentValidationIssues(err)
		previous.ValidationIssues = make([]cloudAgentValidationIssue, 0, len(issues))
		for _, issue := range issues {
			previous.ValidationIssues = append(previous.ValidationIssues, cloudAgentSafeValidationIssue(issue))
		}
		previous.CallID = call.ID
		previous.ProductionProgressStep = state.ProductionProgressStep
		previous.ValidationMessage = cloudAgentSafeToolError(err)
		previous.ValidationProblemSignature = productionHash(productionValidationProblems(issues, previous.ValidationMessage))
	}
	if !exists {
		previous.GroupID = runID + ":repair:" + call.ID
	}
	if previous.Attempt < cloudAgentToolAttemptLimit {
		previous.Attempt++
	}
	state.ToolRepairs[call.Function.Name] = previous
	exhausted := previous.Attempt >= cloudAgentToolAttemptLimit
	status := "retrying"
	if exhausted {
		if state.Request.Production != nil && strings.HasPrefix(call.Function.Name, "production_") {
			status = "continuing"
		} else {
			status = "exhausted"
		}
	}
	retry := cloudAgentRetryReceipt(previous.GroupID, previous.Attempt, status)
	payload["retry"], detail["retry"] = retry, retry
	return exhausted
}

func cloudAgentRecordToolResult(run *model.CloudAgentExecution, state *cloudAgentRuntime, call cloudAgentCall, result any, err error) {
	if !cloudAgentToolResult(run.ID, state, call, result, err) {
		return
	}
	if state.Request.Production != nil && strings.HasPrefix(call.Function.Name, "production_") {
		// Local production validation is an internal current-step checkpoint. The
		// structured issue batch remains in ToolRepairs and the next model call
		// handles it before any downstream step can start.
		run.Status, run.FailureMessage, state.LastError = "running", "", ""
		return
	}
	run.Status = "failed"
	run.FailureMessage = truncateRunes(fmt.Sprintf("自动纠正已尝试 %d 次，仍未完成：%s", cloudAgentToolAttemptLimit, cloudAgentSafeToolError(err)), 1000)
	cloudAgentDropInterjections(run.ID, "本轮已结束："+truncateRunes(run.FailureMessage, 120), state)
	state.event(run.ID, "run_failed", map[string]any{
		"text": run.FailureMessage, "reason": "tool_retry_exhausted", "toolName": call.Function.Name,
		"callId": call.ID, "attempts": cloudAgentToolAttemptLimit, "severity": "warning", "errorSource": "application", "phase": "validation", "outcome": "needs_revision", "terminal": true,
	})
}
