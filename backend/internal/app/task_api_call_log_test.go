package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestProviderDispatchAuditVisibleBeforeResponseAndCompletesSameRow(t *testing.T) {
	for _, capability := range []string{"image", "video", "text", "audio"} {
		for _, code := range []int{200, 503} {
			t.Run(capability+http.StatusText(code), func(t *testing.T) {
				t.Setenv("REDIS_URL", "")
				t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
				s, db, _, _ := creationTestService(t)
				var err error
				s.coordinator, err = platform.NewCoordinator("sqlite")
				if err != nil {
					t.Fatal(err)
				}
				s.platform = platform.New(s.repo, s.coordinator, platformHost{svc: s})
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var pending []model.ApiCallLog
					if err := db.Find(&pending).Error; err != nil {
						t.Error(err)
					}
					if len(pending) != 1 || pending[0].Status != model.ApiCallStatusRunning {
						t.Errorf("pending=%+v", pending)
					}
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(code)
					w.Write([]byte(`{"result":"mock"}`))
				}))
				defer server.Close()
				ctx := context.WithValue(context.Background(), providerAnalyticsKey{}, providerAnalyticsContext{Service: s, UserID: "user", Capability: capability, RequestKind: "create", Model: "test"})
				req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/generate", strings.NewReader(`{"prompt":"test"}`))
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Content-Type", "application/json")
				_, _, requestErr := doBinary(req)
				if (requestErr == nil) != (code == 200) {
					t.Fatalf("request error=%v", requestErr)
				}
				var logs []model.ApiCallLog
				if err := db.Find(&logs).Error; err != nil {
					t.Fatal(err)
				}
				want := model.ApiCallStatusSucceeded
				if code != 200 {
					want = model.ApiCallStatusFailed
				}
				if len(logs) != 1 || logs[0].Status != want || logs[0].StatusCode != code || logs[0].RequestBody == "" || logs[0].ResponseBody == "" {
					t.Fatalf("logs=%+v", logs)
				}
			})
		}
	}
}

func TestVideoPollLogSchedulesNextCheckThirtySecondsLater(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:provider-poll-schedule?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}, &model.ApiCallLog{}, &model.ModelPricing{}); err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "task-1", UserID: "user-1", Type: "canvas_video", Status: model.TaskStatusRunning}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	root := model.ApiCallLog{ID: "api-log-1", UserID: task.UserID, TaskID: task.ID, Capability: "video", RequestKind: "create", ProviderRequestID: "provider-task-1", CreatedAt: time.Now()}
	if err := db.Create(&root).Error; err != nil {
		t.Fatal(err)
	}
	service := &Service{repo: repository.New(db)}
	startedAt := time.Now()
	if err := service.LogAPICall(model.ApiCallLog{
		ID: "poll-log-1", UserID: task.UserID, TaskID: task.ID, Capability: "video", RequestKind: "poll",
		ProviderRequestID: "provider-task-1", Status: model.ApiCallStatusSucceeded, StatusCode: 200, CreatedAt: startedAt,
	}); err != nil {
		t.Fatal(err)
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.NextPollAt == nil {
		t.Fatal("next poll time is nil")
	}
	delay := stored.NextPollAt.Sub(startedAt)
	if delay < 30*time.Second || delay > 31*time.Second {
		t.Fatalf("next poll delay = %s, want approximately 30s", delay)
	}
}

func TestEnsureFailedProviderAttemptLoggedFillsPreflightGapOnce(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:provider-preflight-log?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(
		&model.SystemSetting{},
		&model.Asset{},
		&model.CanvasProject{},
		&model.Task{},
		&model.TaskLog{},
		&model.Result{},
		&model.ApiCallLog{},
		&model.TaskTextDelta{},
		&model.ModelPricing{},
	); err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID:        "task-1",
		UserID:    "user-1",
		Type:      "canvas_video",
		Status:    model.TaskStatusRunning,
		Operation: "video.generate",
		Model:     "logical-video",
		InputJSON: `{"mode":"video","config":{"channelId":"channel-1","channelModelKey":"agnes-video-2.5","apiKey":"secret-key"}}`,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	service := &Service{repo: repository.New(db)}
	failure := BadAuthRequest("Agnes Video 2.5 size 必须是 720P、960P 或 2K")

	service.ensureFailedProviderAttemptLogged(task, failure)
	service.ensureFailedProviderAttemptLogged(task, failure)

	var logs []model.ApiCallLog
	if err := db.Find(&logs).Error; err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 {
		t.Fatalf("api call log count = %d, want 1", len(logs))
	}
	logged := logs[0]
	if logged.ErrorCode != "request_not_sent" || logged.Status != model.ApiCallStatusWarning || logged.ErrorSource != "application" || logged.StatusCode != 0 {
		t.Fatalf("unexpected preflight log state: %#v", logged)
	}
	if logged.ChannelID != "channel-1" || logged.Model != "agnes-video-2.5" || logged.Capability != "video" {
		t.Fatalf("unexpected provider metadata: %#v", logged)
	}
	if logged.Error != failure.Error() {
		t.Fatalf("preflight error = %q, want %q", logged.Error, failure.Error())
	}
	serialized := logged.RequestBody + logged.ResponseBody + logged.UpstreamURL + logged.Error
	if strings.Contains(serialized, "secret-key") || logged.RequestBody != "" || logged.ResponseBody != "" {
		t.Fatalf("preflight log leaked task input: %#v", logged)
	}
}

func TestEnsureFailedProviderAttemptLoggedPreservesConfirmedFailureSources(t *testing.T) {
	for _, tc := range []struct {
		name         string
		cause        error
		diagnostic   *model.TaskExecutionDiagnostic
		providerID   string
		status       model.ApiCallStatus
		source, path string
		httpCode     int
	}{
		{"diagnosed-provider-payload", providerPayloadError{raw: "secret-provider-detail", message: "provider rejected request"}, &model.TaskExecutionDiagnostic{Severity: "error", ErrorSource: "upstream", Phase: "execution", SubmissionOutcome: "accepted"}, "", model.ApiCallStatusFailed, "upstream", "/task/provider-request", 0},
		{"wrapped-provider-payload-no-diagnostic", fmt.Errorf("execution: %w", providerPayloadError{raw: "secret-provider-detail", message: "provider rejected request"}), nil, "", model.ApiCallStatusFailed, "upstream", "/task/provider-request", 0},
		{"provider-payload-overrides-local-warning", providerPayloadError{raw: "secret-provider-detail", message: "provider rejected request"}, &model.TaskExecutionDiagnostic{Severity: "warning", ErrorSource: "application", Phase: "execution", SubmissionOutcome: "not_submitted"}, "", model.ApiCallStatusFailed, "upstream", "/task/provider-request", 0},
		{"diagnosed-upstream-generic-error", errors.New("provider rejected request"), &model.TaskExecutionDiagnostic{Severity: "error", ErrorSource: "upstream", Phase: "execution"}, "", model.ApiCallStatusFailed, "upstream", "/task/provider-request", 0},
		{"diagnosed-network", errors.New("transport interrupted"), &model.TaskExecutionDiagnostic{Severity: "error", ErrorSource: "network", Phase: "execution"}, "", model.ApiCallStatusFailed, "network", "/task/provider-request", 0},
		{"typed-network-no-diagnostic", fmt.Errorf("request: %w", &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}), nil, "", model.ApiCallStatusFailed, "network", "/task/provider-request", 0},
		{"unknown-diagnostic", errors.New("execution interrupted"), &model.TaskExecutionDiagnostic{Severity: "warning", ErrorSource: "unknown", Phase: "execution", SubmissionOutcome: "unknown"}, "", model.ApiCallStatusWarning, "unknown", "/task/provider-preflight", 0},
		{"explicit-error-unknown-source", errors.New("execution interrupted"), &model.TaskExecutionDiagnostic{Severity: "error", Phase: "execution"}, "", model.ApiCallStatusFailed, "unknown", "/task/provider-preflight", 0},
		{"local-not-submitted", errors.New("size is invalid"), &model.TaskExecutionDiagnostic{Phase: "execution", SubmissionOutcome: "not_submitted"}, "", model.ApiCallStatusWarning, "application", "/task/provider-preflight", 0},
		{"unknown-no-diagnostic", errors.New("execution interrupted"), nil, "", model.ApiCallStatusWarning, "unknown", "/task/provider-preflight", 0},
		{"submitted-without-diagnostic", errors.New("status not available"), nil, "provider-id", model.ApiCallStatusWarning, "unknown", "/task/provider-state", 0},
		{"local-timeout-no-diagnostic", context.DeadlineExceeded, nil, "", model.ApiCallStatusWarning, "unknown", "/task/provider-preflight", 0},
		{"http-error-overrides-warning", providerHTTPError{StatusCode: 503, Body: "secret-provider-detail"}, &model.TaskExecutionDiagnostic{Severity: "warning", ErrorSource: "unknown", Phase: "execution"}, "", model.ApiCallStatusFailed, "upstream", "/task/provider-request", 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db, _, _ := creationTestService(t)
			task := model.Task{ID: "fallback-task", UserID: "user", Type: "canvas_text", Status: model.TaskStatusFailed, ProviderRequestID: tc.providerID}
			if tc.diagnostic != nil {
				raw, err := json.Marshal(tc.diagnostic)
				if err != nil {
					t.Fatal(err)
				}
				task.ExecutionDiagnosticJSON = string(raw)
			}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			s.ensureFailedProviderAttemptLogged(task, tc.cause)
			var logs []model.ApiCallLog
			if err := db.Find(&logs).Error; err != nil {
				t.Fatal(err)
			}
			if len(logs) != 1 {
				t.Fatalf("fallback logs=%d", len(logs))
			}
			got := logs[0]
			if got.Status != tc.status || got.ErrorSource != tc.source || got.Path != tc.path || got.StatusCode != tc.httpCode {
				t.Fatalf("wrong fallback attribution: status=%s source=%s path=%s http=%d", got.Status, got.ErrorSource, got.Path, got.StatusCode)
			}
			if got.Billable || got.UsageAvailable || got.RequestBody != "" || got.ResponseBody != "" || strings.Contains(got.Error, "secret-provider-detail") {
				t.Fatal("fallback invented accounting facts or leaked provider details")
			}
			var stored model.Task
			if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
				t.Fatal(err)
			}
			if stored.Status != model.TaskStatusFailed || stored.ExecutionDiagnosticJSON != task.ExecutionDiagnosticJSON {
				t.Fatal("logging rewrote task outcome/diagnostic")
			}
		})
	}
}

func TestEnsureFailedProviderAttemptLoggedDoesNotDuplicateHTTPLog(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:provider-http-log-dedup?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	existing := model.ApiCallLog{ID: "api-log-1", TaskID: "task-1", Status: model.ApiCallStatusFailed}
	if err := db.Create(&existing).Error; err != nil {
		t.Fatal(err)
	}
	service := &Service{repo: repository.New(db)}
	service.ensureFailedProviderAttemptLogged(model.Task{ID: "task-1"}, errors.New("provider rejected request"))

	var count int64
	if err := db.Model(&model.ApiCallLog{}).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("api call log count = %d, want 1", count)
	}
}
