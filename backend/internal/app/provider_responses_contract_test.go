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
)

func TestResponsesContractTextOptionsAndVision(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprint(stream), func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				if r.URL.Path != "/v1/responses" || body["store"] != false || body["max_output_tokens"] != float64(2048) || body["instructions"] != "system rule" {
					t.Errorf("wrong request: %s %#v", r.URL.Path, body)
				}
				if body["reasoning"] == nil || body["response_format"] != nil {
					t.Errorf("wrong reasoning/schema: %#v", body)
				}
				text, _ := body["text"].(map[string]any)
				format, _ := text["format"].(map[string]any)
				if format["name"] != "assets" || format["strict"] != true {
					t.Errorf("missing format: %#v", text)
				}
				messages := interfaceSlice(body["input"])
				if len(messages) != 3 {
					t.Errorf("lost history: %#v", messages)
					return
				}
				message := messages[2].(map[string]any)
				parts := interfaceSlice(message["content"])
				if len(parts) != 2 || parts[0].(map[string]any)["type"] != "input_text" || parts[1].(map[string]any)["image_url"] != "https://example.com/image.png" {
					t.Errorf("wrong Responses vision parts: %#v", parts)
				}
				response := `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"assets"}]}],"usage":{"input_tokens":10,"output_tokens":5}}`
				if stream {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "event: response.output_text.delta\ndata: {\"delta\":\"assets\"}\n\n")
					fmt.Fprintf(w, "event: response.completed\ndata: {\"response\":%s}\n\n", response)
				} else {
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, response)
				}
			}))
			defer server.Close()
			result, err := runTextTask(withProtocolRegistry(context.Background(), loadOfficialFallbackRegistry()), canvasGenerationInput{
				Mode: "text", Prompt: "extract", StreamText: stream, MaxOutputTokens: 4096,
				Config:          providerConfig{InterfaceType: "openai-response", Model: "fixture", BaseURL: server.URL, APIKey: "fixture", SystemPrompt: "system rule"},
				TextHistory:     []providerTextMessage{{Role: "user", Content: "previous question"}, {Role: "assistant", Content: "previous answer"}},
				ReferenceImages: []providerMedia{{URL: "https://example.com/image.png"}},
				TextOptions:     canvasTextOptions{Thinking: true, MaxOutputTokens: 2048, StructuredOutput: &StructuredTextOutput{Name: "assets", Schema: map[string]any{"type": "object"}}},
			})
			if err != nil || result["text"] != "assets" || calls != 1 {
				t.Fatalf("result=%v err=%v calls=%d", result, err, calls)
			}
		})
	}
}

func TestResponsesContractRejectsPartialResults(t *testing.T) {
	for _, payload := range []string{
		`{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output_text":"partial"}`,
		`{"status":"failed","output_text":"partial"}`,
		`{"status":"in_progress","output_text":"partial"}`,
		`{"status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"no"}]}]}`,
		`{"status":"completed","output":[]}`,
	} {
		var value map[string]any
		if err := json.Unmarshal([]byte(payload), &value); err != nil {
			t.Fatal(err)
		}
		if _, err := parseAgentToolPayload(value, "responses"); err == nil {
			t.Errorf("agent accepted %s", payload)
		}
		if _, err := parseProtocolResponsesText([]byte(payload)); err == nil {
			t.Errorf("text accepted %s", payload)
		}
	}
}

func TestResponsesContractStreamRequiresCompletion(t *testing.T) {
	for _, ending := range []string{"", "data: [DONE]\n\n", "event: response.failed\ndata: {\"response\":{\"status\":\"failed\"}}\n\n", "data: {\"type\":\"response.incomplete\",\"response\":{\"status\":\"incomplete\"}}\n\n"} {
		parser := newStreamingAgentParser("responses", nil)
		parser.consume("text/event-stream", []byte("event: response.output_text.delta\ndata: {\"delta\":\"partial\"}\n\n"+ending))
		parser.flush()
		if _, err := parser.result(); err == nil {
			t.Errorf("accepted incomplete stream %q", ending)
		}
	}
	parser := newStreamingAgentParser("responses", nil)
	parser.consume("text/event-stream", []byte("event: response.completed\ndata: {\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"call_id\":\"call-1\",\"name\":\"read\",\"arguments\":\"{}\"}],\"usage\":{\"input_tokens\":13}}}\n\n"))
	parser.flush()
	result, err := parser.result()
	if err != nil || len(interfaceSlice(result["toolCalls"])) != 1 || result["usage"] == nil {
		t.Fatalf("lost tools/usage: %v %v", result, err)
	}
}

func TestResponsesContractPreservesOptionalTools(t *testing.T) {
	body := canonicalAgentResponsesBody(&canonicalAgentRequest{Messages: []map[string]any{{"role": "user", "content": "test"}}, Tools: []map[string]any{{"type": "function", "function": map[string]any{"name": "read", "parameters": map[string]any{"type": "object"}}}, {"type": "function", "function": map[string]any{"name": "submit", "strict": true}}}, ToolChoice: "auto"})
	applyResponsesRequestDefaults(body, "responses")
	tools := interfaceSlice(body["tools"])
	if body["store"] != false || tools[0].(map[string]any)["strict"] != false || tools[1].(map[string]any)["strict"] != true {
		t.Fatalf("wrong defaults: %v", body)
	}
}

func TestResponsesContractRelayAuthorization(t *testing.T) {
	s, _ := newChannelModelTestService(t)
	profile := DefaultModelCapabilityConfig("chat-completion")
	item := &model.ChannelModel{Capability: "text", Protocol: model.ChannelInterfaceChatCompletion}
	if _, err := s.ResolveSystemProxyProtocol(item, "/responses"); err == nil {
		t.Fatal("undeclared Responses authorized")
	}
	profile.Protocols = &ModelProtocolConfig{Policy: ModelProtocolAuto, Supported: []string{"openai-response"}}
	item.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, profile)
	if got, err := s.ResolveSystemProxyProtocol(item, "/responses"); err != nil || got != model.ChannelInterfaceOpenAIResponse {
		t.Fatalf("authorized response: %s %v", got, err)
	}
	if _, err := s.ResolveSystemProxyProtocol(item, "/messages"); err == nil {
		t.Fatal("undeclared Messages authorized")
	}
	profile.Protocols.Policy = ModelProtocolFixed
	item.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, profile)
	if _, err := s.ResolveSystemProxyProtocol(item, "/responses"); err == nil {
		t.Fatal("fixed route ignored")
	}
}

func TestResponsesContractRouteChangeDropsOldPin(t *testing.T) {
	s, db := newChannelModelTestService(t)
	item := model.ChannelModel{ID: "new-route-model", ChannelID: "new-channel", ModelKey: "fixture", Capability: "text", Enabled: true, Protocol: model.ChannelInterfaceChatCompletion}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"mode": "text", "config": map[string]any{"channelId": "old-channel", "selectedProtocol": "openai-response"}}
	input = applyRoutedProviderSelection(input, &RoutedModel{ChannelModel: item})
	if input["config"].(map[string]any)["selectedProtocol"] != nil {
		t.Fatal("previous channel pin leaked")
	}
	if err := s.pinTaskModelProtocol(input); err != nil {
		t.Fatal(err)
	}
	if input["config"].(map[string]any)["selectedProtocol"] != "chat-completion" {
		t.Fatal("new channel did not use its declaration")
	}
}

func TestResponsesContractRelayCompletionValidation(t *testing.T) {
	if err := ValidateResponsesProviderResult([]byte(`{"status":"incomplete","output_text":"partial"}`), false); err == nil {
		t.Fatal("partial response can settle as success")
	}
	if err := ValidateResponsesProviderResult([]byte("event: response.output_text.delta\ndata: {\"delta\":\"partial\"}\n\n"), true); err == nil {
		t.Fatal("broken stream can settle as success")
	}
	if err := ValidateResponsesProviderResult([]byte(`{"status":"completed","output_text":"OK"}`), false); err != nil {
		t.Fatal(err)
	}
}

func TestResponsesContractAdminTestMatchesGeneration(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, db := newChannelModelTestService(t)
	s.coordinator = platform.NewCoordinatorWithRedis(nil, "responses-test")
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if !strings.HasSuffix(r.URL.Path, "/responses") {
			t.Errorf("test used default instead of actual route: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"completed","output_text":"OK"}`)
	}))
	defer server.Close()
	channel := model.ModelChannel{ID: "test-protocol", Scope: model.ChannelScopeSystem, Enabled: true, BaseURL: server.URL, APIKey: "fixture"}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	profile := DefaultModelCapabilityConfig("chat-completion")
	profile.Protocols = &ModelProtocolConfig{Policy: ModelProtocolAuto, Supported: []string{"openai-response"}}
	_, err := s.TestAdminChannelModel(context.Background(), &model.User{Role: model.UserRoleAdmin}, channel.ID, ChannelModelRequest{ModelKey: "fixture", Capability: "text", Protocol: "chat-completion", CapabilityConfig: profile})
	if err != nil || calls != 1 {
		t.Fatalf("admin test: %v calls=%d", err, calls)
	}
}
