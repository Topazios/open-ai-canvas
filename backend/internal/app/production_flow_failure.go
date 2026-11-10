package app

import (
	"strings"

	"infinite-canvas/backend/internal/model"
)

// Preserve a useful, sanitized cause at settlement, rather than making the
// browser chase a separate task log after the coordinator has stopped.
func (s *Service) productionFlowFailure(task *model.Task) productionFlowIssue {
	issue := productionFlowIssueAt("execution", "request_failed", task.ID, userFacingTaskFailure(task))
	issue.Action = "重试未完成步骤，保留已通过内容"
	if diagnostic := taskExecutionDiagnostic(task); diagnostic != nil {
		issue.Code, issue.ErrorSource = diagnostic.Code, diagnostic.ErrorSource
	}
	log, err := s.repo.LatestAPICallFailureForTask(task.ID)
	if err == nil && log.ErrorCode != "" {
		issue.Code = log.ErrorCode
	}
	switch strings.ToLower(issue.Code) {
	case "upstream_error", "server_error", "overloaded_error", "unavailable", "service_unavailable":
		issue.Message, issue.ErrorSource = "模型服务在响应过程中报告暂时不可用", "upstream"
	case "upstream_stream_read_error", "upstream_http2_stream_error":
		issue.Message = "模型响应流中断，未收到可采用的完整结果"
	case "rate_limit_exceeded", "gateway_concurrency_limit":
		issue.Message = "模型渠道暂时限流，当前步骤尚未完成"
	case "upstream_response_invalid":
		issue.Message = "返回内容不完整或无法解析为当前步骤的结果"
	}
	if issue.ErrorSource == "network" {
		issue.Message = "模型响应连接中断，未收到完整结果"
	}
	if task.ProviderCancelStatus == model.ProviderCancelStatusRequested || task.ProviderCancelStatus == model.ProviderCancelStatusUncertain {
		issue.Action = "原调用取消状态待核对，暂不重复提交收费请求"
	}
	issue.Message = safeTaskDiagnosticMessage(issue.Message)
	return issue
}
