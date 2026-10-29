package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
)

func TestRecordProviderRequestKeepsEvidenceBasedSeverityAndSources(t *testing.T) {
	slotContext, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, slotErr := (&platform.Service{}).AcquireChannelSlot(slotContext, "fixture", "", time.Minute)
	if code, _ := ChannelSlotFailureDetails(slotErr); code == "" {
		t.Fatal("fixture lacks typed channel-slot error")
	}
	for _, tc := range []struct {
		name         string
		http         int
		body         string
		cause        error
		status       model.ApiCallStatus
		source, code string
	}{
		{"success", 200, `{"status":"completed"}`, nil, model.ApiCallStatusSucceeded, "", ""},
		{"pending", providerRequestPendingStatus, "", nil, model.ApiCallStatusRunning, "", ""},
		{"http-failure", 503, `{"error":{"code":"service_failed","message":"provider unavailable"}}`, nil, model.ApiCallStatusFailed, "upstream", "service_failed"},
		{"typed-http-no-status", 0, "", providerHTTPError{StatusCode: 429}, model.ApiCallStatusFailed, "upstream", ""},
		{"typed-payload", 200, "", fmt.Errorf("request: %w", providerPayloadError{raw: "private-provider-text", message: "provider rejected"}), model.ApiCallStatusFailed, "upstream", ""},
		{"api-error", 200, `{"error":{"code":"output_limit_exceeded","message":"provider rejected"}}`, nil, model.ApiCallStatusFailed, "upstream", "output_limit_exceeded"},
		{"network", 0, "", fmt.Errorf("request: %w", &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}), model.ApiCallStatusFailed, "network", ""},
		{"cancelled-context", 0, "", context.Canceled, model.ApiCallStatusWarning, "application", "request_cancelled"},
		{"elapsed-context", 0, "", context.DeadlineExceeded, model.ApiCallStatusWarning, "application", "upstream_timeout"},
		{"slot-cancelled", 0, "", slotErr, model.ApiCallStatusWarning, "application", "channel_concurrency_wait_cancelled"},
		{"unknown-error", 0, "", errors.New("interrupted"), model.ApiCallStatusWarning, "unknown", ""},
		{"unknown-after-headers", 200, `{"status":"in_progress"}`, errors.New("interrupted"), model.ApiCallStatusWarning, "unknown", ""},
		{"decode-error", 200, "invalid", providerResponseDecodeError{Err: errors.New("invalid response")}, model.ApiCallStatusWarning, "content", "upstream_response_invalid"},
		{"decode-no-status", 0, "invalid", providerResponseDecodeError{Err: errors.New("invalid response")}, model.ApiCallStatusWarning, "content", "upstream_response_invalid"},
		{"output-limit", 200, `{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":31,"output_tokens":16383,"output_tokens_details":{"reasoning_tokens":16383}}}`, errProviderOutputLimit, model.ApiCallStatusWarning, "content", "output_limit_exceeded"},
		{"http-over-content-error", 429, "", errProviderOutputLimit, model.ApiCallStatusFailed, "upstream", "output_limit_exceeded"},
		{"sse-error-empty", 200, "event: error\ndata:\n\n", providerResponseDecodeError{Err: errors.New("empty event")}, model.ApiCallStatusFailed, "upstream", "upstream_response_invalid"},
		{"sse-error-done", 200, "event: error\ndata: [DONE]\n\n", providerResponseDecodeError{Err: errors.New("empty event")}, model.ApiCallStatusFailed, "upstream", "upstream_response_invalid"},
		{"sse-failed-empty", 200, "event: response.failed\ndata:\n\n", errProviderOutputLimit, model.ApiCallStatusFailed, "upstream", "output_limit_exceeded"},
		{"sse-failed-done", 200, "event: response.failed\ndata: [DONE]\n\n", errProviderOutputLimit, model.ApiCallStatusFailed, "upstream", "output_limit_exceeded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			ctx := context.WithValue(context.Background(), providerAnalyticsKey{}, providerAnalyticsContext{Service: s, UserID: "user", Capability: "text", RequestKind: "create", Model: "fixture"})
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://example.invalid/v1/responses", nil)
			if err != nil {
				t.Fatal(err)
			}
			if err = recordProviderRequest(req, time.Now(), tc.http, []byte(tc.body), tc.cause); err != nil {
				t.Fatal(err)
			}
			var logs []model.ApiCallLog
			if err = db.Find(&logs).Error; err != nil {
				t.Fatal(err)
			}
			if len(logs) != 1 {
				t.Fatalf("rows=%d", len(logs))
			}
			got := logs[0]
			wantHTTP := tc.http
			if wantHTTP == providerRequestPendingStatus {
				wantHTTP = 0
			}
			if got.Status != tc.status || got.ErrorSource != tc.source || got.ErrorCode != tc.code || got.StatusCode != wantHTTP {
				t.Fatalf("wrong request attribution: status=%s source=%q code=%q http=%d", got.Status, got.ErrorSource, got.ErrorCode, got.StatusCode)
			}
			if !got.Billable || got.BillingAvailable || got.BillingAmount != 0 {
				t.Fatal("severity classification changed billing facts")
			}
			if (tc.name == "elapsed-context" || tc.name == "cancelled-context") && strings.Contains(got.Error, "上游") {
				t.Fatalf("local context interruption asserted an upstream failure: %q", got.Error)
			}
			if strings.Contains(got.Error, "private-provider-text") {
				t.Fatal("raw provider payload leaked")
			}
			if tc.name == "output-limit" && (!got.UsageAvailable || got.InputTokens != 31 || got.OutputTokens != 16383 || got.ReasoningTokens == nil || *got.ReasoningTokens != 16383) {
				t.Fatal("warning changed upstream token facts")
			}
		})
	}
}
