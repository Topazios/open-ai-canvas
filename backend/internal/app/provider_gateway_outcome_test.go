package app

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
)

func TestImageGatewayReceiptIsNotModelFailure(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	const body = `<html><h1>504 Gateway Time-out</h1><hr>openresty</html>`
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusGatewayTimeout)
		_, _ = io.WriteString(w, body)
	}))
	defer server.Close()
	s, db, _, _ := creationTestService(t)
	s.coordinator = platform.NewCoordinatorWithRedis(nil, newID())
	s.platform = platform.New(s.repo, s.coordinator, platformHost{svc: s})
	ctx := context.WithValue(context.Background(), providerAnalyticsKey{}, providerAnalyticsContext{Service: s, UserID: "user", Capability: "image"})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/images/edits", strings.NewReader(`{}`))
	_, _, err := doBinary(req)
	var receipt providerHTTPError
	if !errors.As(err, &receipt) || receipt.StatusCode != 504 || receipt.Body != body {
		t.Fatalf("lost actual HTTP receipt: %v", err)
	}
	var rows []model.ApiCallLog
	if err := db.Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if calls != 1 || len(rows) != 1 {
		t.Fatalf("unexpected regeneration or audit count: %d / %d", calls, len(rows))
	}
	row := rows[0]
	if row.StatusCode != 504 || row.Status != model.ApiCallStatusWarning || row.ErrorSource != "gateway" || row.ErrorCode != model.GatewayResponseUnconfirmed || row.ResponseBody != body {
		t.Fatalf("wrong receipt: %+v", row)
	}
	if row.MediaCount != 0 || row.UsageAvailable || row.CostAvailable {
		t.Fatal("invented result or cost")
	}
}

func TestTaskDiagnosticPreservesFailureBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, phase, source, code string
		cause                     error
	}{
		{"gateway", "execution", "gateway", model.GatewayResponseUnconfirmed, providerHTTPError{StatusCode: 504}},
		{"local-wait", "execution", "application", "provider_request_timeout", providerRequestTimeoutError{timeout: 5 * time.Minute, cause: context.DeadlineExceeded}},
		{"local-read", "execution", "application", "provider_response_read_timeout", providerRequestTimeoutError{timeout: 5 * time.Minute, cause: context.DeadlineExceeded, receiving: true}},
		{"local-parser", "execution", "application", "upstream_response_invalid", providerResponseDecodeError{Err: errors.New("invalid JSON")}},
		{"local-save", "result_persistence", "application", "test_code", errors.New("save failed")},
		{"local-process", "postprocess", "application", "test_code", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			task := &model.Task{ID: "fixture", Status: model.TaskStatusFailed, Error: "未交付"}
			recordTaskDiagnostic(task, tc.phase, "test_code", "unknown", "reconcile_submission", tc.cause)
			got := taskExecutionDiagnostic(task)
			if got == nil || got.Severity != "warning" || got.ErrorSource != tc.source || got.Code != tc.code || got.SubmissionOutcome != "unknown" || got.RetryClass != "reconcile_submission" {
				t.Fatalf("lost diagnostic boundary: %+v", got)
			}
		})
	}
}
