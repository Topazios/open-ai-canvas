package app

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
)

func taskHasAgentOrigin(raw string) bool {
	var input struct {
		Metadata struct {
			Source string `json:"source"`
		} `json:"metadata"`
	}
	return json.Unmarshal([]byte(raw), &input) == nil && input.Metadata.Source == "cloud_agent"
}

func safeTaskDiagnosticMessage(message string) string {
	message = strings.TrimSpace(message)
	if message == "" || !utf8.ValidString(message) || strings.ContainsAny(message, "\r\n\x00") {
		return "任务未完成，请在任务中心查看诊断"
	}
	lower := strings.ToLower(message)
	for _, marker := range []string{"http://", "https://", "file://", "ftp://", "authorization", "cookie", "secret", "token", "api_key", "apikey", "x-api-key", "/var/", "/tmp/", "\\", "stack trace", "traceback", "sql:", "sqlite", "postgres"} {
		if strings.Contains(lower, marker) {
			return "任务未完成，请在任务中心查看诊断"
		}
	}
	return truncateRunes(message, 240)
}

func recordTaskDiagnostic(task *model.Task, phase, code, outcome, retryClass string, cause error) {
	var appErr *AppError
	if errors.As(cause, &appErr) && appErr.Reason != "" {
		code = string(appErr.Reason)
	}
	if errors.Is(cause, errProviderOutputLimit) {
		code = providerOutputLimitCode
	}
	var decodeErr providerResponseDecodeError
	if errors.As(cause, &decodeErr) {
		code = "upstream_response_invalid"
	}
	diagnostic := &model.TaskExecutionDiagnostic{
		Code: code, Phase: phase, TaskSubmitted: outcome == "accepted" || outcome == "submitted", SubmissionOutcome: outcome,
		RetryClass: retryClass, SafeMessage: safeTaskDiagnosticMessage(task.Error), DiagnosticID: task.ID,
	}
	var httpErr providerHTTPError
	var payloadErr providerPayloadError
	var networkErr *net.OpError
	var requestTimeoutErr providerRequestTimeoutError
	if phase == "execution" {
		switch {
		case errors.As(cause, &requestTimeoutErr):
			diagnostic.Code, _ = providerRequestErrorDetails(cause)
			diagnostic.Severity, diagnostic.ErrorSource, diagnostic.Outcome = "warning", "application", "needs_attention"
		case errors.As(cause, &httpErr) && model.IsGatewayTimeout(httpErr.StatusCode):
			diagnostic.Code = model.GatewayResponseUnconfirmed
			diagnostic.SafeMessage = model.GatewayTimeoutMessage(httpErr.StatusCode)
			diagnostic.Severity, diagnostic.ErrorSource, diagnostic.Outcome = "warning", "gateway", "needs_attention"
		case errors.As(cause, &httpErr), errors.As(cause, &payloadErr):
			diagnostic.Severity, diagnostic.ErrorSource = "error", "upstream"
		case errors.Is(cause, context.DeadlineExceeded), errors.Is(cause, context.Canceled):
			diagnostic.Code, _ = providerRequestErrorDetails(cause)
			diagnostic.Severity, diagnostic.ErrorSource, diagnostic.Outcome = "warning", "application", "needs_attention"
		case errors.As(cause, &decodeErr):
			diagnostic.Severity, diagnostic.ErrorSource, diagnostic.Outcome = "warning", "application", "needs_attention"
			diagnostic.SafeMessage = "本应用无法解析返回结果，生成状态待核对；请检查响应格式与解析代码，不要直接重新生成"
		case errors.As(cause, &networkErr):
			diagnostic.Severity, diagnostic.ErrorSource = "error", "network"
		case appErr != nil && appErr.Reason == ReasonUpstreamDNSFailed:
			diagnostic.Severity, diagnostic.ErrorSource = "error", "network"
		case appErr != nil:
			diagnostic.Severity, diagnostic.ErrorSource, diagnostic.Outcome = "warning", "application", "needs_attention"
		}
	}
	if phase == "postprocess" || phase == "result_persistence" {
		diagnostic.Severity, diagnostic.ErrorSource, diagnostic.Outcome = "warning", "application", "needs_attention"
	}
	generationDiagnosticNotice(diagnostic)
	raw, _ := json.Marshal(diagnostic)
	task.ExecutionDiagnosticJSON, task.Diagnostic = string(raw), diagnostic
}

func recordTaskWritebackDiagnostic(task *model.Task, nodeID, outcome, reason string, cause error) {
	if task == nil {
		return
	}
	diagnostic := taskExecutionDiagnostic(task)
	if diagnostic == nil {
		diagnostic = &model.TaskExecutionDiagnostic{
			Code:              "task_terminal",
			Phase:             "completion",
			TaskSubmitted:     true,
			SubmissionOutcome: cloudAgentTaskSubmissionOutcome(task),
			RetryClass:        "none",
			DiagnosticID:      task.ID,
		}
		if task.Status == model.TaskStatusFailed || task.Status == model.TaskStatusCancelled {
			diagnostic.SafeMessage = cloudAgentSafeMediaTaskError(task)
		}
	}
	diagnostic.WritebackOutcome = outcome
	diagnostic.WritebackReason = strings.TrimSpace(reason)
	diagnostic.WritebackNodeID = strings.TrimSpace(nodeID)
	diagnostic.WritebackMessage = ""
	if cause != nil {
		diagnostic.WritebackMessage = safeTaskDiagnosticMessage(cloudAgentSafeToolError(cause))
	}
	raw, _ := json.Marshal(diagnostic)
	task.ExecutionDiagnosticJSON, task.Diagnostic = string(raw), diagnostic
}

// taskExecutionDiagnostic exposes stored execution facts; it never derives a
// failure category from a node's presentation state or the model's explanation.
func taskExecutionDiagnostic(task *model.Task) *model.TaskExecutionDiagnostic {
	if task == nil || task.ExecutionDiagnosticJSON == "" {
		return nil
	}
	var diagnostic model.TaskExecutionDiagnostic
	if json.Unmarshal([]byte(task.ExecutionDiagnosticJSON), &diagnostic) != nil {
		return nil
	}
	generationDiagnosticNotice(&diagnostic)
	// Execution success and writeback failure are separate facts. A successful
	// task has no execution error; writeback errors remain in WritebackMessage.
	if task.Status == model.TaskStatusSucceeded {
		diagnostic.SafeMessage = ""
	} else if diagnostic.SafeMessage != "" || task.Status == model.TaskStatusFailed || task.Status == model.TaskStatusCancelled {
		diagnostic.SafeMessage = safeTaskDiagnosticMessage(diagnostic.SafeMessage)
	}
	return &diagnostic
}

func taskExecutionDiagnosticFromError(cause error) *model.TaskExecutionDiagnostic {
	if cause == nil {
		return nil
	}
	var httpErr providerHTTPError
	var payloadErr providerPayloadError
	var networkErr *net.OpError
	var requestTimeoutErr providerRequestTimeoutError
	var decodeErr providerResponseDecodeError
	switch {
	case errors.As(cause, &requestTimeoutErr):
		code, message := providerRequestErrorDetails(cause)
		return &model.TaskExecutionDiagnostic{Code: code, SafeMessage: message, Severity: "warning", ErrorSource: "application", Phase: "execution", Outcome: "needs_attention"}
	case errors.As(cause, &httpErr) && model.IsGatewayTimeout(httpErr.StatusCode):
		return &model.TaskExecutionDiagnostic{Code: model.GatewayResponseUnconfirmed, SafeMessage: model.GatewayTimeoutMessage(httpErr.StatusCode), Severity: "warning", ErrorSource: "gateway", Phase: "execution", Outcome: "needs_attention"}
	case errors.As(cause, &httpErr), errors.As(cause, &payloadErr):
		return &model.TaskExecutionDiagnostic{Severity: "error", ErrorSource: "upstream", Phase: "execution"}
	case errors.Is(cause, context.DeadlineExceeded), errors.Is(cause, context.Canceled), errors.As(cause, &decodeErr):
		code, message := providerRequestErrorDetails(cause)
		return &model.TaskExecutionDiagnostic{Code: code, SafeMessage: message, Severity: "warning", ErrorSource: "application", Phase: "execution", Outcome: "needs_attention"}
	case errors.As(cause, &networkErr):
		return &model.TaskExecutionDiagnostic{Severity: "error", ErrorSource: "network", Phase: "execution"}
	default:
		return nil
	}
}

func taskSubmissionOutcome(task *model.Task, notSent bool) string {
	if notSent {
		return "not_submitted"
	}
	if task.ProviderRequestID != "" {
		return "accepted"
	}
	return "unknown"
}
