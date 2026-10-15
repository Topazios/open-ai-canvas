package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func TestModelProtocolSelection(t *testing.T) {
	registry := loadOfficialFallbackRegistry()
	tests := []struct {
		name, primary, capability string
		config                    *ModelProtocolConfig
		agent                     bool
		want                      string
		fail                      bool
	}{
		{name: "legacy chat agent", primary: "chat-completion", capability: "text", agent: true, want: "chat-completion"},
		{name: "no guessed responses", primary: "kimi-chat", capability: "text", agent: true, want: "kimi-chat"},
		{name: "agent prefers declared responses", primary: "a6api-chat", capability: "text", agent: true, config: &ModelProtocolConfig{Policy: ModelProtocolAuto, Supported: []string{"a6api-chat", "openai-response"}}, want: "openai-response"},
		{name: "ordinary text prefers declared responses", primary: "chat-completion", capability: "text", config: &ModelProtocolConfig{Policy: ModelProtocolAuto, Supported: []string{"openai-response"}}, want: "openai-response"},
		{name: "ordinary text fixed keeps default", primary: "chat-completion", capability: "text", config: &ModelProtocolConfig{Policy: ModelProtocolFixed, Supported: []string{"openai-response"}}, want: "chat-completion"},
		{name: "fixed overrides preference", primary: "chat-completion", capability: "text", agent: true, config: &ModelProtocolConfig{Policy: ModelProtocolFixed, Supported: []string{"openai-response"}}, want: "chat-completion"},
		{name: "wrong modality", primary: "chat-completion", capability: "text", config: &ModelProtocolConfig{Policy: ModelProtocolAuto, Supported: []string{"openai-image"}}, fail: true},
		{name: "unknown is not guessed", primary: "missing-plugin", capability: "text", fail: true},
		{name: "invalid strategy", primary: "chat-completion", capability: "text", config: &ModelProtocolConfig{Policy: "random"}, fail: true},
		{name: "media retains adapter", primary: "openai-image", capability: "image", want: "openai-image"},
		{name: "media cannot tool call", primary: "openai-image", capability: "image", agent: true, fail: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := selectModelProtocol(registry, tc.capability, tc.primary, tc.config, tc.agent)
			if (err != nil) != tc.fail || (!tc.fail && got != tc.want) {
				t.Fatalf("got %q, %v; want %q fail=%v", got, err, tc.want, tc.fail)
			}
		})
	}
}

func TestModelProtocolWorkflowKeepsIndependentExecutor(t *testing.T) {
	input := map[string]any{"mode": "image", "config": map[string]any{"interfaceType": "runninghub-workflow-image", "channelId": "local-workflow", "selectedProtocol": "openai-image"}}
	if err := (&Service{}).pinTaskModelProtocol(input); err != nil {
		t.Fatal(err)
	}
	config := input["config"].(map[string]any)
	if config["interfaceType"] != "runninghub-workflow-image" || config["selectedProtocol"] != nil {
		t.Fatalf("workflow altered: %v", config)
	}
}

func TestModelProtocolTaskPinsServerDeclaration(t *testing.T) {
	s, db := newChannelModelTestService(t)
	channel := model.ModelChannel{ID: "protocol-channel", Scope: model.ChannelScopeSystem, Enabled: true, BaseURL: "https://example.com", APIKey: "test-only"}
	profile := DefaultModelCapabilityConfig("chat-completion")
	profile.Protocols = &ModelProtocolConfig{Policy: ModelProtocolAuto, Supported: []string{"openai-response"}}
	item := model.ChannelModel{ID: "protocol-model", ChannelID: channel.ID, ModelKey: "test-model", Enabled: true, Protocol: model.ChannelInterfaceChatCompletion, Capability: "text", CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, profile)}
	for _, value := range []any{&channel, &item} {
		if err := db.Create(value).Error; err != nil {
			t.Fatal(err)
		}
	}
	input := map[string]any{"mode": "text", "agentRequests": map[string]any{}, "config": map[string]any{"channelId": channel.ID, "model": item.ModelKey, "interfaceType": "claude-api", "selectedProtocol": "claude-api"}}
	if err := s.pinTaskModelProtocol(input); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(input["config"])
	var config providerConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	if config.SelectedProtocol != "openai-response" {
		t.Fatalf("client overrode server selection: %+v", config)
	}
	// A later default change must not send an admitted task to another endpoint.
	if err := db.Model(&item).Updates(map[string]any{"protocol": "claude-api", "capability_config_json": mustEncodeModelCapabilityConfig(t, DefaultModelCapabilityConfig("claude-api"))}).Error; err != nil {
		t.Fatal(err)
	}
	resolved, err := s.resolveProviderConfig(config)
	if err != nil || resolved.InterfaceType != "openai-response" || resolved.Model != item.ModelKey {
		t.Fatalf("pinned resolution: %+v %v", resolved, err)
	}
	config.SelectedProtocol = "missing-plugin"
	if _, err := s.resolveProviderConfig(config); err == nil {
		t.Fatal("missing pinned adapter silently fell back")
	}
}

func TestModelProtocolBatchPreservesLimitsAndRejectsInvalidSupport(t *testing.T) {
	s, db := newChannelModelTestService(t)
	channel := model.ModelChannel{ID: "protocol-batch", Scope: model.ChannelScopeSystem, Enabled: true}
	profile := DefaultModelCapabilityConfig("chat-completion")
	profile.Text.ContextWindowTokens = 256000
	item := model.ChannelModel{ID: "protocol-batch-model", ChannelID: channel.ID, ModelKey: "test", Enabled: true, Capability: "text", Protocol: model.ChannelInterfaceChatCompletion, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, profile)}
	for _, value := range []any{&channel, &item} {
		if err := db.Create(value).Error; err != nil {
			t.Fatal(err)
		}
	}
	capability, primary := "text", "chat-completion"
	request := AdminChannelModelBatchSettingsRequest{ModelIDs: []string{item.ID}, Capability: &capability, Protocol: &primary, Protocols: &ModelProtocolConfig{Policy: ModelProtocolAuto, Supported: []string{"openai-response"}}}
	actor := &model.User{Role: model.UserRoleAdmin}
	if count, err := s.UpdateAdminChannelModelsSettings(actor, channel.ID, request); err != nil || count != 1 {
		t.Fatalf("batch result: %d %v", count, err)
	}
	var stored model.ChannelModel
	if err := db.First(&stored, "id = ?", item.ID).Error; err != nil {
		t.Fatal(err)
	}
	decoded, err := normalizedChannelModelCapability(&stored)
	if err != nil || decoded.Text.ContextWindowTokens != 256000 || decoded.Protocols == nil || decoded.Protocols.Supported[0] != "openai-response" {
		t.Fatalf("lost limits or support: %+v %v", decoded, err)
	}
	request.Protocols.Supported = []string{"openai-image"}
	if _, err := s.UpdateAdminChannelModelsSettings(actor, channel.ID, request); err == nil {
		t.Fatal("cross-modality support accepted")
	}
	var unchanged model.ChannelModel
	if err := db.First(&unchanged, "id = ?", item.ID).Error; err != nil {
		t.Fatal(err)
	}
	if unchanged.CapabilityConfigJSON != stored.CapabilityConfigJSON {
		t.Fatal("failed batch partially saved")
	}
}

func TestModelProtocolResponsesRequestUsesSelectedEndpoint(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path != "/gateway/v2/responses" || body["input"] == nil || body["messages"] != nil || body["model"] != "test-model" {
			t.Errorf("wrong wire request %s: %v", r.URL.Path, body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1}}`))
	}))
	defer server.Close()
	registry := loadOfficialFallbackRegistry()
	selected, err := selectModelProtocol(registry, "text", "a6api-chat", &ModelProtocolConfig{Policy: ModelProtocolAuto, Supported: []string{"openai-response"}}, true)
	if err != nil {
		t.Fatal(err)
	}
	result, err := runAgentToolTask(withProtocolRegistry(context.Background(), registry), canvasGenerationInput{Mode: "text", Config: providerConfig{InterfaceType: selected, BaseURL: server.URL + "/gateway/v2", APIKey: "test-only", Model: "test-model"}, AgentRequests: &agentToolRequests{Canonical: &canonicalAgentRequest{Messages: []map[string]any{{"role": "user", "content": "test"}}, ToolChoice: "auto"}}})
	if err != nil || stringValue(result["text"]) != "ok" || requests != 1 {
		t.Fatalf("response=%v error=%v requests=%d", result, err, requests)
	}
}

func TestModelProtocolVersionURLs(t *testing.T) {
	tests := []struct{ base, path, want string }{
		{"https://example.com", "/responses", "https://example.com/v1/responses"},
		{"https://example.com/proxy/v2/?tenant=one", "/responses?mode=test", "https://example.com/proxy/v2/responses?mode=test&tenant=one"},
		{"https://example.com/api/v4", "/images/generations", "https://example.com/api/v4/images/generations"},
		{"https://example.com/v1?x=old", "/v2/jobs?x=new", "https://example.com/v2/jobs?x=new"},
		{"https://example.com/proxy", "/v1/responses", "https://example.com/proxy/v1/responses"},
		{"https://example.com/v1beta", "/models/m:generateContent", "https://example.com/v1beta/models/m:generateContent"},
		{"https://example.com/proxy%20path/v2", "/responses", "https://example.com/proxy%20path/v2/responses"},
	}
	for _, tc := range tests {
		if got := ChannelAPIURL(tc.base, tc.path); got != tc.want {
			t.Errorf("%s + %s = %s, want %s", tc.base, tc.path, got, tc.want)
		}
	}
	got, err := protocolRequestURLForAdapter(providerConfig{InterfaceType: "kimi-chat", BaseURL: "https://example.com/api/v3"}, protocol.RequestSpec{Path: "/v1/chat/completions"})
	if err != nil || got != "https://example.com/api/v3/chat/completions" {
		t.Fatalf("standard adapter default version: %s %v", got, err)
	}
	got, err = protocolRequestURLForAdapter(providerConfig{InterfaceType: "custom-plugin", BaseURL: "https://example.com/v1"}, protocol.RequestSpec{Path: "/v2/tasks"})
	if err != nil || got != "https://example.com/v2/tasks" {
		t.Fatalf("explicit plugin version: %s %v", got, err)
	}
}

func TestModelProtocolResponsesPlainTextAndErrors(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, stream := range []bool{false, true} {
		for _, failure := range []bool{false, true} {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.URL.Path != "/v1/responses" {
					t.Errorf("unexpected fallback to %s", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				if failure {
					w.WriteHeader(503)
					_, _ = w.Write([]byte(`{"error":{"message":"fixture unavailable"}}`))
					return
				}
				_, _ = w.Write([]byte(`{"output":[{"type":"message","content":[{"type":"output_text","text":"plain text"}]}],"usage":{"input_tokens":2,"output_tokens":3}}`))
			}))
			result, err := runTextTask(withProtocolRegistry(context.Background(), loadOfficialFallbackRegistry()), canvasGenerationInput{Mode: "text", Prompt: "test", StreamText: stream, Config: providerConfig{BaseURL: server.URL, Model: "test", APIKey: "fixture", InterfaceType: "openai-response"}})
			server.Close()
			if requests != 1 || (err != nil) != failure {
				t.Fatalf("stream=%v failure=%v requests=%d error=%v", stream, failure, requests, err)
			}
			if !failure && stringValue(result["text"]) != "plain text" {
				t.Fatalf("text lost: %v", result)
			}
		}
	}
}
