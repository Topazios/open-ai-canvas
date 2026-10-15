package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/auth"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/service"
)

// Exercise the actual strict HTTP decoder, then stop at pre-admission validation.
// No canvas, model channel or billed task exists in this database.
func TestAgentProductionHTTPAcceptsReasoningEffort(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.User{}, &model.AuthSession{}, &model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.User{ID: "user", Username: "user", Email: "fixture@example.invalid", Role: model.UserRoleUser, Status: model.UserStatusActive}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.AuthSession{ID: "session", UserID: "user", TokenHash: auth.HashToken("fixture-token"), ExpiresAt: time.Now().Add(time.Hour)}).Error; err != nil {
		t.Fatal(err)
	}
	svc := service.New(repository.New(db), t.TempDir())
	previous := runtimeService
	runtimeService = svc
	t.Cleanup(func() { runtimeService = previous })
	router := gin.New()
	RegisterAgentRoutes(router.Group("/api"), svc)
	for _, field := range []string{"reasoningEffort", "unknownOption"} {
		// A missing prompt must be rejected after successful strict JSON decoding.
		body := `{"canvasId":"fixture","permissionMode":"auto","production":{"targetNodeId":"node"},"` + field + `":"medium"}`
		request := httptest.NewRequest("POST", "/api/agent/runs", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "session.fixture-token"})
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != 400 {
			t.Fatalf("unexpected status: %d %s", recorder.Code, recorder.Body.String())
		}
		if field == "reasoningEffort" && !strings.Contains(recorder.Body.String(), "提示词") {
			t.Fatal("supported field rejected before domain validation", recorder.Body.String())
		}
		if field == "unknownOption" && !strings.Contains(recorder.Body.String(), "unknown field") {
			t.Fatal("strict decoding weakened", recorder.Body.String())
		}
	}
}

func TestAgentProductionEarlierJournalQuery(t *testing.T) {
	for _, query := range []string{"?beforeSeq=501&eventLimit=100", "?beforeSeq=-1", "?beforeSeq=1&sinceSeq=2"} {
		ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
		ctx.Request = httptest.NewRequest("GET", "/api/agent/runs/fixture"+query, nil)
		options, err := agentRunViewOptions(ctx)
		if strings.HasPrefix(query, "?beforeSeq=501") {
			if err != nil || options.BeforeSeq != 501 || options.EventLimit != 100 {
				t.Fatal(options, err)
			}
		} else if err == nil {
			t.Fatal("invalid cursor accepted", query)
		}
	}
}
