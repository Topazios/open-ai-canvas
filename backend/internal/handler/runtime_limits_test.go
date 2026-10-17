package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/service"
)

func TestSessionPublishesGlobalConcurrencyForAnonymousPreviews(t *testing.T) {
	t.Setenv("REDIS_URL", "")
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "policy.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.SystemSetting{Key: "runtime_policy", ValueJSON: `{"task":{"imageConcurrency":9},"resource":{"imagePreparationConcurrency":2}}`}).Error; err != nil {
		t.Fatal(err)
	}
	svc := service.New(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = svc.Close() })
	router := gin.New()
	RegisterAuthRoutes(router.Group("/api"), svc)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/auth/session", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("session response: %d %s", response.Code, response.Body.String())
	}
	var payload struct {
		Code int `json:"code"`
		Data struct {
			User   any `json:"user"`
			Limits struct {
				Concurrency map[string]int `json:"concurrency"`
			} `json:"runtimeLimits"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Code != 0 || payload.Data.User != nil || len(payload.Data.Limits.Concurrency) != 13 || payload.Data.Limits.Concurrency["image"] != 9 || payload.Data.Limits.Concurrency["imagePreparation"] != 2 {
		t.Fatalf("public policy missing: %s", response.Body.String())
	}
}
