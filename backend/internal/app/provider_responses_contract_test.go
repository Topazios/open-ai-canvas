package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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

func TestDeclarativeResponsesPollsUntilTextIsComplete(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/responses":
			fmt.Fprint(w, `{"id":"resp_async_1","status":"in_progress"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/responses/resp_async_1":
			fmt.Fprint(w, `{"id":"resp_async_1","status":"completed","output_text":"completed episode"}`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	registry := loadOfficialFallbackRegistry()
	adapter, ok := registry.Resolve("openai-response")
	if !ok {
		t.Fatal("official OpenAI Responses adapter is unavailable")
	}
	policy := declarativeProtocolPollPolicy("text")
	policy.InitialDelay = 0
	policy.Interval = 0
	policy.Sleep = func(context.Context, time.Duration) error { return nil }
	result, err := runProtocolAdapterTaskWithPolicy(context.Background(), canvasGenerationInput{
		Mode: "text", Prompt: "write an episode", Config: providerConfig{InterfaceType: "openai-response", Model: "gpt-test", BaseURL: server.URL, APIKey: "fixture"},
	}, adapter, policy)
	if err != nil || result["text"] != "completed episode" {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
}

func TestDeclarativeResponsesAgentPollsExistingResponse(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var creates, polls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/responses":
			creates++
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["stream"] != true || body["background"] != nil || body["store"] != false {
				t.Errorf("Responses Agent should stream without enabling background/storage: %#v", body)
			}
			fmt.Fprint(w, `{"id":"resp_agent_async_1","status":"in_progress"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/v1/responses/resp_agent_async_1":
			polls++
			fmt.Fprint(w, `{"id":"resp_agent_async_1","status":"completed","output_text":"completed plan","output":[{"type":"message","status":"completed","content":[{"type":"output_text","text":"completed plan"}]}]}`)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	var streamed strings.Builder
	ctx := withProtocolRegistry(context.Background(), loadOfficialFallbackRegistry())
	result, err := runAgentToolTask(ctx, canvasGenerationInput{
		Config:        providerConfig{InterfaceType: "openai-response", Model: "gpt-test", BaseURL: server.URL, APIKey: "fixture"},
		AgentRequests: &agentToolRequests{Responses: map[string]any{"input": []any{}}},
		StreamText:    true,
		OnTextDelta:   func(delta string) { _, _ = streamed.WriteString(delta) },
	})
	if err != nil || result["text"] != "completed plan" || streamed.String() != "completed plan" {
		t.Fatalf("result = %#v, streamed = %q, error = %v", result, streamed.String(), err)
	}
	if creates != 1 || polls != 1 {
		t.Fatalf("expected one create and one poll for the same response, got creates=%d polls=%d", creates, polls)
	}
}

func TestDeclarativeResponsesAgentUsesSynchronousRequestByDefault(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var creates int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		creates++
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if body["background"] != nil || body["store"] != false || body["stream"] == true {
			t.Errorf("Responses Agent request should use the synchronous-compatible form: %#v", body)
		}
		fmt.Fprint(w, `{"id":"resp_sync_1","status":"completed","output_text":"completed plan","output":[{"type":"message","status":"completed","content":[{"type":"output_text","text":"completed plan"}]}]}`)
	}))
	defer server.Close()

	result, err := runAgentToolTask(withProtocolRegistry(context.Background(), loadOfficialFallbackRegistry()), canvasGenerationInput{
		Config:        providerConfig{InterfaceType: "openai-response", Model: "gpt-test", BaseURL: server.URL, APIKey: "fixture"},
		AgentRequests: &agentToolRequests{Responses: map[string]any{"input": []any{}}},
	})
	if err != nil || result["text"] != "completed plan" || creates != 1 {
		t.Fatalf("result = %#v, error = %v, creates = %d", result, err, creates)
	}
}

func TestDeclarativeResponsesAgentStreamsTextAndToolCalls(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var deltas strings.Builder
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if body["stream"] != true || body["background"] != nil {
			t.Errorf("Responses Agent should stream synchronously: %#v", body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("test server does not support streaming")
		}
		fmt.Fprint(w, "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"draft\"}\n\n")
		flusher.Flush()
		fmt.Fprint(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"status\":\"completed\",\"content\":[{\"type\":\"output_text\",\"text\":\"draft\"}]},{\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call-1\",\"name\":\"production_submit\",\"arguments\":\"{\\\"key\\\":\\\"story\\\"}\"}]}}\n\n")
		flusher.Flush()
	}))
	defer server.Close()

	ctx := withProtocolRegistry(context.Background(), loadOfficialFallbackRegistry())
	result, err := runAgentToolTask(ctx, canvasGenerationInput{
		Config: providerConfig{InterfaceType: "openai-response", Model: "fixture", BaseURL: server.URL, APIKey: "fixture"},
		AgentRequests: &agentToolRequests{Responses: map[string]any{
			"input":       []any{map[string]any{"role": "user", "content": "generate"}},
			"tools":       []any{map[string]any{"type": "function", "name": "production_submit", "parameters": map[string]any{"type": "object", "properties": map[string]any{}}}},
			"tool_choice": "auto",
		}},
		StreamText:  true,
		OnTextDelta: func(text string) { deltas.WriteString(text) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if deltas.String() != "draft" || result["text"] != "draft" || len(interfaceSlice(result["toolCalls"])) != 1 {
		t.Fatalf("stream result = %#v, deltas = %q", result, deltas.String())
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
	s, db, _, _ := creationTestService(t)
	s.coordinator = platform.NewCoordinatorWithRedis(nil, "responses-test")
	s.platform = platform.New(s.repo, s.coordinator, platformHost{svc: s})
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
	_, err := s.TestAdminChannelModel(context.Background(), &model.User{ID: "user", Role: model.UserRoleAdmin}, channel.ID, ChannelModelRequest{ModelKey: "fixture", Capability: "text", Protocol: "chat-completion", CapabilityConfig: profile})
	if err != nil || calls != 1 {
		t.Fatalf("admin test: %v cause=%s calls=%d", err, cloudAgentInnermostMessage(err), calls)
	}
}
