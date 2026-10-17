package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"infinite-canvas/backend/internal/auth"
	"infinite-canvas/backend/internal/canvas/contract"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/service"
)

func TestCanvasSaveLargeWorkflowAndRejectOversize(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := database.MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	for _, record := range []any{
		&model.User{ID: "workflow-user", Username: "workflow-user", Email: "workflow@example.invalid", Role: model.UserRoleUser, Status: model.UserStatusActive},
		&model.AuthSession{ID: "workflow-session", UserID: "workflow-user", TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)},
	} {
		if err := db.Create(record).Error; err != nil {
			t.Fatal(err)
		}
	}
	router := gin.New()
	svc := service.New(repository.New(db), t.TempDir())
	previous := runtimeService
	runtimeService = svc
	t.Cleanup(func() { runtimeService = previous })
	RegisterUserDataRoutes(router.Group("/api"), svc)
	for _, tc := range []struct {
		size     int
		status   int
		revision int
	}{
		{16 << 20, http.StatusOK, 0},
		{contract.MaxCanvasPayloadBytes - 1024, http.StatusOK, 1},
		{contract.MaxCanvasPayloadBytes, http.StatusRequestEntityTooLarge, 2},
		{contract.MaxCanvasRequestBytes, http.StatusRequestEntityTooLarge, 2},
	} {
		payload, _ := json.Marshal(map[string]any{"project": map[string]any{
			"id": "workflow-canvas", "title": "Workflow", "revision": tc.revision,
			"nodes":       []any{map[string]any{"id": "text-1", "type": "text", "metadata": map[string]any{"content": strings.Repeat("a", tc.size)}}},
			"connections": []any{},
		}})
		r := httptest.NewRequest(http.MethodPut, "/api/canvas-projects/workflow-canvas", bytes.NewReader(payload))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "workflow-session.test-token"})
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("size=%d status=%d want=%d: %.500s", tc.size, w.Code, tc.status, w.Body.String())
		}
	}
	var saved model.CanvasProject
	if err := db.First(&saved, "id = ?", "workflow-canvas").Error; err != nil {
		t.Fatal(err)
	}
	if len(saved.PayloadJSON) < contract.MaxCanvasPayloadBytes-1024 {
		t.Fatal("accepted document was truncated or replaced")
	}
}
