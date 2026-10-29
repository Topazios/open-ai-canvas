package app

import (
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestDecorateAPICallLogsUsesBillingOrderSnapshot(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+newID()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if sqlDB, err := db.DB(); err == nil {
		sqlDB.SetMaxOpenConns(1)
	}
	if err := db.AutoMigrate(&model.User{}, &model.ModelChannel{}, &model.BillingOrder{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.User{ID: "user-1", Username: "creator", DisplayName: "创作者"}).Error; err != nil {
		t.Fatal(err)
	}

	orders := []model.BillingOrder{
		{ID: "settled", UserID: "user-1", IdempotencyKey: "settled", Status: model.BillingStatusSettled, ReservedAmountMicrocredits: 1_000_000, ActualAmountMicrocredits: 780_000, BillingCostSnapshot: model.BillingCostSnapshot{CostBillingMode: "fixed_request", CostQuantity: 1, CostPricing: model.CreditCostPricing{Configured: true, UnitPriceMicrocredits: 456_789}}},
		{ID: "reserved", UserID: "user-1", IdempotencyKey: "reserved", Status: model.BillingStatusReserved, ReservedAmountMicrocredits: 900_000},
		{ID: "uncertain", UserID: "user-1", IdempotencyKey: "uncertain", Status: model.BillingStatusUncertain, ReservedAmountMicrocredits: 1_200_000},
		{ID: "refunded", UserID: "user-1", IdempotencyKey: "refunded", Status: model.BillingStatusRefunded, ReservedAmountMicrocredits: 650_000, RefundedAmountMicrocredits: 650_000},
		{ID: "other-user", UserID: "user-2", IdempotencyKey: "other-user", Status: model.BillingStatusSettled, ActualAmountMicrocredits: 500_000},
	}
	if err := db.Create(&orders).Error; err != nil {
		t.Fatal(err)
	}

	logs := []model.ApiCallLog{
		{ID: "log-settled", UserID: "user-1", BillingOrderID: "settled", Capability: "text", Billable: true, Status: model.ApiCallStatusWarning, StatusCode: 200, ProviderStatus: "incomplete", ErrorCode: "output_limit_exceeded", ErrorSource: "content"},
		{ID: "log-reserved", UserID: "user-1", BillingOrderID: "reserved", Capability: "text", Billable: true},
		{ID: "log-uncertain", UserID: "user-1", BillingOrderID: "uncertain", Capability: "text", Billable: true},
		{ID: "log-refunded", UserID: "user-1", BillingOrderID: "refunded", Capability: "text", Billable: true},
		{ID: "log-missing", UserID: "user-1", BillingOrderID: "missing", Capability: "text", Billable: true},
		{ID: "log-other-user", UserID: "user-1", BillingOrderID: "other-user", Capability: "text", Billable: true},
		{ID: "log-download", UserID: "user-1", BillingOrderID: "settled", Capability: "image", RequestKind: "download", Billable: false},
	}

	svc := &Service{repo: repository.New(db)}
	if err := svc.decorateAPICallLogs(logs); err != nil {
		t.Fatal(err)
	}

	assertBillingSnapshot(t, logs[0], true, model.BillingStatusSettled, 780_000)
	assertBillingSnapshot(t, logs[1], true, model.BillingStatusReserved, 900_000)
	assertBillingSnapshot(t, logs[2], true, model.BillingStatusUncertain, 1_200_000)
	assertBillingSnapshot(t, logs[3], true, model.BillingStatusRefunded, 0)
	assertBillingSnapshot(t, logs[4], false, "", 0)
	assertBillingSnapshot(t, logs[5], false, "", 0)
	assertBillingSnapshot(t, logs[6], false, "", 0)
	if !logs[0].CreditCostConfigured || logs[0].CreditCostMicrocredits == nil || *logs[0].CreditCostMicrocredits != 456_789 {
		t.Fatalf("request cost missing: %#v", logs[0])
	}
	for _, log := range logs[1:] {
		if log.CreditCostConfigured || log.CreditCostMicrocredits != nil {
			t.Fatalf("fabricated cost for %s", log.ID)
		}
	}
}

func TestAPICallLogHistoricalIncompleteUsesMatchingTaskDiagnostic(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	task := model.Task{ID: "incomplete-task", UserID: "user", Type: "text", Status: model.TaskStatusFailed, Error: errProviderOutputLimit.Error()}
	recordTaskDiagnostic(&task, "execution", providerOutputLimitCode, "accepted", "new_generation_authorization", errProviderOutputLimit)
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	entries := []model.ApiCallLog{
		{ID: "historical-incomplete", UserID: "user", TaskID: task.ID, Status: model.ApiCallStatusFailed, StatusCode: 200, Capability: "text", ProviderStatus: "incomplete", ResponseBody: "[历史报文已压缩]"},
		{ID: "completed-call", UserID: "user", TaskID: task.ID, Status: model.ApiCallStatusSucceeded, StatusCode: 200, Capability: "text", ProviderStatus: "completed"},
		{ID: "different-user", UserID: "other-user", TaskID: task.ID, Status: model.ApiCallStatusFailed, StatusCode: 200, Capability: "text", ProviderStatus: "incomplete"},
	}
	if err := db.Create(&entries).Error; err != nil {
		t.Fatal(err)
	}
	actor := &model.User{ID: "user", Role: model.UserRoleAdmin}
	for _, entry := range entries {
		got, err := s.AdminAPICallLog(actor, entry.ID)
		if err != nil {
			t.Fatal(err)
		}
		if entry.ID == "historical-incomplete" {
			if got.Status != model.ApiCallStatusWarning || got.ErrorCode != providerOutputLimitCode || got.Error != errProviderOutputLimit.Error() {
				t.Fatalf("historical failure explanation missing: code=%q error=%q", got.ErrorCode, got.Error)
			}
		} else if got.Error != "" || got.ErrorCode != "" || got.Status != entry.DisplayStatus() {
			t.Fatalf("unrelated or successful receipt changed: id=%s status=%s code=%q error=%q", got.ID, got.Status, got.ErrorCode, got.Error)
		}
	}
	var stored model.ApiCallLog
	if err := db.First(&stored, "id = ?", entries[0].ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.ApiCallStatusFailed || stored.Error != "" || stored.ErrorCode != "" {
		t.Fatal("reading history must not mutate stored receipts")
	}
}

func assertBillingSnapshot(t *testing.T, log model.ApiCallLog, available bool, status model.BillingStatus, amount int64) {
	t.Helper()
	if log.BillingAvailable != available || log.BillingStatus != status || log.BillingAmount != amount {
		t.Fatalf("billing snapshot for %s = {available:%v status:%q amount:%d}, want {available:%v status:%q amount:%d}", log.ID, log.BillingAvailable, log.BillingStatus, log.BillingAmount, available, status, amount)
	}
}
