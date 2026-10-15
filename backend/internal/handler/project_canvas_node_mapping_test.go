package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"infinite-canvas/backend/internal/auth"
	"infinite-canvas/backend/internal/database"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/service"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestCanvasNodeShotLinkHTTP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := database.MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.User{ID: "mapping-user", Username: "mapping-user", Role: model.UserRoleUser, Status: model.UserStatusActive},
		&model.AuthSession{ID: "mapping-session", UserID: "mapping-user", TokenHash: auth.HashToken("mapping-token"), ExpiresAt: time.Now().Add(time.Hour)},
		&model.Project{ID: "mapping-project", UserID: "mapping-user", Status: model.ProjectStatusActive, Revision: 1},
		&model.Project{ID: "foreign-project", UserID: "other-user", Status: model.ProjectStatusActive, Revision: 1},
		&model.ProjectUnit{ID: "mapping-unit", ProjectID: "mapping-project"},
		&model.CanvasProject{ID: "mapping-canvas", ProjectID: "mapping-project", UserID: "mapping-user", Revision: 2, PayloadJSON: `{"nodes":[{"id":"node-1","type":"video"}]}`},
		&model.CanvasUnitLink{ID: "unit-link", ProjectID: "mapping-project", CanvasID: "mapping-canvas", UnitID: "mapping-unit"},
		&model.Shot{ID: "mapping-shot", ProjectID: "mapping-project", UnitID: "mapping-unit", CurrentRevisionID: "shot-revision"},
		&model.ShotRevision{ID: "shot-revision", ShotID: "mapping-shot", Version: 1},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	router := gin.New()
	registerProjectUnitRoutes(router.Group("/api"), service.New(repository.New(db), t.TempDir()))
	path := "/api/projects/mapping-project/canvases/mapping-canvas/node-shot-links"
	call := func(method, path, body string, authenticated bool, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		if authenticated {
			req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "mapping-session.mapping-token"})
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		var envelope struct {
			Code   int    `json:"code"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if response.Code != status || (status == 200 && envelope.Code != 0) || (status != 200 && envelope.Code == 0) {
			t.Fatalf("%s %s: got %d %s, want %d", method, path, response.Code, response.Body.String(), status)
		}
		if status == 409 && envelope.Reason != "conflict" {
			t.Fatalf("missing conflict reason: %s", response.Body.String())
		}
		return response
	}
	request := `{"unitId":"mapping-unit","nodeId":"node-1","shotId":"mapping-shot","expectedCanvasRevision":2,"expectedProjectRevision":1}`
	call(http.MethodGet, path, "", false, 401)
	call(http.MethodPost, path, request, false, 401)
	call(http.MethodPost, path+"/node-1/unlink", `{}`, false, 401)
	foreign := "/api/projects/foreign-project/canvases/mapping-canvas/node-shot-links"
	call(http.MethodGet, foreign, "", true, 404)
	call(http.MethodPost, foreign, request, true, 404)
	call(http.MethodPost, foreign+"/node-1/unlink", `{"expectedLinkId":"anything","expectedProjectRevision":1}`, true, 404)
	call(http.MethodPost, path, `{}`, true, 400)
	call(http.MethodPost, path, `{"unitId":"mapping-unit","nodeId":"node-1","shotId":"mapping-shot","expectedCanvasRevision":1,"expectedProjectRevision":1}`, true, 409)
	response := call(http.MethodPost, path, request, true, 200)
	var created struct {
		Data struct {
			Link model.CanvasNodeShotLink `json:"link"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Data.Link.ShotRevisionID != "shot-revision" {
		t.Fatal("did not bind saved shot version")
	}
	call(http.MethodPost, path, request, true, 200)
	response = call(http.MethodGet, path, "", true, 200)
	var listed struct {
		Data struct {
			Links []model.CanvasNodeShotLink `json:"links"`
			Views []struct {
				LinkID   string              `json:"linkId"`
				State    string              `json:"state"`
				Revision *model.ShotRevision `json:"revision"`
			} `json:"views"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Data.Links) != 1 || listed.Data.Links[0].ID != created.Data.Link.ID {
		t.Fatal("GET did not return persisted mapping")
	}
	if len(listed.Data.Views) != 1 || listed.Data.Views[0].LinkID != created.Data.Link.ID || listed.Data.Views[0].State != "current" || listed.Data.Views[0].Revision == nil || listed.Data.Views[0].Revision.ID != "shot-revision" {
		t.Fatal("GET did not return the pinned business projection")
	}
	unlink, err := json.Marshal(map[string]any{"expectedLinkId": created.Data.Link.ID, "expectedProjectRevision": 1})
	if err != nil {
		t.Fatal(err)
	}
	call(http.MethodPost, path+"/node-1/unlink", string(unlink), true, 409)
	unlink, err = json.Marshal(map[string]any{"expectedLinkId": created.Data.Link.ID, "expectedProjectRevision": 2})
	if err != nil {
		t.Fatal(err)
	}
	call(http.MethodPost, path+"/node-1/unlink", string(unlink), true, 200)
	call(http.MethodPost, path+"/node-1/unlink", string(unlink), true, 200)
	var stored model.Project
	if err := db.First(&stored, "id = ?", "mapping-project").Error; err != nil {
		t.Fatal(err)
	}
	if stored.Revision != 3 {
		t.Fatalf("retry advanced project revision: %d", stored.Revision)
	}
	if err := db.First(&model.Shot{}, "id = ?", "mapping-shot").Error; err != nil {
		t.Fatal("unlink removed shot", err)
	}
}
