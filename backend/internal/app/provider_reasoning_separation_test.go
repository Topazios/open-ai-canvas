package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/protocol"
)

func TestProviderReasoningIsNeverUsableOutput(t *testing.T) {
	for _, test := range []struct{ wire, raw string }{
		{"responses", `{"status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"{\"toolCalls\":[{\"name\":\"save\"}]}"}]}]}`},
		{"chat-completion", `{"choices":[{"message":{"content":null,"reasoning_content":"{\"toolCalls\":[{\"name\":\"save\"}]}"}}]}`},
		{"claude-api", `{"content":[{"type":"thinking","thinking":"{\"toolCalls\":[{\"name\":\"save\"}]}"}]}`},
	} {
		t.Run(test.wire, func(t *testing.T) {
			var payload map[string]any
			if err := json.Unmarshal([]byte(test.raw), &payload); err != nil {
				t.Fatal(err)
			}
			result, err := parseAgentToolPayload(payload, test.wire)
			if err == nil || !strings.Contains(err.Error(), "仅返回思考") || stringField(result, "text") != "" || len(interfaceSlice(result["toolCalls"])) != 0 {
				t.Fatalf("reasoning accepted as content or tools: result=%v err=%v", result, err)
			}
		})
	}
	result, err := finishProtocolResult(context.Background(), providerConfig{}, "text", "", &protocol.Result{Reasoning: "not an answer"}, videoPollPolicy{})
	if err == nil || result != nil {
		t.Fatalf("reasoning-only adapter output accepted: %v %v", result, err)
	}
}

func TestProviderTypedTextPartsExcludeReasoningAndToolArguments(t *testing.T) {
	parts := []any{
		map[string]any{"type": "reasoning_text", "text": "private reasoning"},
		map[string]any{"type": "summary_text", "text": "summary"},
		map[string]any{"type": "text", "thought": true, "text": "thought"},
		map[string]any{"type": "function_call", "text": "tool arguments"},
		map[string]any{"type": "output_text", "text": " final "},
	}
	payload := map[string]any{"output": []any{map[string]any{"type": "message", "content": parts}}}
	if text := extractResponseText(payload); text != " final " {
		t.Fatalf("mixed Responses content: %q", text)
	}
	if text := streamContentText(parts); text != " final " {
		t.Fatalf("mixed Chat content: %q", text)
	}
	stream := "event: response.reasoning_summary_text.delta\ndata: {\"delta\":\"reasoning\"}\n\n" +
		"event: response.function_call_arguments.delta\ndata: {\"delta\":\"arguments\"}\n\n" +
		"data: {\"delta\":\"untyped\"}\n\n" +
		"event: message\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\" final \"}\n\n"
	text, err := parseTextEventStream([]byte(stream), "responses")
	if err != nil || text != " final " {
		t.Fatalf("mixed legacy stream: %q %v", text, err)
	}
}

func TestProviderStreamKeepsReasoningTextAndToolsSeparate(t *testing.T) {
	for _, test := range []struct{ wire, stream string }{
		{"responses", "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\" reasoning \"}\n\n" +
			"data: {\"type\":\"response.output_text.delta\",\"delta\":\" final \"}\n\n" +
			"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\" final \"}]},{\"type\":\"function_call\",\"call_id\":\"call-1\",\"name\":\"save\",\"arguments\":\"{}\"}]}}\n\n"},
		{"chat-completion", "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\" reasoning \"}}]}\n\n" +
			"data: {\"choices\":[{\"delta\":{\"content\":\" final \",\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"save\",\"arguments\":\"{}\"}}]}}]}\n\n"},
		{"claude-api", "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\" reasoning \"}}\n\n" +
			"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\" final \"}}\n\n" +
			"data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call-1\",\"name\":\"save\",\"input\":{}}}\n\n"},
	} {
		t.Run(test.wire, func(t *testing.T) {
			var text, reasoning strings.Builder
			parser := newStreamingAgentParser(test.wire, func(s string) { text.WriteString(s) })
			parser.emitReasoning = func(s string) { reasoning.WriteString(s) }
			for start := 0; start < len(test.stream); start += 7 {
				parser.consume("text/event-stream", []byte(test.stream[start:min(start+7, len(test.stream))]))
			}
			parser.flush()
			result, err := parser.result()
			if err != nil || result["text"] != " final " || result["reasoning"] != " reasoning " || text.String() != " final " || reasoning.String() != " reasoning " || len(interfaceSlice(result["toolCalls"])) != 1 {
				t.Fatalf("mixed stream channels: result=%v text=%q reasoning=%q err=%v", result, text.String(), reasoning.String(), err)
			}
		})
	}
}

func TestDeclarativeTextAuditsActualContentNotReasoning(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, stream := range []bool{false, true} {
		for _, answer := range []string{"", " final "} {
			t.Run(fmt.Sprintf("stream=%v/answer=%q", stream, answer), func(t *testing.T) {
				s, db, _, _ := creationTestService(t)
				s.coordinator = platform.NewCoordinatorWithRedis(nil, newID())
				s.platform = platform.New(s.repo, s.coordinator, platformHost{svc: s})
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					payload := map[string]any{"status": "completed", "output_text": answer, "output": []any{map[string]any{"type": "reasoning", "summary": []any{map[string]any{"type": "summary_text", "text": "reasoning"}}}}, "usage": map[string]any{"input_tokens": 3, "output_tokens": 20, "output_tokens_details": map[string]any{"reasoning_tokens": 15}}}
					data, _ := json.Marshal(payload)
					if stream {
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprintf(w, "event: response.completed\ndata: {\"response\":%s}\n\n", data)
					} else {
						w.Header().Set("Content-Type", "application/json")
						_, _ = w.Write(data)
					}
				}))
				defer server.Close()
				ctx := context.WithValue(context.Background(), providerAnalyticsKey{}, providerAnalyticsContext{Service: s, UserID: "user", Capability: "text", RequestKind: "create", Model: "fixture"})
				ctx = withProtocolRegistry(ctx, loadOfficialFallbackRegistry())
				result, err := runTextTask(ctx, canvasGenerationInput{Mode: "text", Prompt: "test", StreamText: stream, Config: providerConfig{InterfaceType: "openai-response", Model: "fixture", BaseURL: server.URL}})
				var logs []model.ApiCallLog
				if queryErr := db.Find(&logs).Error; queryErr != nil {
					t.Fatal(queryErr)
				}
				if len(logs) != 1 || logs[0].ReasoningTokens == nil || *logs[0].ReasoningTokens != 15 || logs[0].OutputTokens != 20 {
					t.Fatalf("lost audit/usage: %+v", logs)
				}
				if answer == "" {
					if err == nil || result != nil || logs[0].Status != model.ApiCallStatusFailed || !strings.Contains(logs[0].Error, "仅返回思考") {
						t.Fatalf("reasoning-only result accepted: %v %v %+v", result, err, logs[0])
					}
				} else if err != nil || result["text"] != answer || result["reasoning"] != "reasoning" || logs[0].Status != model.ApiCallStatusSucceeded {
					t.Fatalf("valid result rejected/mixed: %v %v", result, err)
				}
			})
		}
	}
}
