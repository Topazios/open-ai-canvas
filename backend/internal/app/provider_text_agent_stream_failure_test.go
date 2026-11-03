package app

import (
	"errors"
	"strings"
	"testing"
)

func TestResponsesStreamFailureMessageByEvent(t *testing.T) {
	cases := []struct {
		name    string
		stream  string
		want    string
		rawPart string
	}{
		{
			name:    "error event with known code",
			stream:  "event: error\ndata: {\"type\":\"error\",\"error\":{\"code\":\"upstream_stream_read_error\",\"message\":\"secret prompt text\"}}\n\n",
			want:    "上游网关中断了流式输出（upstream_stream_read_error），生成未完成",
			rawPart: "upstream_stream_read_error",
		},
		{
			name:    "response.failed with nested code",
			stream:  "event: response.failed\ndata: {\"response\":{\"status\":\"failed\",\"error\":{\"code\":\"gateway_concurrency_limit\"}}}\n\n",
			want:    "上游网关并发已满（gateway_concurrency_limit），生成未完成",
			rawPart: "gateway_concurrency_limit",
		},
		{
			name:    "no code",
			stream:  "event: response.failed\ndata: {\"response\":{\"status\":\"failed\"}}\n\n",
			want:    "上游 Responses 流式请求失败，生成未完成",
			rawPart: "failed",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parser := newStreamingAgentParser("responses", nil)
			parser.consume("text/event-stream", []byte(tc.stream))
			parser.flush()
			_, err := parser.result()
			if err == nil {
				t.Fatal("expected error")
			}
			var payloadErr providerPayloadError
			if !errors.As(err, &payloadErr) {
				t.Fatalf("expected providerPayloadError, got %T: %v", err, err)
			}
			if payloadErr.message != tc.want {
				t.Errorf("message = %q, want %q", payloadErr.message, tc.want)
			}
			if strings.Contains(payloadErr.message, "secret prompt") || strings.Contains(payloadErr.message, "用户提示词") {
				t.Errorf("message echoed upstream body: %q", payloadErr.message)
			}
			if !strings.Contains(payloadErr.raw, tc.rawPart) {
				t.Errorf("raw lost original payload: %q", payloadErr.raw)
			}
		})
	}
}

func TestResponsesStreamFailureMessageCodes(t *testing.T) {
	cases := []struct {
		name    string
		payload map[string]interface{}
		want    string
	}{
		{
			name:    "unknown safe code is appended",
			payload: map[string]interface{}{"error": map[string]interface{}{"code": "server_error"}},
			want:    "上游 Responses 流式请求失败（server_error），生成未完成",
		},
		{
			name:    "unsafe code is not echoed",
			payload: map[string]interface{}{"error": map[string]interface{}{"code": "Bad Code: 用户提示词"}},
			want:    "上游 Responses 流式请求失败，生成未完成",
		},
		{
			name:    "too long code is not echoed",
			payload: map[string]interface{}{"error": map[string]interface{}{"code": strings.Repeat("a", 65)}},
			want:    "上游 Responses 流式请求失败，生成未完成",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := responsesStreamFailureMessage(tc.payload); got != tc.want {
				t.Errorf("message = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestIsKnownGatewayStreamFailure(t *testing.T) {
	known := map[string]interface{}{"error": map[string]interface{}{"code": "upstream_stream_read_error"}}
	other := map[string]interface{}{"error": map[string]interface{}{"code": "insufficient_quota"}}
	if !isKnownGatewayStreamFailure("error", known) {
		t.Error("known gateway code on error event should match")
	}
	if isKnownGatewayStreamFailure("response.output_text.delta", known) {
		t.Error("non failure event should not match")
	}
	if isKnownGatewayStreamFailure("error", other) {
		t.Error("other codes must keep the original classification")
	}
}
