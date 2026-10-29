package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
)

const upstreamHTTP2FailureFrame = "event: error\ndata: {\"error\":{\"code\":\"upstream_http2_stream_error\",\"message\":\"Upstream HTTP/2 stream failed\",\"type\":\"upstream_error\"}}\n\n"

func TestStoryStreamHTTP2FailureThroughTransport(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\n")
		w.(http.Flusher).Flush()
		fmt.Fprint(w, upstreamHTTP2FailureFrame)
	}))
	defer server.Close()
	var deltas strings.Builder
	result, err := postStreamingTextResult(context.Background(), providerConfig{BaseURL: server.URL, Model: "fixture"}, "/chat/completions", map[string]interface{}{"model": "fixture"}, "chat-completion", func(text string) { deltas.WriteString(text) })
	if err == nil || !strings.Contains(err.Error(), "upstream_http2_stream_error") || !strings.Contains(err.Error(), "上游渠道") {
		t.Fatalf("stream failure was not classified: %v", err)
	}
	if strings.Contains(err.Error(), "检查请求内容") || result.Text != "" || deltas.Len() != 0 || requests.Load() != 1 {
		t.Fatalf("unexpected retry, content or guidance: result=%+v deltas=%q requests=%d err=%v", result, deltas.String(), requests.Load(), err)
	}
}

func TestMalformedAgentSSECompletesTheOriginalAuditRowAsWarning(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, db, _, _ := creationTestService(t)
	var err error
	s.coordinator, err = platform.NewCoordinator("sqlite")
	if err != nil {
		t.Fatal(err)
	}
	s.platform = platform.New(s.repo, s.coordinator, platformHost{svc: s})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"tool_calls\":")
	}))
	defer server.Close()

	ctx := context.WithValue(context.Background(), providerAnalyticsKey{}, providerAnalyticsContext{
		Service: s, UserID: "user", Capability: "text", RequestKind: "create", Model: "fixture",
	})
	result, err := postStreamingAgent(ctx, providerConfig{BaseURL: server.URL, Model: "fixture"}, "/chat/completions", map[string]interface{}{"model": "fixture"}, "chat-completion", nil)
	if err == nil || result != nil || !strings.Contains(err.Error(), "JSON") {
		t.Fatalf("malformed SSE was accepted: result=%v err=%v", result, err)
	}

	var logs []model.ApiCallLog
	if err := db.Find(&logs).Error; err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 {
		t.Fatalf("audit rows = %d, want one completed row: %#v", len(logs), logs)
	}
	if logs[0].Status != model.ApiCallStatusWarning || logs[0].ErrorSource != "content" || logs[0].StatusCode != http.StatusOK || logs[0].ErrorCode != "upstream_response_invalid" {
		t.Fatalf("malformed SSE audit = %#v", logs[0])
	}
	if errors.Is(err, context.Canceled) {
		t.Fatal("malformed SSE was reported as cancellation")
	}
}

func TestMalformedAgentToolArgumentsAreAuditedAsWarning(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, db, _, _ := creationTestService(t)
	var err error
	s.coordinator, err = platform.NewCoordinator("sqlite")
	if err != nil {
		t.Fatal(err)
	}
	s.platform = platform.New(s.repo, s.coordinator, platformHost{svc: s})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"production_submit","arguments":"{\"key\":\"asset""}}]}]}`+"\n\n")
	}))
	defer server.Close()
	ctx := context.WithValue(context.Background(), providerAnalyticsKey{}, providerAnalyticsContext{
		Service: s, UserID: "user", Capability: "text", RequestKind: "create", Model: "fixture",
	})
	result, err := postStreamingAgent(ctx, providerConfig{BaseURL: server.URL, Model: "fixture"}, "/chat/completions", map[string]interface{}{}, "chat-completion", nil)
	if err == nil || result != nil {
		t.Fatalf("malformed tool arguments were accepted: result=%v err=%v", result, err)
	}
	var entry model.ApiCallLog
	if err := db.First(&entry).Error; err != nil {
		t.Fatal(err)
	}
	if entry.Status != model.ApiCallStatusWarning || entry.ErrorSource != "content" || entry.StatusCode != http.StatusOK || entry.ErrorCode != "upstream_response_invalid" {
		t.Fatalf("malformed tool arguments were audited as success: %#v", entry)
	}
}

func TestAgentResponsesOutputLimitRetainsFailureCategory(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, db, _, _ := creationTestService(t)
	var err error
	s.coordinator, err = platform.NewCoordinator("sqlite")
	if err != nil {
		t.Fatal(err)
	}
	s.platform = platform.New(s.repo, s.coordinator, platformHost{svc: s})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"output\":[]}}\n\n")
	}))
	defer server.Close()
	ctx := context.WithValue(context.Background(), providerAnalyticsKey{}, providerAnalyticsContext{
		Service: s, UserID: "user", Capability: "text", RequestKind: "create", Model: "fixture",
	})
	result, err := postStreamingAgent(ctx, providerConfig{BaseURL: server.URL, Model: "fixture"}, "/responses", map[string]interface{}{}, "responses", nil)
	if !errors.Is(err, errProviderOutputLimit) || result != nil {
		t.Fatalf("output limit not propagated: result=%v err=%v", result, err)
	}
	var entry model.ApiCallLog
	if err := db.First(&entry).Error; err != nil {
		t.Fatal(err)
	}
	if entry.Status != model.ApiCallStatusWarning || entry.ErrorSource != "content" || entry.StatusCode != http.StatusOK || entry.ErrorCode != providerOutputLimitCode || entry.Error != errProviderOutputLimit.Error() {
		t.Fatalf("output-limit audit lost failure details: %#v", entry)
	}
	task := &model.Task{ID: "fixture", Status: model.TaskStatusFailed, Error: errProviderOutputLimit.Error()}
	recordTaskDiagnostic(task, "execution", "provider_execution_failed", "unknown", "new_generation_authorization", err)
	if diagnostic := taskExecutionDiagnostic(task); diagnostic == nil || diagnostic.Code != providerOutputLimitCode || diagnostic.SafeMessage != errProviderOutputLimit.Error() {
		t.Fatalf("task diagnostic lost output-limit category: %#v", diagnostic)
	}
	message := cloudAgentUserFailureMessage("fixture", fmt.Errorf("模型调用失败：%w", err))
	if message != errProviderOutputLimit.Error() {
		t.Fatalf("output-limit reason was replaced with a generic failure: %q", message)
	}
}

func TestDeclarativeAgentResponsesAuditsValidatedTerminalResult(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, stream := range []bool{false, true} {
		for _, scenario := range []struct {
			name, response, code string
		}{
			{"completed", `{"status":"completed","output":[{"type":"message","status":"completed","content":[{"type":"output_text","text":"saved"}]}],"usage":{"input_tokens":31,"output_tokens":11}}`, ""},
			{"completed-tool", `{"status":"completed","output":[{"type":"function_call","status":"completed","call_id":"call-1","name":"production_submit","arguments":"{\"key\":\"story\"}"}]}`, ""},
			{"output-limit", `{"status":"incomplete","error":null,"incomplete_details":{"reason":"max_output_tokens"},"output_text":"partial","usage":{"input_tokens":31,"output_tokens":16384}}`, providerOutputLimitCode},
			{"invalid-json", `{"status":`, "upstream_response_invalid"},
		} {
			t.Run(fmt.Sprintf("stream=%v/%s", stream, scenario.name), func(t *testing.T) {
				s, db, _, _ := creationTestService(t)
				s.coordinator = platform.NewCoordinatorWithRedis(nil, newID())
				s.platform = platform.New(s.repo, s.coordinator, platformHost{svc: s})
				var requests atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests.Add(1)
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						return
					}
					reasoning, _ := body["reasoning"].(map[string]any)
					if reasoning["effort"] != "none" || body["max_output_tokens"] != float64(16384) {
						t.Errorf("recovery lost explicit reasoning control or budget: %#v", body)
					}
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, scenario.response)
				}))
				defer server.Close()
				ctx := context.WithValue(context.Background(), providerAnalyticsKey{}, providerAnalyticsContext{
					Service: s, UserID: "user", Capability: "text", RequestKind: "create", Model: "fixture",
				})
				ctx = withProtocolRegistry(ctx, loadOfficialFallbackRegistry())
				result, err := runAgentToolTask(ctx, canvasGenerationInput{
					Config:        providerConfig{InterfaceType: "openai-response", Model: "fixture", BaseURL: server.URL},
					AgentRequests: &agentToolRequests{Responses: map[string]any{"input": []any{}}},
					StreamText:    stream, TextOptions: canvasTextOptions{ReasoningDisabled: true, MaxOutputTokens: 16384},
				})
				var logs []model.ApiCallLog
				if err := db.Find(&logs).Error; err != nil {
					t.Fatal(err)
				}
				if len(logs) != 1 || requests.Load() != 1 {
					t.Fatalf("one call must complete one receipt: logs=%d requests=%d", len(logs), requests.Load())
				}
				entry := logs[0]
				if entry.StatusCode != http.StatusOK || entry.ErrorCode != scenario.code {
					t.Fatalf("terminal receipt lost HTTP status/failure category: status=%s http=%d code=%q error=%q", entry.Status, entry.StatusCode, entry.ErrorCode, entry.Error)
				}
				if scenario.code == "" {
					if err != nil || entry.Status != model.ApiCallStatusSucceeded || result == nil {
						t.Fatalf("completed result was rejected: result=%v err=%v status=%s", result, err, entry.Status)
					}
					if scenario.name == "completed" && (result["text"] != "saved" || result["usage"] == nil || entry.OutputTokens != 11) {
						t.Fatalf("completed content/usage lost: %v output=%d", result, entry.OutputTokens)
					}
					if scenario.name == "completed-tool" && len(interfaceSlice(result["toolCalls"])) != 1 {
						t.Fatalf("completed tool call lost: %v", result)
					}
				} else if err == nil || result != nil || entry.Status != model.ApiCallStatusWarning || entry.ErrorSource != "content" || entry.Error == "" {
					t.Fatalf("partial result or missing failure receipt: result=%v err=%v status=%s error=%q", result, err, entry.Status, entry.Error)
				}
				if scenario.code == providerOutputLimitCode && (!errors.Is(err, errProviderOutputLimit) || entry.OutputTokens != 16384) {
					t.Fatalf("output-limit diagnosis/usage lost: err=%v output=%d", err, entry.OutputTokens)
				}
			})
		}
	}
}

func TestStreamingErrorNeverPromotesPartialTextToSuccess(t *testing.T) {
	for _, frame := range []string{
		upstreamHTTP2FailureFrame,
		"event: error\ndata: {\"error\":{\"code\":\"unknown_failure\"}}\n\n",
		"event: error\ndata: {\"error\":\"stream disconnected\"}\n\n",
		"event: error\ndata: {}\n\n",
	} {
		var deltas strings.Builder
		parser := newStreamingAgentParser("chat-completion", func(text string) { deltas.WriteString(text) })
		stream := "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n" + frame
		for _, fragment := range []string{stream[:17], stream[17:]} {
			parser.consume("text/event-stream", []byte(fragment))
		}
		parser.flush()
		result, err := parser.result()
		if err == nil || result != nil || deltas.String() != "partial" {
			t.Fatalf("partial result was lost or incorrectly accepted: result=%v delta=%q err=%v", result, deltas.String(), err)
		}
	}
}

func TestHTTP2StreamCodeIsExactAndDoesNotExposeRawMessage(t *testing.T) {
	err := validateTextPayload(map[string]interface{}{"error": map[string]interface{}{"code": "upstream_http2_stream_error", "message": "api_key=private https://internal.invalid"}})
	if err == nil || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "internal.invalid") {
		t.Fatalf("unsafe stream message: %v", err)
	}
	err = validateTextPayload(map[string]interface{}{"error": map[string]interface{}{"code": "invalid_parameter", "message": "input mentions upstream_http2_stream_error"}})
	if err == nil || strings.Contains(err.Error(), "上游渠道报告") {
		t.Fatalf("message mistaken for code: %v", err)
	}
	if err := validateTextPayload(map[string]interface{}{"error": nil}); err != nil {
		t.Fatal(err)
	}
}
