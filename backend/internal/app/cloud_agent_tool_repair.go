package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/model"
)

const cloudAgentToolAttemptLimit = 3

type cloudAgentToolRepair struct {
	GroupID     string `json:"groupId"`
	Attempt     int    `json:"attempt"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

func cloudAgentRetryReceipt(groupID string, attempt int, status string) map[string]any {
	terminal := status == "exhausted"
	severity := "warning"
	if terminal {
		severity = "error"
	}
	return map[string]any{
		"groupId": groupID, "attempt": attempt, "maxAttempts": cloudAgentToolAttemptLimit,
		"status": status, "severity": severity, "terminal": terminal,
	}
}

// Count per tool, not per model step: intervening reads must not reset a failed
// write's allowance. Only explicitly typed, pre-execution errors are repairable.
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
		// Different documents or corrected fields are useful work, not retries of
		// one failed mutation. Stop only an identical invalid request at unchanged
		// progress; never accumulate all production validation errors into a cap.
		var arguments any
		if json.Unmarshal([]byte(call.Function.Arguments), &arguments) != nil {
			arguments = call.Function.Arguments
		}
		fingerprint := productionHash([]any{call.Function.Name, arguments, cloudAgentSafeToolError(err), state.ProductionProgressStep})
		if previous.Fingerprint != fingerprint {
			previous, exists = cloudAgentToolRepair{Fingerprint: fingerprint}, false
		}
	}
	if !exists {
		previous.GroupID = runID + ":repair:" + call.ID
	}
	previous.Attempt++
	state.ToolRepairs[call.Function.Name] = previous
	exhausted := previous.Attempt >= cloudAgentToolAttemptLimit
	status := "retrying"
	if exhausted {
		status = "exhausted"
	}
	retry := cloudAgentRetryReceipt(previous.GroupID, previous.Attempt, status)
	payload["retry"], detail["retry"] = retry, retry
	return exhausted
}

func cloudAgentRecordToolResult(run *model.CloudAgentExecution, state *cloudAgentRuntime, call cloudAgentCall, result any, err error) {
	if !cloudAgentToolResult(run.ID, state, call, result, err) {
		return
	}
	run.Status = "failed"
	run.FailureMessage = truncateRunes(fmt.Sprintf("自动纠正已尝试 %d 次，仍未完成：%s", cloudAgentToolAttemptLimit, cloudAgentSafeToolError(err)), 1000)
	if state.Request.Production != nil && strings.HasPrefix(call.Function.Name, "production_") {
		run.FailureMessage = truncateRunes("相同工具参数连续失败且进度未变化，已保存进度；请修正后继续："+cloudAgentSafeToolError(err), 1000)
	}
	cloudAgentDropInterjections(run.ID, "本轮已结束："+truncateRunes(run.FailureMessage, 120), state)
	state.event(run.ID, "run_failed", map[string]any{
		"text": run.FailureMessage, "reason": "tool_retry_exhausted", "toolName": call.Function.Name,
		"callId": call.ID, "attempts": cloudAgentToolAttemptLimit, "severity": "error", "terminal": true,
	})
}
