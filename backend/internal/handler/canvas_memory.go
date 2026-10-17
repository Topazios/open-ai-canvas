package handler

import (
	"net/http"
	"sync/atomic"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/canvas/contract"
	"infinite-canvas/backend/internal/service"
)

// Bound aggregate large JSON admission before decoding creates object copies.
// This protects memory independently of model/task concurrency policy.
var canvasWriteBytes atomic.Int64

func admitCanvasWrite(c *gin.Context) (func(), bool) {
	size := c.Request.ContentLength
	if size > contract.MaxCanvasRequestBytes {
		fail(c, http.StatusRequestEntityTooLarge, service.BadAuthRequest("画布数据超过 100MiB，未保存"))
		return nil, false
	}
	if size < 0 {
		size = contract.MaxCanvasRequestBytes
	}
	for {
		used := canvasWriteBytes.Load()
		if used+size > contract.MaxCanvasRequestBytes {
			c.Header("Retry-After", "3")
			fail(c, http.StatusTooManyRequests, service.BadAuthRequest("正在保存大型画布，请稍后重试；当前内容未覆盖"))
			return nil, false
		}
		if canvasWriteBytes.CompareAndSwap(used, used+size) {
			return func() { canvasWriteBytes.Add(-size) }, true
		}
	}
}
