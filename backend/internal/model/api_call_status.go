package model

import (
	"bufio"
	"encoding/json"
	"strings"
)

// DisplayStatus projects older incomplete-response receipts without changing
// their stored transport, usage, billing, or task outcome facts.
func (log ApiCallLog) DisplayStatus() ApiCallStatus {
	if log.ErrorSource != "" && log.ErrorSource != "content" {
		return log.Status
	}
	if log.Status == ApiCallStatusRunning || log.StatusCode < 200 || log.StatusCode >= 300 {
		return log.Status
	}
	switch log.ProviderStatus {
	case "failed", "cancelled", "canceled", "expired":
		return ApiCallStatusFailed
	}
	if log.ErrorCode == "output_limit_exceeded" || log.ErrorCode == "upstream_response_invalid" || (log.ProviderStatus == "incomplete" && log.ErrorCode == "") {
		if log.ErrorSource == "" && APICallResponseHasExplicitFailure(log.ResponseBody) {
			return ApiCallStatusFailed
		}
		return ApiCallStatusWarning
	}
	return log.Status
}

// APICallResponseHasExplicitFailure reads retained JSON/SSE structure only.
// Missing or truncated evidence cannot establish a provider error.
func APICallResponseHasExplicitFailure(body string) bool {
	var payload map[string]any
	if json.Unmarshal([]byte(body), &payload) == nil && payload != nil {
		return apiCallPayloadHasExplicitFailure(payload)
	}
	scanner := bufio.NewScanner(strings.NewReader(body))
	scanner.Buffer(make([]byte, 64<<10), max(len(body)+1, 64<<10))
	eventName := ""
	data := make([]string, 0, 1)
	flush := func() bool {
		name, raw := eventName, strings.TrimSpace(strings.Join(data, "\n"))
		eventName, data = "", data[:0]
		if name == "error" || name == "response.failed" {
			return true
		}
		if raw == "" || raw == "[DONE]" {
			return false
		}
		var event map[string]any
		if json.Unmarshal([]byte(raw), &event) != nil || event == nil {
			return false
		}
		return apiCallPayloadHasExplicitFailure(event)
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if flush() {
				return true
			}
		} else if strings.HasPrefix(line, "event:") {
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	return flush()
}

func apiCallPayloadHasExplicitFailure(payload map[string]any) bool {
	if kind, _ := payload["type"].(string); kind == "error" || kind == "response.failed" {
		return true
	}
	if status, _ := payload["status"].(string); status == "failed" || status == "cancelled" || status == "canceled" || status == "expired" {
		return true
	}
	switch failure := payload["error"].(type) {
	case map[string]any:
		if len(failure) > 0 {
			return true
		}
	case string:
		if strings.TrimSpace(failure) != "" {
			return true
		}
	}
	for _, key := range []string{"response", "data"} {
		if nested, ok := payload[key].(map[string]any); ok && apiCallPayloadHasExplicitFailure(nested) {
			return true
		}
	}
	return false
}
