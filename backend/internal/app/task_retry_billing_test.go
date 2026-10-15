package app

import (
	"errors"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func imageRetryBillingFixture(t *testing.T) (*Service, *gorm.DB, model.Task) {
	t.Helper()
	s, db, _, _ := creationTestService(t)
	task := model.Task{ID: "image-retry", UserID: "user", Type: "canvas_image", Operation: "image", Status: model.TaskStatusFailed,
		BillingOrderID: "pending-order", RouteRun: 2, InputJSON: `{"mode":"image","config":{"channelId":"channel","model":"image-test"}}`}
	recordTaskDiagnostic(&task, "execution", "provider_execution_failed", "unknown", "reconcile_submission", nil)
	for _, row := range []any{
		&model.ChannelModel{ID: "image-cm", ChannelID: "channel", ModelKey: "image-test", Capability: "image", BillingMode: "fixed_request", UnitPriceMicrocredits: 100, PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "image-tier", ChannelModelID: "image-cm", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 100, PriceConfigured: true, Enabled: true},
		&model.BillingOrder{ID: task.BillingOrderID, UserID: task.UserID, TaskID: task.ID, IdempotencyKey: "old", Status: model.BillingStatusUncertain, AmountMicrocredits: 50, ReservedAmountMicrocredits: 50},
		&task,
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&model.CreditAccount{}).Where("user_id = ?", "user").Updates(map[string]any{"available_microcredits": 9950, "reserved_microcredits": 50}).Error; err != nil {
		t.Fatal(err)
	}
	return s, db, task
}

func TestImageRetryPendingBillingRequiresSpecificConfirmation(t *testing.T) {
	s, db, task := imageRetryBillingFixture(t)
	_, err := s.RetryTask(task.UserID, task.ID)
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Reason != "task_billing_review_required" || appErr.Details["billingOrderId"] != task.BillingOrderID {
		t.Fatalf("missing confirmation: %v", err)
	}
	if _, err := s.RetryTask(task.UserID, task.ID, "another-order"); err == nil {
		t.Fatal("wrong order accepted")
	}
	if _, err := s.RetryTask("other-user", task.ID, task.BillingOrderID); err == nil {
		t.Fatal("cross-user retry accepted")
	}
	var count int64
	db.Model(&model.BillingOrder{}).Count(&count)
	if count != 1 {
		t.Fatalf("unconfirmed retry billed: %d", count)
	}

	retried, err := s.RetryTask(task.UserID, task.ID, task.BillingOrderID)
	if err != nil {
		t.Fatal(err)
	}
	if retried.ID != task.ID || retried.Status != model.TaskStatusQueued || retried.RouteRun != 3 || retried.BillingOrderID == task.BillingOrderID || retried.BillingOrderID == "" {
		t.Fatalf("invalid retry: %+v", retried)
	}
	old, _ := s.repo.BillingOrder(task.BillingOrderID)
	if old.Status != model.BillingStatusUncertain || old.ReservedAmountMicrocredits != 50 || old.RefundedAmountMicrocredits != 0 {
		t.Fatalf("old order changed: %+v", old)
	}
	var account model.CreditAccount
	db.First(&account, "user_id = ?", task.UserID)
	if account.AvailableMicrocredits != 9850 || account.ReservedMicrocredits != 150 {
		t.Fatalf("incorrect reservation: %+v", account)
	}
	if _, err := s.RetryTask(task.UserID, task.ID, task.BillingOrderID); err == nil {
		t.Fatal("duplicate retry accepted")
	}
	orders, err := s.repo.BillingOrdersByTaskIDs(task.UserID, []string{task.ID})
	if err != nil || orders[task.ID].ID != retried.BillingOrderID {
		t.Fatalf("task displayed old order: %+v %v", orders, err)
	}
	if err := s.SettleBilling(retried.BillingOrderID, "new-provider"); err != nil {
		t.Fatal(err)
	}
	old, _ = s.repo.BillingOrder(task.BillingOrderID)
	if old.Status != model.BillingStatusUncertain {
		t.Fatal("new settlement resolved old order")
	}
	db.First(&account, "user_id = ?", task.UserID)
	if account.AvailableMicrocredits != 9850 || account.ReservedMicrocredits != 50 {
		t.Fatalf("normal settlement changed: %+v", account)
	}
}

func TestImageRetryModerationDoesNotCreateAttemptOrChangeBilling(t *testing.T) {
	s, db, task := imageRetryBillingFixture(t)
	task.Error = "请求内容未通过模型服务安全审核，请调整后重试"
	if err := db.Save(&task).Error; err != nil {
		t.Fatal(err)
	}
	_, err := s.RetryTask(task.UserID, task.ID, task.BillingOrderID)
	if err == nil || !strings.Contains(err.Error(), "原任务不能直接重试") {
		t.Fatalf("moderation guard missing: %v", err)
	}
	stored, err := s.repo.TaskForUser(task.UserID, task.ID)
	if err != nil || stored.RouteRun != task.RouteRun || stored.Status != model.TaskStatusFailed {
		t.Fatalf("task mutated: %+v %v", stored, err)
	}
	var count int64
	db.Model(&model.BillingOrder{}).Count(&count)
	if count != 1 {
		t.Fatalf("moderation retry created billing order: %d", count)
	}
	var account model.CreditAccount
	db.First(&account, "user_id = ?", task.UserID)
	if account.AvailableMicrocredits != 9950 || account.ReservedMicrocredits != 50 {
		t.Fatalf("billing changed: %+v", account)
	}
}

func TestImageRetryConfirmationDoesNotBypassRecoveryGuards(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*model.Task)
	}{
		{"provider-known", func(t *model.Task) { t.ProviderRequestID = "upstream" }},
		{"recoverable", func(t *model.Task) { t.MediaRecoveryJSON = `{}` }},
		{"result", func(t *model.Task) { t.ResultJSON = `{"images":["saved"]}` }},
		{"cancel-pending", func(t *model.Task) { t.ProviderCancelStatus = model.ProviderCancelStatusRequested }},
		{"cancelled", func(t *model.Task) { t.Status = model.TaskStatusCancelled }},
		{"removed", func(t *model.Task) { now := time.Now(); t.RemovedAt = &now }},
		{"agent", func(t *model.Task) { t.AgentRunID = "agent" }},
		{"no-diagnostic", func(t *model.Task) { t.ExecutionDiagnosticJSON = "" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, db, task := imageRetryBillingFixture(t)
			test.change(&task)
			if err := db.Save(&task).Error; err != nil {
				t.Fatal(err)
			}
			if _, err := s.RetryTask(task.UserID, task.ID, task.BillingOrderID); err == nil {
				t.Fatal("guard bypassed")
			}
			var count int64
			db.Model(&model.BillingOrder{}).Count(&count)
			if count != 1 {
				t.Fatalf("guard created billing order: %d", count)
			}
		})
	}
}

func TestImageRetryStaleAttemptRollsBackReservation(t *testing.T) {
	s, db, task := imageRetryBillingFixture(t)
	if err := db.Model(&task).Update("route_run", 3).Error; err != nil {
		t.Fatal(err)
	}
	task.RouteRun = 2
	order := &model.BillingOrder{ID: "stale-order", UserID: "user", TaskID: task.ID, IdempotencyKey: "stale", AmountMicrocredits: 100}
	if _, err := s.repo.RetryTaskWithBilling(task.UserID, &task, order, 0); !errors.Is(err, repository.ErrTaskNotRetryable) {
		t.Fatalf("stale retry accepted: %v", err)
	}
	var count int64
	db.Model(&model.BillingOrder{}).Count(&count)
	if count != 1 {
		t.Fatal("stale retry leaked reservation")
	}
	var account model.CreditAccount
	db.First(&account, "user_id = ?", task.UserID)
	if account.AvailableMicrocredits != 9950 || account.ReservedMicrocredits != 50 {
		t.Fatalf("stale retry changed balance: %+v", account)
	}
}

func TestTaskBillingFailureOnlyReadsCurrentAttempt(t *testing.T) {
	s, db, task := imageRetryBillingFixture(t)
	if err := db.Model(&model.BillingOrder{}).Where("id = ?", task.BillingOrderID).Update("status", model.BillingStatusRunning).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{ID: "old-call", TaskID: task.ID, BillingOrderID: "older-order", Billable: true, Status: model.ApiCallStatusSucceeded}).Error; err != nil {
		t.Fatal(err)
	}
	if s.taskBilling().BillingFailureRequiresReview(task.BillingOrderID, task.ID, errors.New("provider rejected")) {
		t.Fatal("old attempt polluted failure policy")
	}
	if err := db.Create(&model.ApiCallLog{ID: "current-call", TaskID: task.ID, BillingOrderID: task.BillingOrderID, Billable: true, Status: model.ApiCallStatusSucceeded}).Error; err != nil {
		t.Fatal(err)
	}
	if !s.taskBilling().BillingFailureRequiresReview(task.BillingOrderID, task.ID, errors.New("save failed")) {
		t.Fatal("successful current call was ignored")
	}
}
