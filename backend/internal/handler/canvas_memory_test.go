package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/canvas/contract"
)

func TestCanvasLargeWriteAdmissionReleasesMemoryBudget(t *testing.T) {
	context := func(size int64) (*gin.Context, *httptest.ResponseRecorder) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodPut, "/", nil)
		c.Request.ContentLength = size
		return c, w
	}
	c, _ := context(contract.MaxCanvasRequestBytes)
	release, ok := admitCanvasWrite(c)
	if !ok {
		t.Fatal("valid largest request rejected")
	}
	c, w := context(9 << 20)
	if _, ok := admitCanvasWrite(c); ok || w.Code != 429 {
		t.Fatal("concurrent large requests exceed memory admission")
	}
	release()
	c, _ = context(9 << 20)
	release, ok = admitCanvasWrite(c)
	if !ok {
		t.Fatal("budget not released")
	}
	release()
	c, w = context(contract.MaxCanvasRequestBytes + 1)
	if _, ok := admitCanvasWrite(c); ok || w.Code != 413 {
		t.Fatal("oversized request entered decoder")
	}
}
