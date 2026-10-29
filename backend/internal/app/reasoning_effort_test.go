package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReasoningEffortActualTextAndAgentRequests(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, wire := range []string{"openai-response", "chat-completion"} {
		for _, effort := range []ReasoningEffort{ReasoningLow, ReasoningHigh} {
			t.Run(wire+"/"+string(effort), func(t *testing.T) {
				calls := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						return
					}
					got := body["reasoning_effort"]
					response := `{"choices":[{"message":{"content":"ok","tool_calls":[]}}]}`
					if wire == "openai-response" {
						reasoning, _ := body["reasoning"].(map[string]any)
						got = reasoning["effort"]
						response = `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}`
					}
					if got != string(effort) {
						t.Errorf("wire lost preference: %#v", body)
					}
					if wire == "chat-completion" && body["tool_choice"] != nil {
						t.Errorf("reasoning request retained forced tool choice: %#v", body["tool_choice"])
					}
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, response)
				}))
				defer server.Close()
				input := canvasGenerationInput{Mode: "text", Prompt: "fixture", Config: providerConfig{InterfaceType: wire, Model: "fixture", BaseURL: server.URL, APIKey: "fixture"}, TextOptions: canvasTextOptions{ReasoningEffort: effort}}
				ctx := withProtocolRegistry(context.Background(), loadOfficialFallbackRegistry())
				if result, err := runTextTask(ctx, input); err != nil || result["text"] != "ok" {
					t.Fatalf("text: %v %v", result, err)
				}
				input.AgentRequests = &agentToolRequests{ChatCompletion: map[string]any{"messages": []any{}, "tool_choice": "required"}, Responses: map[string]any{"input": []any{}}}
				if result, err := runAgentToolTask(ctx, input); err != nil || result["text"] != "ok" {
					t.Fatalf("Agent: %v %v", result, err)
				}
				if calls != 2 {
					t.Fatalf("unexpected request count: %d", calls)
				}
			})
		}
	}
}

func TestReasoningEffortDefaultsAndProtocolMapping(t *testing.T) {
	for _, effort := range []ReasoningEffort{"", ReasoningLow, ReasoningMedium, ReasoningHigh} {
		t.Run(string(effort), func(t *testing.T) {
			input := canvasGenerationInput{TextOptions: canvasTextOptions{ReasoningEffort: effort}}
			for _, wire := range []string{"responses", "chat-completion"} {
				body := map[string]any{}
				applyTextThinking(body, input, wire)
				got := body["reasoning_effort"]
				if wire == "responses" {
					got = body["reasoning"].(map[string]any)["effort"]
				}
				if got != string(effort.effective()) {
					t.Fatalf("%s: %#v", wire, body)
				}
				input.TextOptions.ReasoningDisabled = true
				applyTextThinking(body, input, wire)
				if wire == "responses" {
					reasoning, _ := body["reasoning"].(map[string]any)
					if reasoning["effort"] != "none" || len(reasoning) != 1 {
						t.Fatalf("recovery did not explicitly disable reasoning: %#v", body)
					}
				} else if len(body) != 0 {
					t.Fatalf("recovery retained reasoning: %#v", body)
				}
				input.TextOptions.ReasoningDisabled = false
			}
		})
	}
}

func TestReasoningEffortAdmissionAndBatchPersistence(t *testing.T) {
	for _, effort := range []any{"low", "medium", "high", nil} {
		options := map[string]any{"stream": false}
		if effort != nil {
			options["reasoningEffort"] = effort
		}
		input, err := normalizeTaskInput(map[string]any{"mode": "text", "textOptions": options})
		if err != nil {
			t.Fatal(err)
		}
		expected := effort
		if expected == nil {
			expected = "medium"
		}
		child := workflowChildTextOptions(input)
		if child["reasoningEffort"] != expected {
			t.Fatalf("child lost preference: %#v", child)
		}
		if input["textOptions"].(map[string]any)["stream"] != false {
			t.Fatal("child mutated parent")
		}
		encoded, _ := json.Marshal(input)
		var recovered canvasGenerationInput
		if err := json.Unmarshal(encoded, &recovered); err != nil {
			t.Fatal(err)
		}
		if string(recovered.TextOptions.ReasoningEffort) != expected {
			t.Fatal("roundtrip lost preference")
		}
	}
	childWithoutLimit := workflowChildTextOptions(map[string]any{"textOptions": map[string]any{"stream": true}})
	if _, exists := childWithoutLimit["maxOutputTokens"]; exists {
		t.Fatalf("workflow child reintroduced a hidden output limit: %#v", childWithoutLimit)
	}
	childWithLimit := workflowChildTextOptions(map[string]any{"textOptions": map[string]any{"maxOutputTokens": 4096}})
	if childWithLimit["maxOutputTokens"] != 4096 {
		t.Fatalf("workflow child did not preserve explicit output limit: %#v", childWithLimit)
	}
	for _, invalid := range []any{"max", "off", 3, true} {
		if _, err := normalizeTaskInput(map[string]any{"mode": "text", "textOptions": map[string]any{"reasoningEffort": invalid}}); err == nil {
			t.Fatalf("accepted invalid effort: %#v", invalid)
		}
	}
	media, err := normalizeTaskInput(map[string]any{"mode": "image"})
	if err != nil || media["textOptions"] != nil {
		t.Fatalf("media gained text options: %#v %v", media, err)
	}
}

func TestReasoningEffortAgentDefaultsAndResume(t *testing.T) {
	if cloudAgentReasoningMode(CloudAgentRequest{}) != "auto" {
		t.Fatal("new Agent defaults to disabled")
	}
	original := cloudAgentRuntime{Request: CloudAgentRequest{ReasoningEffort: ReasoningHigh}, Policy: cloudAgentPolicySnapshot{ReasoningMode: "auto"}}
	encoded, _ := json.Marshal(original)
	var state cloudAgentRuntime
	if err := json.Unmarshal(encoded, &state); err != nil {
		t.Fatal(err)
	}
	config := (&Service{}).buildModelConfig("fixture", &state)
	if config["reasoningEffort"] != ReasoningHigh || config["reasoning"] != true {
		t.Fatalf("runtime lost preference: %#v", config)
	}
	options := agentReasoningOptions(state.Request.ReasoningEffort, false)
	if options["reasoningDisabled"] != true || options["reasoningEffort"] != ReasoningHigh {
		t.Fatalf("recovery lost captured preference: %#v", options)
	}
}

func TestReasoningEffortNativeBudgetAndMediaIsolation(t *testing.T) {
	for _, name := range []string{"claude-sonnet-4-6", "claude-opus-4.7", "claude-sonnet-5"} {
		body := map[string]any{"output_config": map[string]any{"format": "fixture"}}
		applyTextThinking(body, canvasGenerationInput{Config: providerConfig{Model: name}}, "claude-api")
		if body["thinking"].(map[string]any)["type"] != "adaptive" || body["output_config"].(map[string]any)["effort"] != "medium" || body["output_config"].(map[string]any)["format"] != "fixture" {
			t.Fatalf("invalid adaptive configuration: %#v", body)
		}
	}
	if usesClaudeAdaptiveThinking("claude-sonnet-4-5") {
		t.Fatal("old Claude should retain budget mode")
	}
	if geminiReasoningConfig("gemini-3.1-pro-preview", ReasoningMedium)["thinkingLevel"] != "MEDIUM" || geminiReasoningConfig("gemini-3-pro-preview", ReasoningMedium)["thinkingLevel"] != "HIGH" {
		t.Fatal("Gemini thinking-level mapping")
	}
	for _, effort := range []ReasoningEffort{ReasoningLow, ReasoningMedium, ReasoningHigh} {
		input := canvasGenerationInput{TextOptions: canvasTextOptions{ReasoningEffort: effort}}
		body := map[string]any{"max_tokens": 4096}
		applyTextThinking(body, input, "claude-api")
		budget := body["thinking"].(map[string]any)["budget_tokens"].(int)
		if budget < 1024 || budget >= 4096 {
			t.Fatalf("invalid Claude budget: %d", budget)
		}
		gemini := map[string]any{"generationConfig": map[string]any{"temperature": 0.5}}
		applyTextThinking(gemini, input, "gemini")
		generation := gemini["generationConfig"].(map[string]any)
		if generation["temperature"] != 0.5 || generation["thinkingConfig"] == nil {
			t.Fatalf("invalid Gemini config: %#v", gemini)
		}
		for _, wire := range []string{"openai-image", "openai-audio", "videos", "custom"} {
			media := map[string]any{}
			applyTextThinking(media, input, wire)
			if len(media) != 0 {
				t.Fatalf("reasoning leaked into %s", wire)
			}
		}
	}
}
