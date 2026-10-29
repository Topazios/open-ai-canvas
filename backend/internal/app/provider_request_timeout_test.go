package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
)

func TestProviderRequestTimeoutIsDistinctFromTaskDeadline(t *testing.T) {
	live, cancelLive := context.WithCancel(context.Background())
	defer cancelLive()
	requestErr := preserveProviderRequestTimeout(context.DeadlineExceeded, live, 5*time.Minute)
	var timeoutErr providerRequestTimeoutError
	if !errors.As(requestErr, &timeoutErr) {
		t.Fatalf("live task context should preserve the HTTP client's timeout source: %T %v", requestErr, requestErr)
	}
	if status, source := providerRequestFailureOutcome(0, requestErr); status != model.ApiCallStatusWarning || source != "application" {
		t.Fatalf("local request timeout was misattributed: status=%s source=%s", status, source)
	}
	code, message := providerRequestErrorDetails(requestErr)
	if code != "provider_request_timeout" || !strings.Contains(message, "5m0s") {
		t.Fatalf("request timeout details = (%q, %q)", code, message)
	}

	expired, cancelExpired := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancelExpired()
	taskErr := preserveProviderRequestTimeout(context.DeadlineExceeded, expired, 5*time.Minute)
	if errors.As(taskErr, &timeoutErr) {
		t.Fatalf("expired task context must remain a task deadline, got %v", taskErr)
	}
}

func TestProviderRequestTransportUsesSavedTimeout(t *testing.T) {
	t.Setenv("REDIS_URL", "")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	// Observe the deadline on the real HTTP request, without waiting minutes or
	// calling a paid model. These subtests must remain serial: transport is shared.
	transport := OutboundHTTPClient(0).Transport.(*http.Transport)
	originalProxy := transport.Proxy
	t.Cleanup(func() { transport.Proxy = originalProxy })
	for _, tc := range []struct {
		name    string
		seconds int
		parent  time.Duration
		want    time.Duration
	}{
		{"configured-95-seconds", 95, 20 * time.Minute, 95 * time.Second},
		{"configured-600-seconds-exceeds-old-cap", 600, 20 * time.Minute, 10 * time.Minute},
		{"task-deadline-still-caps-request", 600, 45 * time.Second, 45 * time.Second},
		{"legacy-policy-inherits-default", 0, 20 * time.Minute, time.Duration(defaultRuntimePolicy().Task.ProviderRequestTimeoutSeconds) * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			var err error
			s.coordinator, err = platform.NewCoordinator("sqlite")
			if err != nil {
				t.Fatal(err)
			}
			s.platform = platform.New(s.repo, s.coordinator, platformHost{svc: s})
			policy := defaultRuntimePolicy()
			policy.Task.ProviderRequestTimeoutSeconds = tc.seconds
			encoded, err := json.Marshal(policy)
			if err != nil {
				t.Fatal(err)
			}
			if tc.seconds == 0 {
				var legacy map[string]any
				if err := json.Unmarshal(encoded, &legacy); err != nil {
					t.Fatal(err)
				}
				delete(legacy["task"].(map[string]any), "providerRequestTimeoutSeconds")
				encoded, err = json.Marshal(legacy)
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Save(&model.SystemSetting{Key: runtimePolicySettingKey, ValueJSON: string(encoded)}).Error; err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"data":[]}`))
			}))
			defer server.Close()
			observed := make(chan time.Duration, 1)
			transport.Proxy = func(req *http.Request) (*url.URL, error) {
				deadline, ok := req.Context().Deadline()
				if !ok {
					observed <- 0
				} else {
					observed <- time.Until(deadline)
				}
				return originalProxy(req)
			}
			ctx, cancel := context.WithTimeout(context.Background(), tc.parent)
			defer cancel()
			ctx = context.WithValue(ctx, providerAnalyticsKey{}, providerAnalyticsContext{Service: s, UserID: "user", Capability: "text", RequestKind: "create", Model: "fixture"})
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/images/generations", strings.NewReader(`{"prompt":"fixture"}`))
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := doBinary(req); err != nil {
				t.Fatal(err)
			}
			select {
			case got := <-observed:
				if got < tc.want-time.Second || got > tc.want {
					t.Fatalf("HTTP request deadline = %s, want approximately %s", got, tc.want)
				}
			default:
				t.Fatal("HTTP transport was not reached")
			}
		})
	}
}
