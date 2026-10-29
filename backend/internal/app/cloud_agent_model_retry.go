package app

import (
	"strings"

	"infinite-canvas/backend/internal/model"
)

// cloudAgentModelTaskTransientFailure is the classification used by the model
// retry loop; it does not submit tasks or change billing/retry limits.
func (s *Service) cloudAgentModelTaskTransientFailure(taskID string) bool {
	task, err := s.repo.Task(taskID)
	if err != nil || task == nil || task.Status != model.TaskStatusFailed {
		return false
	}
	// Output limits need a changed request, not an unchanged transient retry.
	if cloudAgentOutputLimitReached(task) {
		return false
	}
	log, err := s.repo.LatestAPICallFailureForTask(taskID)
	if err != nil {
		return false
	}
	diagnosticCode := ""
	if diagnostic := taskExecutionDiagnostic(task); diagnostic != nil {
		diagnosticCode = diagnostic.Code
		if diagnostic.RetryClass == "correct_input" {
			return false
		}
	}
	// A permanent failure takes precedence over a generic HTTP/server error.
	for _, detail := range []string{diagnosticCode, log.ErrorCode, log.Error, task.Error} {
		if cloudAgentModelPermanentFailure(detail) {
			return false
		}
	}
	status := log.StatusCode
	if status >= 400 && status < 500 && status != 408 && status != 429 {
		return false
	}
	if cloudAgentEmptyModelOutput(task) || cloudAgentStepTimedOut(task) {
		return true
	}
	if status >= 500 || status == 429 || status == 408 {
		return true
	}
	if status == 0 || (status >= 200 && status < 300) {
		for _, code := range []string{log.ErrorCode, diagnosticCode} {
			switch strings.ToLower(strings.TrimSpace(code)) {
			case "server_error", "overloaded_error", "service_unavailable", "unavailable", "upstream_timeout", "rate_limit_exceeded", "upstream_response_invalid":
				return true
			}
		}
		// Only use the known overload message when the provider supplied no code.
		if strings.TrimSpace(log.ErrorCode) == "" {
			for _, message := range []string{log.Error, task.Error} {
				if strings.EqualFold(strings.TrimSpace(message), "Our servers are currently overloaded. Please try again later.") {
					return true
				}
			}
		}
		// HTTP success only acknowledges the headers. Reading a streaming body
		// can still fail before a usable model result has been received.
		for _, detail := range []string{log.Error, task.Error} {
			raw := strings.ToLower(detail)
			if strings.Contains(raw, "agent 流式事件解析失败：unexpected end of json input") ||
				strings.Contains(raw, "agent 流式响应不完整或 json 无效") ||
				strings.Contains(raw, "agent 工具参数不是完整 json") {
				return true
			}
			if strings.Contains(raw, "timeout") || strings.Contains(raw, "deadline") || strings.Contains(raw, "connection") || strings.Contains(raw, "eof") || strings.Contains(raw, "超时") {
				return true
			}
		}
	}
	return false
}

func cloudAgentModelPermanentFailure(detail string) bool {
	if isContentModerationFailure(detail) {
		return true
	}
	detail = strings.ToLower(detail)
	for _, marker := range []string{
		"authentication", "unauthorized", "forbidden", "permission_denied",
		"invalid_api_key", "invalid api key", "incorrect api key",
		"quota", "balance", "billing", "credit", "payment_required",
		"content_filter", "content policy", "safety_violation",
		"invalid_request", "invalid request", "invalid_input", "invalid input",
		"invalid_parameter", "invalid parameter", "bad_request", "context_length_exceeded",
		"model_not_found", "余额不足", "配额", "鉴权", "参数无效",
	} {
		if strings.Contains(detail, marker) {
			return true
		}
	}
	return false
}
