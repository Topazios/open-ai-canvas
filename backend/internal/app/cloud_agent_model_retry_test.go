package app

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func modelRetryTestService(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "retry.db")), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.Task{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	return &Service{repo: repository.New(db)}, db
}

func TestCloudAgentModelTaskTransientFailure(t *testing.T) {
	s, db := modelRetryTestService(t)
	const overload = "Our servers are currently overloaded. Please try again later."
	for _, tc := range []struct {
		name, code, message, taskError, diagnosticCode, retryClass string
		status                                                     int
		taskStatus                                                 model.TaskStatus
		want                                                       bool
	}{
		{name: "responses SSE overload", status: 200, code: "server_error", message: overload, want: true},
		{name: "server error without message", status: 200, code: "server_error", want: true},
		{name: "overload code", status: 200, code: "overloaded_error", want: true},
		{name: "unavailable code", status: 200, code: "service_unavailable", want: true},
		{name: "overload message only", status: 200, message: overload, want: true},
		{name: "task overload message", status: 200, taskError: overload, want: true},
		{name: "stored diagnostic", status: 200, diagnosticCode: "server_error", want: true},
		{name: "generic execution diagnostic", status: 200, code: "server_error", diagnosticCode: "provider_execution_failed", retryClass: "new_generation_authorization", want: true},
		{name: "no log diagnostic", diagnosticCode: "server_error", want: true},
		{name: "bad gateway", status: 502, want: true},
		{name: "rate limit", status: 429, code: "rate_limit_exceeded", want: true},
		{name: "request timeout", status: 408, want: true},
		{name: "network reset", taskError: "connection reset by peer", want: true},
		{name: "empty output", status: 200, taskError: "画布 Agent 接口没有返回内容", want: true},
		{name: "step timeout", taskError: cloudAgentStepTimeoutError, want: true},
		{name: "successful task", status: 200, code: "server_error", taskStatus: model.TaskStatusSucceeded},
		{name: "cancelled task", status: 200, code: "server_error", taskStatus: model.TaskStatusCancelled},
		{name: "running task", status: 200, code: "server_error", taskStatus: model.TaskStatusRunning},
		{name: "unauthorized HTTP", status: 401, code: "server_error", message: overload},
		{name: "forbidden HTTP", status: 403, code: "server_error"},
		{name: "input HTTP", status: 400, code: "server_error"},
		{name: "auth SSE", status: 200, code: "invalid_api_key", message: overload},
		{name: "quota SSE", status: 200, code: "insufficient_quota", message: overload},
		{name: "quota 429", status: 429, code: "insufficient_quota"},
		{name: "quota message 429", status: 429, message: "You exceeded your current quota"},
		{name: "balance SSE", status: 200, code: "insufficient_balance", message: overload},
		{name: "balance server error", status: 503, code: "server_error", taskError: "余额不足"},
		{name: "content SSE", status: 200, code: "content_policy_violation", message: overload},
		{name: "content filter", status: 200, code: "content_filter", message: overload},
		{name: "input SSE", status: 200, code: "invalid_request_error", message: overload},
		{name: "context too long", status: 200, code: "context_length_exceeded", message: overload},
		{name: "diagnostic quota overrides server", status: 200, code: "server_error", diagnosticCode: "quota_exceeded"},
		{name: "correct input diagnostic", status: 200, code: "server_error", retryClass: "correct_input"},
		{name: "generic retry suggestion", status: 200, message: "Please try again later."},
		{name: "unknown provider error", status: 200, code: "unknown_error", message: overload},
		{name: "empty HTTP 200", status: 200},
		{name: "unknown without log"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status := tc.taskStatus
			if status == "" {
				status = model.TaskStatusFailed
			}
			raw, err := json.Marshal(model.TaskExecutionDiagnostic{Code: tc.diagnosticCode, RetryClass: tc.retryClass})
			if err != nil {
				t.Fatal(err)
			}
			task := model.Task{ID: tc.name, UserID: "user", Status: status, Error: tc.taskError, ExecutionDiagnosticJSON: string(raw)}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if tc.status != 0 {
				log := model.ApiCallLog{ID: tc.name, TaskID: task.ID, StatusCode: tc.status, ErrorCode: tc.code, Error: tc.message}
				if err := db.Create(&log).Error; err != nil {
					t.Fatal(err)
				}
			}
			if got := s.cloudAgentModelTaskTransientFailure(task.ID); got != tc.want {
				t.Fatalf("retryable = %v, want %v", got, tc.want)
			}
		})
	}
	if s.cloudAgentModelTaskTransientFailure("missing") {
		t.Fatal("missing task must not retry")
	}
}

func TestCloudAgentModelTaskTransientFailureUsesLatestNonPollLog(t *testing.T) {
	s, db := modelRetryTestService(t)
	if err := db.Create(&model.Task{ID: "task", Status: model.TaskStatusFailed}).Error; err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for i, log := range []model.ApiCallLog{
		{ID: "old", TaskID: "task", StatusCode: 401, ErrorCode: "invalid_api_key"},
		{ID: "latest", TaskID: "task", StatusCode: 200, ErrorCode: "server_error", Error: "overloaded"},
		{ID: "poll", TaskID: "task", RequestKind: "poll", StatusCode: 403},
		{ID: "other-task", TaskID: "other", StatusCode: 400},
	} {
		log.CreatedAt = now.Add(time.Duration(i) * time.Second)
		if err := db.Create(&log).Error; err != nil {
			t.Fatal(err)
		}
	}
	log, err := s.repo.LatestAPICallFailureForTask("task")
	if err != nil || log.StatusCode != 200 || log.ErrorCode != "server_error" || log.Error != "overloaded" {
		t.Fatalf("latest failure = %#v, err = %v", log, err)
	}
	if status, err := s.repo.LatestAPICallStatusForTask("task"); err != nil || status != 200 {
		t.Fatalf("existing status accessor = %d, err = %v", status, err)
	}
	if !s.cloudAgentModelTaskTransientFailure("task") {
		t.Fatal("latest non-poll SSE failure must retry")
	}
	if err := db.Create(&model.ApiCallLog{ID: "newest", TaskID: "task", StatusCode: 200, ErrorCode: "insufficient_quota", CreatedAt: now.Add(4 * time.Second)}).Error; err != nil {
		t.Fatal(err)
	}
	if s.cloudAgentModelTaskTransientFailure("task") {
		t.Fatal("old transient log must not override latest quota error")
	}
	if err := db.Migrator().DropTable(&model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	if s.cloudAgentModelTaskTransientFailure("task") {
		t.Fatal("log lookup failure must not retry")
	}
}
