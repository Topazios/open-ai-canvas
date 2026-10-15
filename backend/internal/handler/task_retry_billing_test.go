package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/auth"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/service"
)

func TestImageRetryBillingHTTPConfirmation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := database.Open(database.Config{Driver: "sqlite", DSN: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := database.MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.User{ID: "retry-user", Username: "retry", Email: "retry@example.invalid", Role: model.UserRoleUser, Status: model.UserStatusActive},
		&model.AuthSession{ID: "retry-session", UserID: "retry-user", TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)},
		&model.BillingOrder{ID: "old-order", UserID: "retry-user", TaskID: "retry-image", Status: model.BillingStatusUncertain},
		&model.Task{ID: "retry-image", UserID: "retry-user", Type: "canvas_image", Status: model.TaskStatusFailed, BillingOrderID: "old-order", InputJSON: `{}`, ExecutionDiagnosticJSON: `{"phase":"execution","submissionOutcome":"unknown"}`},
		&model.Task{ID: "foreign", UserID: "other-user", Status: model.TaskStatusFailed},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	svc := service.New(repository.New(db), t.TempDir())
	previous := runtimeService
	ConfigureRuntime(svc)
	t.Cleanup(func() { ConfigureRuntime(previous) })
	router := gin.New()
	RegisterTaskRoutes(router.Group("/api"), svc)
	for _, tc := range []struct {
		id, body      string
		authenticated bool
		status        int
	}{
		{"retry-image", "", false, 401},
		{"foreign", "", true, 404},
		{"retry-image", "{", true, 400},
		{"retry-image", "", true, 409},
		{"retry-image", `{"acknowledgedBillingOrderId":"different"}`, true, 400},
		{"retry-image", `{"acknowledgedBillingOrderId":"old-order"}`, true, 200},
		{"retry-image", `{"acknowledgedBillingOrderId":"old-order"}`, true, 400},
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/tasks/"+tc.id+"/retry", strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		if tc.authenticated {
			req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "retry-session.test-token"})
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if response.Code != tc.status {
			t.Fatalf("%s %s: %d %s", tc.id, tc.body, response.Code, response.Body.String())
		}
		if tc.status == 409 {
			var body struct {
				Reason  string
				Details map[string]any
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Reason != "task_billing_review_required" || body.Details["billingOrderId"] != "old-order" {
				t.Fatalf("lost confirmation contract: %+v", body)
			}
		}
	}
	var old model.BillingOrder
	if err := db.First(&old, "id = ?", "old-order").Error; err != nil || old.Status != model.BillingStatusUncertain {
		t.Fatalf("old billing was changed: %+v %v", old, err)
	}
}
