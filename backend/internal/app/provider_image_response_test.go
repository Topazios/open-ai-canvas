package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func imageResponseRequest(t *testing.T, ctx context.Context, url string) *http.Request {
	t.Helper()
	ctx = context.WithValue(ctx, providerAnalyticsKey{}, providerAnalyticsContext{Capability: "image"})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	return req
}

func TestImageResponseProgressOutlivesRequestTimeout(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	const idle = 300 * time.Millisecond
	payload := `{"data":[{"b64_json":"` + strings.Repeat("YWJj", 4096) + `"}]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		for start := 0; start < len(payload); start += 2048 {
			end := min(start+2048, len(payload))
			if _, err := io.WriteString(w, payload[start:end]); err != nil {
				return
			}
			w.(http.Flusher).Flush()
			select {
			case <-r.Context().Done():
				return
			case <-time.After(80 * time.Millisecond):
			}
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	started := time.Now()
	resp, err := doProviderHTTPRequest(imageResponseRequest(t, ctx, server.URL), idle)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("progressing response interrupted: %v", err)
	}
	if string(got) != payload || !json.Valid(got) {
		t.Fatal("partial image response accepted")
	}
	if time.Since(started) <= idle {
		t.Fatal("fixture did not exceed the former absolute limit")
	}
}

func TestImageResponseCompleteJSONDoesNotWaitForEOFWhenContentTypeIsNotJSON(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	const payload = `{"data":[{"url":"https://cdn.example/image.png"}]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, payload)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()

	started := time.Now()
	req := imageResponseRequest(t, context.Background(), server.URL)
	data, _, err := doBinaryWithConsumer(req, nil)
	if err != nil {
		t.Fatalf("complete JSON response failed while waiting for EOF: %v", err)
	}
	if string(data) != payload {
		t.Fatalf("response = %q, want %q", data, payload)
	}
	if elapsed := time.Since(started); elapsed >= time.Second {
		t.Fatalf("waited %s for a response that was already complete", elapsed)
	}
}

func TestImageResponseSilenceAndTaskCancellation(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, mode := range []string{"no-headers", "empty-body", "partial-body", "task-deadline", "user-cancel"} {
		t.Run(mode, func(t *testing.T) {
			const idle = 200 * time.Millisecond
			const partial = `{"data":[{"b64_json":"YWJj`
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode != "no-headers" {
					w.Header().Set("Content-Type", "application/json")
					if mode != "empty-body" {
						_, _ = io.WriteString(w, partial)
					}
					w.(http.Flusher).Flush()
				}
				<-r.Context().Done()
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if mode == "task-deadline" {
				ctx, cancel = context.WithTimeout(ctx, 80*time.Millisecond)
				defer cancel()
			}
			resp, err := doProviderHTTPRequest(imageResponseRequest(t, ctx, server.URL), idle)
			if mode == "user-cancel" {
				cancel()
			}
			if err == nil {
				defer resp.Body.Close()
				_, err = io.ReadAll(resp.Body)
			}
			if err == nil {
				t.Fatal("incomplete response treated as success")
			}
			var timeoutErr providerRequestTimeoutError
			if mode == "task-deadline" || mode == "user-cancel" {
				want := context.DeadlineExceeded
				if mode == "user-cancel" {
					want = context.Canceled
				}
				if !errors.Is(err, want) || errors.As(err, &timeoutErr) {
					t.Fatalf("parent cancellation changed: %v", err)
				}
				return
			}
			if !errors.As(err, &timeoutErr) {
				t.Fatalf("lost request timeout source: %v", err)
			}
			if timeoutErr.receiving != (mode != "no-headers") {
				t.Fatalf("wrong timeout phase: %#v", timeoutErr)
			}
			if mode == "partial-body" && timeoutErr.receivedBytes != int64(len(partial)) {
				t.Fatal("lost received byte count")
			}
			code, _ := providerRequestErrorDetails(err)
			wantCode := "provider_response_read_timeout"
			if mode == "no-headers" {
				wantCode = "provider_request_timeout"
			}
			if code != wantCode {
				t.Fatalf("code=%s want=%s", code, wantCode)
			}
		})
	}
}

func TestImageResponseTimeoutDiagnosticKeepsReceivePhase(t *testing.T) {
	cause := providerRequestTimeoutError{timeout: 300 * time.Second, cause: context.DeadlineExceeded, receiving: true, receivedBytes: 8192}
	if got := preserveProviderRequestTimeout(cause, context.Background(), time.Minute); got != cause {
		t.Fatal("typed receive timeout replaced by a generic request timeout")
	}
	task := &model.Task{ID: "receive-test", Status: model.TaskStatusFailed, Error: cause.Error()}
	recordTaskDiagnostic(task, "execution", "provider_execution_failed", "unknown", "reconcile_submission", cause)
	diagnostic := taskExecutionDiagnostic(task)
	if diagnostic.Code != "provider_response_read_timeout" || diagnostic.RetryClass != "reconcile_submission" || diagnostic.SubmissionOutcome != "unknown" {
		t.Fatalf("receive evidence or retry protection lost: %#v", diagnostic)
	}
	if !strings.Contains(diagnostic.SafeMessage, "8192 字节") || !strings.Contains(diagnostic.SafeMessage, "结果不完整") {
		t.Fatalf("receive timeout hidden: %s", diagnostic.SafeMessage)
	}
}
