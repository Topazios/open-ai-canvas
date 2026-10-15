package app

import (
	"context"
	"encoding/base64"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

type retryDispatchProvider struct {
	*Service
	t     *testing.T
	calls int
	key   any
}

func (p *retryDispatchProvider) processTask(ctx context.Context, task model.Task) (map[string]interface{}, []map[string]interface{}, error) {
	p.calls++
	p.key = ctx.Value(providerSubmissionKeyContext{})
	attempts, err := p.repo.RouteAttempts(task.ID, task.RouteRun)
	if err != nil || len(attempts) != 1 || attempts[0].DispatchState != "submission_unknown" || p.key == nil {
		p.t.Fatalf("provider reached without durable dispatch: %+v %v", attempts, err)
	}
	return map[string]interface{}{"images": []interface{}{map[string]interface{}{"url": "data:image/png;base64," + base64.StdEncoding.EncodeToString(mediaTestPNG(p.t))}}}, nil, nil
}

func runRetryWorker(t *testing.T, s *Service, taskID string) *model.Task {
	t.Helper()
	// A fresh worker ensures the retry survives process restart, not just local state.
	worker := &Service{repo: s.repo, dataDir: s.dataDir, activeCancels: make(map[string]context.CancelFunc)}
	provider := &retryDispatchProvider{Service: worker, t: t}
	worker.taskRouteExecutor = &taskRouteExecutor{port: provider}
	claimed, err := worker.repo.ClaimNextTask("retry-worker", time.Minute)
	if err != nil || claimed == nil || claimed.ID != taskID {
		t.Fatalf("claim: %+v %v", claimed, err)
	}
	if err := worker.taskWorker().processClaimedTask(claimed, nil); err != nil {
		t.Fatal(err)
	}
	completed, err := worker.repo.Task(taskID)
	if err != nil || completed.Status != model.TaskStatusSucceeded || provider.calls != 1 {
		t.Fatalf("worker did not finish one generation: %+v calls=%d %v", completed, provider.calls, err)
	}
	order, err := worker.repo.BillingOrder(completed.BillingOrderID)
	if err != nil || order.Status != model.BillingStatusSettled {
		t.Fatalf("billing not settled: %+v %v", order, err)
	}
	return completed
}

func TestImageRetryWorkerDispatchesAfterPreviousExecution(t *testing.T) {
	s, db, task := imageRetryBillingFixture(t)
	task.Attempts = 1
	if err := db.Save(&task).Error; err != nil {
		t.Fatal(err)
	}
	old := model.RouteAttempt{ID: "old-unknown", TaskID: task.ID, RouteRun: task.RouteRun, AttemptNumber: 1, DispatchState: "submission_unknown"}
	if err := db.Create(&old).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.RetryTask(task.UserID, task.ID, task.BillingOrderID); err != nil {
		t.Fatal(err)
	}
	completed := runRetryWorker(t, s, task.ID)
	if completed.Attempts != 2 || completed.RouteRun != task.RouteRun+1 {
		t.Fatalf("retry reset history: %+v", completed)
	}
	oldOrder, _ := s.repo.BillingOrder(task.BillingOrderID)
	if oldOrder.Status != model.BillingStatusUncertain {
		t.Fatal("original uncertain request changed")
	}
}

func seedBlockedDirectRetry(t *testing.T) (*Service, *gorm.DB, model.Task) {
	t.Helper()
	s, db, task := imageRetryBillingFixture(t)
	now := time.Now()
	task.Attempts, task.StartedAt, task.CompletedAt, task.Error = 2, &now, &now, missingDirectSubmissionMessage
	recordTaskDiagnostic(&task, "preparation", "preparation_failed", "unknown", "reconcile_submission", nil)
	if err := db.Save(&task).Error; err != nil {
		t.Fatal(err)
	}
	// Prior runs may really have reached upstream and must not be resumed or settled.
	for _, row := range []any{
		&model.RouteAttempt{ID: "earlier-unknown", TaskID: task.ID, RouteRun: task.RouteRun - 1, AttemptNumber: 1, DispatchState: "submission_unknown"},
		&model.BillingOrder{ID: "earlier-order", UserID: task.UserID, TaskID: task.ID, IdempotencyKey: "earlier", Status: model.BillingStatusUncertain},
		&model.ApiCallLog{ID: "earlier-call", TaskID: task.ID, BillingOrderID: "earlier-order", Status: model.ApiCallStatusFailed, StartedAt: now.Add(-time.Minute)},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return s, db, task
}

func TestImageRetryRepairsUnsubmittedAttemptWithoutNewCharge(t *testing.T) {
	s, db, task := seedBlockedDirectRetry(t)
	resumed, err := s.RetryTask(task.UserID, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if resumed.BillingOrderID != task.BillingOrderID || resumed.RouteRun != task.RouteRun {
		t.Fatalf("created another charge/round: %+v", resumed)
	}
	var account model.CreditAccount
	db.First(&account, "user_id = ?", task.UserID)
	if account.AvailableMicrocredits != 9950 || account.ReservedMicrocredits != 50 {
		t.Fatalf("repair changed balance: %+v", account)
	}
	var count int64
	db.Model(&model.BillingOrder{}).Count(&count)
	if count != 2 {
		t.Fatalf("repair created billing order: %d", count)
	}
	if _, err := s.RetryTask(task.UserID, task.ID); err == nil {
		t.Fatal("duplicate resume accepted")
	}
	completed := runRetryWorker(t, s, task.ID)
	if completed.Attempts != 3 {
		t.Fatal("attempt history reset")
	}
	db.First(&account, "user_id = ?", task.UserID)
	if account.AvailableMicrocredits != 9950 || account.ReservedMicrocredits != 0 {
		t.Fatalf("resumed attempt was billed twice: %+v", account)
	}
	previous, _ := s.repo.BillingOrder("earlier-order")
	if previous.Status != model.BillingStatusUncertain {
		t.Fatal("earlier unknown call incorrectly settled")
	}
}

func TestImageRetryRepairRequiresEvidenceOfNoSubmission(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*gorm.DB, *model.Task) error
	}{
		{"dispatch-exists", func(db *gorm.DB, task *model.Task) error {
			return db.Create(&model.RouteAttempt{ID: "current", TaskID: task.ID, RouteRun: task.RouteRun, AttemptNumber: 1, DispatchState: "submission_unknown"}).Error
		}},
		{"call-for-order", func(db *gorm.DB, task *model.Task) error {
			return db.Create(&model.ApiCallLog{ID: "current", TaskID: task.ID, BillingOrderID: task.BillingOrderID, StartedAt: task.StartedAt.Add(-time.Second)}).Error
		}},
		{"call-without-order", func(db *gorm.DB, task *model.Task) error {
			return db.Create(&model.ApiCallLog{ID: "current", TaskID: task.ID, StartedAt: task.StartedAt.Add(time.Second)}).Error
		}},
		{"refunded", func(db *gorm.DB, task *model.Task) error {
			return db.Model(&model.BillingOrder{}).Where("id = ?", task.BillingOrderID).Update("status", model.BillingStatusRefunded).Error
		}},
		{"settled", func(db *gorm.DB, task *model.Task) error {
			return db.Model(&model.BillingOrder{}).Where("id = ?", task.BillingOrderID).Update("status", model.BillingStatusSettled).Error
		}},
		{"foreign-order", func(db *gorm.DB, task *model.Task) error {
			return db.Model(&model.BillingOrder{}).Where("id = ?", task.BillingOrderID).Update("user_id", "someone-else").Error
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, db, task := seedBlockedDirectRetry(t)
			if err := test.mutate(db, &task); err != nil {
				t.Fatal(err)
			}
			if _, err := s.RetryTask(task.UserID, task.ID); err == nil {
				t.Fatal("unsafe repair accepted")
			}
			stored, _ := s.repo.Task(task.ID)
			if stored.Status != model.TaskStatusFailed || stored.Error != task.Error {
				t.Fatal("rejected repair changed task")
			}
		})
	}
}

func TestDirectRetryCheckpointCanOnlyDispatchOnce(t *testing.T) {
	s, db, task := imageRetryBillingFixture(t)
	for _, kind := range []string{"canvas_text", "canvas_image", "canvas_video", "canvas_audio"} {
		t.Run(kind, func(t *testing.T) {
			current := task
			current.ID, current.Type, current.BillingOrderID, current.InputJSON, current.Attempts = kind, kind, "", `{}`, 8
			if err := db.Create(&current).Error; err != nil {
				t.Fatal(err)
			}
			retried, err := s.RetryTask(current.UserID, current.ID)
			if err != nil {
				t.Fatal(err)
			}
			retried.Attempts++
			attempt, err := s.beginTaskRouteAttempt(retried)
			if err != nil {
				t.Fatalf("explicit retry rejected as legacy: %v", err)
			}
			stale := *attempt
			if err := s.markRouteAttemptDispatching(attempt); err != nil {
				t.Fatal(err)
			}
			if err := s.markRouteAttemptDispatching(&stale); !isRouteDispatchUncertain(err) {
				t.Fatalf("double dispatch allowed: %v", err)
			}
			if _, err := s.beginTaskRouteAttempt(retried); !isRouteDispatchUncertain(err) {
				t.Fatalf("unknown execution auto-reissued: %v", err)
			}
		})
	}
	legacy := &model.Task{ID: "legacy", Attempts: 3}
	if _, err := s.beginTaskRouteAttempt(legacy); !isRouteDispatchUncertain(err) {
		t.Fatalf("legacy protection removed: %v", err)
	}
}

func TestDirectRetryCheckpointFailureRollsBackTaskAndBilling(t *testing.T) {
	s, db, task := imageRetryBillingFixture(t)
	conflict := model.RouteAttempt{ID: "existing-next-attempt", TaskID: task.ID, RouteRun: task.RouteRun + 1, AttemptNumber: 1, DispatchState: "not_sent"}
	if err := db.Create(&conflict).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.RetryTask(task.UserID, task.ID, task.BillingOrderID); err == nil {
		t.Fatal("conflicting checkpoint accepted")
	}
	stored, _ := s.repo.Task(task.ID)
	if stored.Status != model.TaskStatusFailed || stored.BillingOrderID != task.BillingOrderID || stored.RouteRun != task.RouteRun {
		t.Fatalf("failed checkpoint leaked task update: %+v", stored)
	}
	var count int64
	db.Model(&model.BillingOrder{}).Count(&count)
	if count != 1 {
		t.Fatalf("failed checkpoint leaked billing order: %d", count)
	}
	var account model.CreditAccount
	db.First(&account, "user_id = ?", task.UserID)
	if account.AvailableMicrocredits != 9950 || account.ReservedMicrocredits != 50 {
		t.Fatalf("failed checkpoint leaked charge: %+v", account)
	}
}
