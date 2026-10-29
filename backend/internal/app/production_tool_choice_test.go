package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Exercise the actual production envelope through both protocol adapters. A
// provider can reject forced choice while still returning valid tool calls.
func TestProductionReasoningToolChoiceOnActualWire(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, wire := range []string{"openai-response", "chat-completion"} {
		for _, declarative := range []bool{false, true} {
			for _, stream := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/plugin=%t/stream=%t", wire, declarative, stream), func(t *testing.T) {
					s, db, run := planFixture(t, 2)
					productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
					task, done := productionRuntimeStart(t, s, run.ID, []map[string]any{{"role": "user", "content": "write current document"}})
					var input canvasGenerationInput
					if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
						t.Fatal(err)
					}
					requests := 0
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						requests++
						var body map[string]any
						if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
							t.Error(err)
							w.WriteHeader(http.StatusBadRequest)
							return
						}
						if choice := body["tool_choice"]; choice != nil && choice != "auto" {
							w.WriteHeader(http.StatusBadRequest)
							fmt.Fprint(w, `{"error":{"message":"Thinking mode does not support this tool_choice"}}`)
							return
						}
						if tools := interfaceSlice(body["tools"]); len(tools) != 1 {
							t.Errorf("phase tool scope lost: %+v", tools)
						}
						if wire == "openai-response" {
							if body["reasoning"] == nil {
								t.Error("tool selection disabled reasoning")
							}
							payload := `{"status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"check prerequisites"}]},{"type":"function_call","call_id":"call-1","name":"production_submit","arguments":"{}"}]}`
							if stream {
								w.Header().Set("Content-Type", "text/event-stream")
								fmt.Fprintf(w, "event: response.completed\ndata: {\"response\":%s}\n\n", payload)
							} else {
								w.Header().Set("Content-Type", "application/json")
								fmt.Fprint(w, payload)
							}
							return
						}
						if body["reasoning_effort"] == nil {
							t.Error("tool selection disabled reasoning")
						}
						message := `{"reasoning_content":"check prerequisites","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"production_submit","arguments":"{}"}}]}`
						if stream {
							w.Header().Set("Content-Type", "text/event-stream")
							fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":%s}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n", message)
						} else {
							w.Header().Set("Content-Type", "application/json")
							fmt.Fprintf(w, `{"choices":[{"message":%s,"finish_reason":"tool_calls"}]}`, message)
						}
					}))
					defer server.Close()
					input.Config = providerConfig{BaseURL: server.URL, Model: "fixture", APIKey: "fixture", InterfaceType: wire}
					input.StreamText = stream
					input.TextOptions.Thinking, input.TextOptions.ReasoningDisabled = true, false
					ctx := context.Background()
					if declarative {
						ctx = withProtocolRegistry(ctx, loadOfficialFallbackRegistry())
					}
					result, err := runAgentToolTask(ctx, input)
					if err != nil || requests != 1 {
						t.Fatalf("reasoning tool request failed or retried: requests=%d err=%v", requests, err)
					}
					var parsed struct {
						ToolCalls []cloudAgentCall `json:"toolCalls"`
					}
					encoded, _ := json.Marshal(result)
					if err := json.Unmarshal(encoded, &parsed); err != nil || len(parsed.ToolCalls) != 1 || parsed.ToolCalls[0].Function.Name != "production_submit" || result["reasoning"] == "" {
						t.Fatalf("tool/reasoning parsing lost: %s err=%v", encoded, err)
					}
					if got := productionRuntimeFinish(t, db, task.ID, done, parsed.ToolCalls...); got.err != nil {
						t.Fatal("server rejected the required operation despite automatic wire choice", got.err)
					}
				})
			}
		}
	}
}
