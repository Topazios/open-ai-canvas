package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"infinite-canvas/backend/internal/service"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestPublicResourceHEADPreservesSignedAccessAndGETMetadata(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("CANVAS_PUBLIC_BASE_URL", "https://media.example.invalid")
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
	if err := db.AutoMigrate(&model.Resource{}, &model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, "resources"), 0o700); err != nil {
		t.Fatal(err)
	}
	body := "test-image-content"
	if err := os.WriteFile(filepath.Join(dataDir, "resources", "frame.png"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "frame", UserID: "owner", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "frame.png", MimeType: "image/png", Size: int64(len(body))}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	svc := service.New(repository.New(db), dataDir)
	key := []byte("0123456789abcdef0123456789abcdef")
	if err := os.WriteFile(filepath.Join(dataDir, ".settings-key"), key, 0o600); err != nil {
		t.Fatal(err)
	}
	expires := strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(resource.ID + "\noriginal\n" + expires))
	query := url.Values{"variant": {"original"}, "expires": {expires}, "signature": {base64.RawURLEncoding.EncodeToString(mac.Sum(nil))}}
	signedURL := &url.URL{Path: "/api/public/resources/" + resource.ID + "/file", RawQuery: query.Encode()}
	router := gin.New()
	RegisterUserDataRoutes(router.Group("/api"), svc)
	for _, suffix := range []string{"", "/frame.png"} {
		requestURL := *signedURL
		requestURL.Path += suffix
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			request := httptest.NewRequest(method, requestURL.RequestURI(), nil)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "image/png" || response.Header().Get("Content-Length") != strconv.Itoa(len(body)) {
				t.Fatalf("%s %s: status=%d headers=%v body=%q", method, requestURL.Path, response.Code, response.Header(), response.Body.String())
			}
			if (method == http.MethodHead && response.Body.Len() != 0) || (method == http.MethodGet && response.Body.String() != body) {
				t.Fatalf("%s: unexpected body %q", method, response.Body.String())
			}
		}
		for _, change := range []string{"signature", "expires", "variant"} {
			invalid := requestURL
			query := invalid.Query()
			query.Set(change, "invalid")
			invalid.RawQuery = query.Encode()
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				response := httptest.NewRecorder()
				router.ServeHTTP(response, httptest.NewRequest(method, invalid.RequestURI(), nil))
				if response.Code < 400 || response.Code == http.StatusNotFound {
					t.Fatalf("%s invalid %s: status=%d", method, change, response.Code)
				}
			}
		}
	}
}

func TestPublicResourceAcceptsJSONEscapedQuerySeparator(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("CANVAS_PUBLIC_BASE_URL", "https://media.example.invalid")
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
	if err := db.AutoMigrate(&model.Resource{}, &model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	dataDir := t.TempDir()
	resourceDir := filepath.Join(dataDir, "resources")
	if err := os.MkdirAll(resourceDir, 0o700); err != nil {
		t.Fatal(err)
	}
	body := "escaped-query-content"
	if err := os.WriteFile(filepath.Join(resourceDir, "frame.png"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "escaped-frame", UserID: "owner", Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: "frame.png", MimeType: "image/png", Size: int64(len(body))}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	key := []byte("0123456789abcdef0123456789abcdef")
	if err := os.WriteFile(filepath.Join(dataDir, ".settings-key"), key, 0o600); err != nil {
		t.Fatal(err)
	}
	svc := service.New(repository.New(db), dataDir)
	expires := strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(resource.ID + "\noriginal\n" + expires))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	router := gin.New()
	RegisterUserDataRoutes(router.Group("/api"), svc)
	request := httptest.NewRequest(http.MethodGet, "/api/public/resources/escaped-frame/file?variant=original&expires="+expires+`\u0026signature=`+signature, nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != body {
		t.Fatalf("escaped query separator: status=%d body=%q", response.Code, response.Body.String())
	}
}

func TestServeResourceDeliveryHEADDoesNotReadProxyStream(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	closed := false
	router.HEAD("/resource", func(c *gin.Context) {
		resource := &model.Resource{ID: "frame", MimeType: "image/png"}
		serveResourceDelivery(c, &service.ResourceDelivery{
			Access: &assets.ResourceAccess{URL: "/resource", Delivery: assets.DeliveryProxy},
			Stream: &assets.ResourceStream{Resource: resource, Body: headOnlyStream{t: t, closed: &closed}, StatusCode: http.StatusOK, ContentLength: 42},
		}, "private, no-cache", "")
	})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodHead, "/resource", nil))
	if response.Code != http.StatusOK || response.Header().Get("Content-Length") != "42" || response.Header().Get("Content-Type") != "image/png" || response.Body.Len() != 0 || !closed {
		t.Fatalf("HEAD: status=%d headers=%v body=%q closed=%v", response.Code, response.Header(), response.Body.String(), closed)
	}
}

type headOnlyStream struct {
	t      *testing.T
	closed *bool
}

func (s headOnlyStream) Read([]byte) (int, error) {
	s.t.Error("HEAD must not read the media stream")
	return 0, io.EOF
}

func (s headOnlyStream) Close() error {
	*s.closed = true
	return nil
}

func TestServeResourceDeliveryRedirectsCloudMediaWithoutWritingBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/resource", func(c *gin.Context) {
		serveResourceDelivery(c, &service.ResourceDelivery{Access: &assets.ResourceAccess{
			ResourceID: "resource-1",
			URL:        "https://cdn.example.com/users/user-1/image/test.png?signature=redacted",
			Delivery:   assets.DeliveryCDN,
		}}, "private, no-cache", "")
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/resource", nil))

	if recorder.Code != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d, want 307", recorder.Code)
	}
	if got := recorder.Header().Get("Location"); got != "https://cdn.example.com/users/user-1/image/test.png?signature=redacted" {
		t.Fatalf("location = %q", got)
	}
	if recorder.Body.Len() != 0 {
		t.Fatalf("redirect wrote %d body bytes; platform must not send cloud media", recorder.Body.Len())
	}
}

func TestServeResourceDeliveryReturnsAccessDescriptorWithoutRedirect(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.GET("/resource", func(c *gin.Context) {
		serveResourceDelivery(c, &service.ResourceDelivery{Access: &assets.ResourceAccess{
			ResourceID: "resource-1",
			URL:        "https://cdn.example.com/test.png",
			Delivery:   assets.DeliveryCDN,
		}}, "private, no-cache", "")
	})

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/resource?access=1", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("cache-control = %q", got)
	}
	if !strings.Contains(recorder.Body.String(), `"url":"https://cdn.example.com/test.png"`) {
		t.Fatalf("access descriptor missing from body: %s", recorder.Body.String())
	}
}

func TestServeResourceDeliveryStreamsPlatformBytesAndRangeMetadata(t *testing.T) {
	gin.SetMode(gin.TestMode)
	resource := &model.Resource{ID: "resource-1", MimeType: "video/mp4", UpdatedAt: time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)}
	router := gin.New()
	router.GET("/resource", func(c *gin.Context) {
		serveResourceDelivery(c, &service.ResourceDelivery{
			Resource: resource,
			Access:   &assets.ResourceAccess{ResourceID: resource.ID, URL: "/api/resources/resource-1/file", Delivery: assets.DeliveryProxy},
			Stream:   &assets.ResourceStream{Resource: resource, Body: io.NopCloser(strings.NewReader("partial-media")), StatusCode: http.StatusPartialContent, ContentLength: 13, ContentRange: "bytes 10-22/100", AcceptRanges: "bytes"},
		}, "private, no-cache", `inline; filename="video.mp4"`)
	})

	recorder := httptest.NewRecorder()
	recorder.HeaderMap = make(http.Header)
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/resource", nil))

	if recorder.Code != http.StatusPartialContent || recorder.Body.String() != "partial-media" {
		t.Fatalf("response = status %d body %q", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Content-Range") != "bytes 10-22/100" || recorder.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("range headers missing: %#v", recorder.Header())
	}
	if recorder.Header().Get("Content-Type") != "video/mp4" {
		t.Fatalf("content-type = %q", recorder.Header().Get("Content-Type"))
	}
	if recorder.Header().Get("Content-Disposition") != `inline; filename="video.mp4"` {
		t.Fatalf("content-disposition = %q", recorder.Header().Get("Content-Disposition"))
	}
}
