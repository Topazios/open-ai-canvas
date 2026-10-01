package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRunTextTaskUsesStructuredOutputForChatAndResponses(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	schema := map[string]interface{}{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []interface{}{"items"},
		"properties": map[string]interface{}{
			"items": map[string]interface{}{"type": "array"},
		},
	}
	strict := true

	for _, testCase := range []struct {
		name          string
		interfaceType string
		path          string
		response      string
		assertBody    func(*testing.T, map[string]interface{})
	}{
		{
			name:          "chat completions",
			interfaceType: "chat-completion",
			path:          "/v1/chat/completions",
			response:      `{"choices":[{"message":{"content":"{\"items\":[]}"}}]}`,
			assertBody: func(t *testing.T, body map[string]interface{}) {
				format, ok := body["response_format"].(map[string]interface{})
				if !ok || format["type"] != "json_schema" {
					t.Fatalf("response_format = %#v", body["response_format"])
				}
				jsonSchema, ok := format["json_schema"].(map[string]interface{})
				if !ok || jsonSchema["name"] != "asset_inventory" || jsonSchema["strict"] != true {
					t.Fatalf("json_schema = %#v", format["json_schema"])
				}
				if body["stream"] != true || body["max_tokens"] != float64(8192) {
					t.Fatalf("stream/max_tokens = %#v/%#v", body["stream"], body["max_tokens"])
				}
			},
		},
		{
			name:          "responses",
			interfaceType: "openai-response",
			path:          "/v1/responses",
			response:      `{"output_text":"{\"items\":[]}"}`,
			assertBody: func(t *testing.T, body map[string]interface{}) {
				text, ok := body["text"].(map[string]interface{})
				if !ok {
					t.Fatalf("text = %#v", body["text"])
				}
				format, ok := text["format"].(map[string]interface{})
				if !ok || format["type"] != "json_schema" || format["name"] != "asset_inventory" {
					t.Fatalf("text.format = %#v", text["format"])
				}
				if body["stream"] != true || body["max_output_tokens"] != float64(8192) {
					t.Fatalf("stream/max_output_tokens = %#v/%#v", body["stream"], body["max_output_tokens"])
				}
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != testCase.path {
					t.Fatalf("path = %q, want %q", r.URL.Path, testCase.path)
				}
				var body map[string]interface{}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatalf("decode request: %v", err)
				}
				testCase.assertBody(t, body)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(testCase.response))
			}))
			defer server.Close()

			result, err := runTextTask(context.Background(), canvasGenerationInput{
				Mode:             "text",
				Prompt:           "分析 Note",
				StreamText:       true,
				MaxOutputTokens:  8192,
				Config: providerConfig{
					BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "test-model",
					InterfaceType: testCase.interfaceType,
				},
				TextOptions: canvasTextOptions{StructuredOutput: &StructuredTextOutput{Name: "asset_inventory", Schema: schema, Strict: &strict}},
			})
			if err != nil {
				t.Fatal(err)
			}
			if result["text"] == "" {
				t.Fatalf("result = %#v", result)
			}
		})
	}
}
