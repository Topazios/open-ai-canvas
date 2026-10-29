// 调用日志的费用估算与上游响应补全（请求 ID、视频 token、失败摘要）。

package app

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strings"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) estimateCallCost(log *model.ApiCallLog) {
	if log.Status == model.ApiCallStatusRunning {
		return
	}
	if (log.Status == model.ApiCallStatusFailed || log.Status == model.ApiCallStatusWarning) && !log.UsageAvailable {
		return
	}
	pricing, err := s.repo.ModelPricing(log.ChannelID, log.Model, log.Capability)
	if err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return
		}
		return
	}
	cost := int64(0)
	if log.Billable {
		cost = pricing.PerRequestMicros
	}
	cost += log.InputTokens * pricing.InputPerMillionMicros / 1_000_000
	cost += log.OutputTokens * pricing.OutputPerMillionMicros / 1_000_000
	cost += log.CachedTokens * pricing.CachedPerMillionMicros / 1_000_000
	cost += int64(log.MediaCount) * pricing.PerMediaMicros
	cost += int64(log.VideoSeconds) * pricing.PerVideoSecondMicros
	log.EstimatedCostMicros = cost
	log.CostAvailable = true
	log.Currency = pricing.Currency
}

func (s *Service) EnrichAPICallLog(log *model.ApiCallLog, responseBody []byte) {
	if log == nil {
		return
	}
	if log.ProviderRequestID == "" {
		log.ProviderRequestID = providerRequestIDFromPath(log.Path)
	}
	payloads := providerResponsePayloads(responseBody)
	explicitProviderFailure := false
	explicitProviderCode, explicitProviderMessage := "", ""
	for _, payload := range payloads {
		s.enrichAPICallLogPayload(log, payload)
		if apiCallPayloadExplicitFailure(payload) {
			explicitProviderFailure = true
			code, message := providerFailureDetails(payload)
			explicitProviderCode = firstNonEmpty(explicitProviderCode, code)
			explicitProviderMessage = firstNonEmpty(explicitProviderMessage, message)
		}
	}
	if explicitProviderFailure || model.APICallResponseHasExplicitFailure(string(responseBody)) {
		log.Status = model.ApiCallStatusFailed
		log.ErrorSource = "upstream"
		log.ErrorCode = firstNonEmpty(explicitProviderCode, log.ErrorCode)
		log.Error = firstNonEmpty(explicitProviderMessage, log.Error)
	}
	s.enrichAPICallLogFailureSummary(log, responseBody)
	log.Status = log.DisplayStatus()
	if log.Status == model.ApiCallStatusWarning && log.ErrorSource == "" {
		log.ErrorSource = "content"
	}
}

func apiCallPayloadExplicitFailure(payload map[string]any) bool {
	_, _, businessFailure := providerPayloadBusinessFailure(payload)
	providerError, _ := payload["error"].(map[string]any)
	return businessFailure || len(providerError) > 0 || strings.TrimSpace(stringField(payload, "error")) != "" || stringField(payload, "type") == "error" || stringField(payload, "type") == "response.failed"
}

func (s *Service) enrichAPICallLogFailureSummary(log *model.ApiCallLog, responseBody []byte) {
	if log.Status != model.ApiCallStatusFailed || log.StatusCode < 400 {
		return
	}
	userMessage := providerUserFacingErrorMessage(providerHTTPError{
		StatusCode: log.StatusCode,
		Body:       string(responseBody),
	})
	detail := strings.TrimSpace(log.Error)
	if detail == "" || detail == userMessage || strings.Contains(userMessage, "；上游："+detail) {
		log.Error = userMessage
		return
	}
	if strings.Contains(detail, userMessage) {
		return
	}
	log.Error = truncateRunes(userMessage+"；上游："+detail, 2_000)
}

func (s *Service) enrichAPICallLogPayload(log *model.ApiCallLog, payload map[string]any) {
	nestedTaskID := ""
	if data, ok := payload["data"].(map[string]any); ok {
		if log.Capability == "video" && strings.Contains(log.Path, "/v1/video/generations") {
			if extracted, err := firstJSONString(data, "task_id", "taskId"); err == nil {
				nestedTaskID = extracted
			}
		}
		for key, value := range data {
			if _, exists := payload[key]; !exists {
				payload[key] = value
			}
		}
	}
	// Responses API 的终态 SSE 把实际响应（包括 usage）放在 response 字段中。
	if response, ok := payload["response"].(map[string]any); ok {
		for key, value := range response {
			if _, exists := payload[key]; !exists {
				payload[key] = value
			}
		}
	}
	if log.Status == model.ApiCallStatusFailed || log.Status == model.ApiCallStatusWarning {
		errorCode, errorMessage := providerFailureDetails(payload)
		log.ErrorCode = firstNonEmpty(errorCode, log.ErrorCode)
		if errorMessage != "" {
			log.Error = errorMessage
		}
	}
	arkVideo := log.Capability == "video" && strings.Contains(log.Path, "/contents/generations/tasks")
	usage, _ := payload["usage"].(map[string]any)
	if log.Capability == "video" {
		log.InputTokens, log.CachedTokens = 0, 0
		log.OutputTokens, log.UsageAvailable = videoCompletionTokens(payload, arkVideo)
	} else if usage != nil {
		inputTokens, inputAvailable := firstInt64Value(usage, "input_tokens", "prompt_tokens")
		outputTokens, outputAvailable := firstInt64Value(usage, "output_tokens", "completion_tokens")
		if inputAvailable {
			log.InputTokens = inputTokens
		}
		if outputAvailable {
			log.OutputTokens = outputTokens
			log.ReasoningTokens = reportedReasoningTokens(usage, outputTokens)
		}
		if inputAvailable || outputAvailable {
			log.UsageAvailable = true
		}
		if details, ok := usage["input_tokens_details"].(map[string]any); ok {
			log.CachedTokens = firstInt64(details, "cached_tokens", "cache_read_input_tokens")
		}
		if details, ok := usage["prompt_tokens_details"].(map[string]any); ok && log.CachedTokens == 0 {
			log.CachedTokens = firstInt64(details, "cached_tokens", "cache_read_input_tokens")
		}
		if log.CachedTokens == 0 {
			log.CachedTokens = firstInt64(usage, "cached_tokens", "cache_read_input_tokens", "prompt_cache_hit_tokens")
		}
	}
	if usageMetadata, ok := payload["usageMetadata"].(map[string]any); ok && log.Capability != "video" {
		inputTokens, inputAvailable := firstInt64Value(usageMetadata, "promptTokenCount")
		outputTokens, outputAvailable := firstInt64Value(usageMetadata, "candidatesTokenCount")
		if inputAvailable {
			log.InputTokens = inputTokens
		}
		if outputAvailable {
			log.OutputTokens = outputTokens
		}
		if inputAvailable || outputAvailable {
			log.UsageAvailable = true
		}
		log.CachedTokens = firstInt64(usageMetadata, "cachedContentTokenCount")
	}
	if extracted, err := firstJSONString(payload, "task_id", "id", "request_id", "name"); err == nil {
		log.ProviderRequestID = firstNonEmpty(nestedTaskID, extracted, log.ProviderRequestID)
	} else {
		log.ProviderRequestID = firstNonEmpty(nestedTaskID, log.ProviderRequestID)
	}
	log.ProviderStatus = strings.ToLower(firstNonEmpty(stringField(payload, "status"), log.ProviderStatus))
	// A provider error object or explicit failed event takes precedence over an
	// incomplete response while retaining its original provider error code.
	if apiCallPayloadExplicitFailure(payload) {
		log.Status = model.ApiCallStatusFailed
		log.ErrorSource = "upstream"
		code, message := providerFailureDetails(payload)
		log.ErrorCode = firstNonEmpty(code, log.ErrorCode)
		log.Error = firstNonEmpty(message, log.Error)
	}
	if log.ProviderStatus == "failed" || log.ProviderStatus == "cancelled" || log.ProviderStatus == "canceled" || log.ProviderStatus == "expired" || log.ProviderStatus == "incomplete" {
		log.Status = model.ApiCallStatusFailed
		if log.ProviderStatus != "incomplete" {
			log.ErrorSource = "upstream"
		}
		errorCode, errorMessage := providerFailureDetails(payload)
		log.ErrorCode = firstNonEmpty(errorCode, log.ErrorCode)
		log.Error = firstNonEmpty(errorMessage, log.Error)
	}
	if log.Capability == "image" {
		if data, ok := payload["data"].([]any); ok {
			log.MediaCount = len(data)
		} else if images, ok := payload["images"].([]any); ok {
			log.MediaCount = len(images)
		}
	}
}

// Reasoning is a reported subset of output tokens, never an additional charge.
// A missing or invalid breakdown stays unknown instead of being inferred from text.
func reportedReasoningTokens(usage map[string]any, outputTokens int64) *int64 {
	for _, key := range []string{"output_tokens_details", "completion_tokens_details"} {
		details, _ := usage[key].(map[string]any)
		value, exists := details["reasoning_tokens"]
		if !exists {
			continue
		}
		var tokens int64
		switch v := value.(type) {
		case json.Number:
			var err error
			tokens, err = v.Int64()
			if err != nil {
				return nil
			}
		case float64:
			if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v >= math.MaxInt64 || math.Trunc(v) != v {
				return nil
			}
			tokens = int64(v)
		case int64:
			tokens = v
		default:
			return nil
		}
		if tokens < 0 || tokens > outputTokens {
			return nil
		}
		return &tokens
	}
	return nil
}

func videoCompletionTokens(payload map[string]any, arkProtocol bool) (int64, bool) {
	if status, exists := payload["status"]; exists {
		text, ok := status.(string)
		status := strings.ToLower(strings.TrimSpace(text))
		if !ok || (status != "succeeded" && (arkProtocol || (status != "completed" && status != "success"))) {
			return 0, false
		}
	}
	usage, _ := payload["usage"].(map[string]any)
	value, exists := usage["completion_tokens"]
	if !exists && !arkProtocol {
		value, exists = usage["output_tokens"]
	}
	if !exists {
		value = usage["total_tokens"]
	}
	// completion_tokens 一旦返回就是唯一结算依据，非法值不能用 total_tokens 掩盖。
	// JSON Number 保留整数精度，避免浮点取整把小数或超出 int64 的值变成可计费用量。
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	tokens, err := number.Int64()
	if err != nil || tokens <= 0 {
		return 0, false
	}
	return tokens, true
}

func providerResponsePayloads(responseBody []byte) []map[string]any {
	if len(responseBody) == 0 {
		return nil
	}
	if payload, ok := decodeProviderResponsePayload(responseBody); ok {
		return []map[string]any{payload}
	}

	// 流式文本的用量只出现在最后一个 SSE data 事件中，不能把整段响应当作 JSON。
	result := make([]map[string]any, 0)
	scanner := bufio.NewScanner(bytes.NewReader(responseBody))
	scanner.Buffer(make([]byte, 64<<10), max(len(responseBody)+1, 64<<10))
	dataLines := make([]string, 0, 1)
	eventName := ""
	flush := func() {
		raw := strings.TrimSpace(strings.Join(dataLines, "\n"))
		dataLines = dataLines[:0]
		name := eventName
		eventName = ""
		if raw == "" || raw == "[DONE]" {
			return
		}
		if event, ok := decodeProviderResponsePayload([]byte(raw)); ok {
			if _, exists := event["type"]; !exists && name != "" {
				event["type"] = name
			}
			result = append(result, event)
		}
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			flush()
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
		if strings.HasPrefix(line, "event:") {
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		}
	}
	flush()
	return result
}

func decodeProviderResponsePayload(data []byte) (map[string]any, bool) {
	if !json.Valid(data) {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var payload map[string]any
	err := decoder.Decode(&payload)
	return payload, err == nil && payload != nil
}

func providerRequestIDFromPath(path string) string {
	parts := strings.Split(strings.Trim(strings.TrimSpace(path), "/"), "/")
	for index := len(parts) - 1; index >= 0; index-- {
		part := strings.TrimSpace(parts[index])
		if part == "" || part == "content" || part == "download" {
			continue
		}
		if index > 0 && (parts[index-1] == "videos" || parts[index-1] == "tasks") {
			return part
		}
		break
	}
	return ""
}

func firstInt64(values map[string]any, keys ...string) int64 {
	value, _ := firstInt64Value(values, keys...)
	return value
}

func firstInt64Value(values map[string]any, keys ...string) (int64, bool) {
	for _, key := range keys {
		switch value := values[key].(type) {
		case float64:
			return int64(value), true
		case int64:
			return value, true
		case json.Number:
			parsed, err := value.Int64()
			return parsed, err == nil
		}
	}
	return 0, false
}
