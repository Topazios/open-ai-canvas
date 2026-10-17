package repository

import (
	"strings"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func TestCompactAPICallLogBodiesPreservesBillingMetadata(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:api-log-compaction?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	item := model.ApiCallLog{
		ID: "api-log-1", UserID: "user-1", TaskID: "task-1", BillingOrderID: "order-1", ProviderRequestID: "provider-1",
		Status: model.ApiCallStatusSucceeded, UsageAvailable: true, InputTokens: 12, OutputTokens: 34,
		RequestBody: strings.Repeat("request", 100), ResponseBody: strings.Repeat("response", 100), CreatedAt: time.Now(),
	}
	if err := db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	count, err := New(db).CompactAPICallLogBodies(64, 10)
	if err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("compacted rows = %d, want 1", count)
	}
	var got model.ApiCallLog
	if err := db.First(&got, "id = ?", item.ID).Error; err != nil {
		t.Fatal(err)
	}
	if len(got.RequestBody) > 64 || len(got.ResponseBody) > 64 {
		t.Fatalf("body lengths = %d/%d, want <= 64", len(got.RequestBody), len(got.ResponseBody))
	}
	if got.BillingOrderID != item.BillingOrderID || got.ProviderRequestID != item.ProviderRequestID || got.InputTokens != item.InputTokens || got.OutputTokens != item.OutputTokens || !got.UsageAvailable {
		t.Fatalf("billing metadata changed: %#v", got)
	}
}
