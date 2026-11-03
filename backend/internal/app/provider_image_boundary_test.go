package app

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
)

func TestOpenAIImageRejectsInvalidSizeBeforeSubmission(t *testing.T) {
	for _, size := range []string{"banana", "7:0", "0x1024", "-1x1024", "4097x1024", "1024x5000"} {
		t.Run(size, func(t *testing.T) {
			_, err := runImageTask(context.Background(), canvasGenerationInput{Mode: "image", Config: providerConfig{InterfaceType: "openai-image", BaseURL: "https://api.ddcat.pronhubcn.com/v1", Size: size}})
			if err == nil || !strings.Contains(err.Error(), "尺寸") {
				t.Fatalf("expected local size rejection: %v", err)
			}
		})
	}
	for _, size := range []string{"", "auto", "1:1", "16:9", "1024x1024", "4096x4096"} {
		if err := validateOpenAIImageInput(canvasGenerationInput{Config: providerConfig{Size: size}}); err != nil {
			t.Fatalf("valid size %q: %v", size, err)
		}
	}
}

func TestOpenAIImageRejectsMaskWithoutSourceBeforePlugin(t *testing.T) {
	_, err := runImageTask(context.Background(), canvasGenerationInput{Mode: "image", Config: providerConfig{InterfaceType: "openai-image"}, Mask: &providerMedia{ID: "mask"}})
	if err == nil || !strings.Contains(err.Error(), "源图片") {
		t.Fatalf("expected missing source rejection: %v", err)
	}
}

func TestProviderConnectionErrorPreservesCause(t *testing.T) {
	resetText := errors.New("read tcp 192.168.1.48:1857->154.36.158.195:443: wsarecv: An existing connection was forcibly closed by the remote host.")
	for _, cause := range []error{io.EOF, io.ErrUnexpectedEOF, syscall.Errno(10054), syscall.ECONNRESET, resetText} {
		err := providerConnectionError(cause)
		if !errors.Is(err, cause) || !strings.Contains(err.Error(), "扣费记录") {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if !strings.Contains(providerConnectionError(resetText).Error(), "连接被重置") {
		t.Fatal("reset text must be classified as connection reset")
	}
	if providerConnectionError(context.Canceled) != context.Canceled {
		t.Fatal("cancellation must remain unchanged")
	}
}

func TestImageSubmissionEOFIsNotAutomaticallyReplayed(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		conn.Close()
	}))
	defer server.Close()
	err := postJSON(context.Background(), providerConfig{BaseURL: server.URL}, "/v1/images/generations", map[string]string{"prompt": "cup"}, &map[string]interface{}{})
	if err == nil || !strings.Contains(err.Error(), "连接提前关闭") || calls != 1 {
		t.Fatalf("calls=%d error=%v", calls, err)
	}
}
