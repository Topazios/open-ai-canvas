package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
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
