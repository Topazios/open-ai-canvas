package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func batchTestRequest() CreateTaskRequest {
	return CreateTaskRequest{Type: "canvas_text", Operation: "text", Prompt: "提取固定资产并保留集数和依据", Input: map[string]any{
		"mode": "text", "config": map[string]any{"channelId": "", "baseUrl": "https://fixture.invalid/v1", "apiKey": "test-only", "model": "fixture", "interfaceType": "chat-completion"},
		"workflowBatch": workflowTextBatch{Version: 1, Units: []workflowTextUnit{{Label: "第1集", Text: "角色甲进入场景一"}, {Label: "第2集", Text: "角色甲进入场景二"}}},
	}}
}

func newBatchTestService(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	s, db := newMediaRecoveryTestService(t)
	policy := defaultRuntimePolicy()
	policy.Task.ActiveTaskLimit = 1
	if _, err := s.UpdateRuntimePolicySetting(&model.User{ID: "admin", Role: model.UserRoleAdmin}, policy); err != nil {
		t.Fatal(err)
	}
	return s, db
}

func TestWorkflowBatchValidationAndMergeBounds(t *testing.T) {
	request := batchTestRequest()
	input, _ := normalizeTaskInput(request.Input)
	if batch, err := validateWorkflowTextBatch(request.Type, request.Prompt, input); err != nil || len(batch.Units) != 2 {
		t.Fatalf("valid plan: %v", err)
	}
	for _, raw := range []any{nil, workflowTextBatch{Version: 2, Units: []workflowTextUnit{{Label: "x", Text: "x"}}}, workflowTextBatch{Version: 1, Units: []workflowTextUnit{{Label: "x", Text: strings.Repeat("长", 24001)}}}} {
		input["workflowBatch"] = raw
		if _, err := validateWorkflowTextBatch(request.Type, request.Prompt, input); err == nil {
			t.Fatal("invalid plan admitted")
		}
	}
	source := strings.Repeat("甲🎬", 37000)
	groups := workflowBatchMergeGroups([]string{source})
	if strings.Join(groups, "") != source {
		t.Fatal("merge split lost characters")
	}
	for _, group := range groups {
		if utf8.RuneCountInString(group) > workflowBatchContextLimit || !utf8.ValidString(group) {
			t.Fatal("unbounded or invalid input")
		}
	}
	if workflowBatchChildID("a", "map-0", "x", 1) == workflowBatchChildID("a", "map-0", "x", 2) {
		t.Fatal("retry identity collision")
	}
}

func claimBatchTestTask(t *testing.T, s *Service, db *gorm.DB, parentID string) *model.Task {
	t.Helper()
	if err := db.Model(&model.Task{}).Where("id = ?", parentID).Update("next_poll_at", nil).Error; err != nil {
		t.Fatal(err)
	}
	task, err := s.repo.ClaimNextTask("batch-test", time.Minute)
	if err != nil || task == nil {
		t.Fatalf("claim: %v", err)
	}
	return task
}

func finishBatchTestChild(t *testing.T, s *Service, db *gorm.DB, text string, failed bool) *model.Task {
	t.Helper()
	child, err := s.repo.ClaimNextTask("child-worker", time.Minute)
	if err != nil || child == nil || child.Operation == workflowBatchOperation {
		t.Fatalf("single worker could not claim child: %+v %v", child, err)
	}
	var input map[string]any
	decoded, _ := s.decryptTaskInputJSON(child.InputJSON)
	_ = json.Unmarshal([]byte(decoded), &input)
	metadata, _ := input["metadata"].(map[string]any)
	if metadata["nodeId"] != nil || input["workflowBatch"] != nil {
		t.Fatal("intermediate result can bind to canvas or recursively batch")
	}
	if failed {
		_, err = s.repo.UpdateTaskTerminalState(child.ID, child.LeaseOwner, model.TaskStatusRunning, model.TaskStatusFailed, "模拟失败", "模拟失败", time.Now())
	} else {
		payload, _ := json.Marshal(map[string]any{"mode": "text", "text": text})
		err = s.saveTaskCompletionWithinStorageQuota(child, payload, nil, false)
	}
	if err != nil {
		t.Fatal(err)
	}
	return child
}

func TestWorkflowBatchSurvivesRestartAndReusesCompletedChildren(t *testing.T) {
	s, db := newBatchTestService(t)
	parent, err := s.CreateTask("batch-user", batchTestRequest())
	if err != nil {
		t.Fatal(err)
	}
	if parent.Operation != workflowBatchOperation || parent.BillingOrderID != "" {
		t.Fatal("parent should coordinate without billing")
	}
	parent = claimBatchTestTask(t, s, db, parent.ID)
	if err := s.processWorkflowTextBatch(parent); err != nil {
		t.Fatal(err)
	}
	first := finishBatchTestChild(t, s, db, "第1集：角色甲、场景一", false)
	// A new service instance has no in-memory orchestration state.
	s = &Service{repo: repository.New(db), dataDir: s.dataDir}
	parent = claimBatchTestTask(t, s, db, parent.ID)
	if err := s.processWorkflowTextBatch(parent); err != nil {
		t.Fatal(err)
	}
	failed := finishBatchTestChild(t, s, db, "", true)
	parent = claimBatchTestTask(t, s, db, parent.ID)
	if err := s.processWorkflowTextBatch(parent); err != nil {
		t.Fatal(err)
	}
	persisted, _ := s.repo.Task(parent.ID)
	if persisted.Status != model.TaskStatusFailed || !strings.Contains(persisted.Error, failed.ID) {
		t.Fatalf("missing failed batch: %+v", persisted)
	}
	if _, err := s.taskLifecycle().retryTask("another-user", parent.ID); err == nil {
		t.Fatal("cross-user retry")
	}
	if _, err := s.taskLifecycle().retryTask(parent.UserID, parent.ID); err != nil {
		t.Fatal(err)
	}
	parent = claimBatchTestTask(t, s, db, parent.ID)
	if err := s.processWorkflowTextBatch(parent); err != nil {
		t.Fatal(err)
	}
	resumed := finishBatchTestChild(t, s, db, "第2集：角色甲、场景二", false)
	if resumed.ID == failed.ID {
		t.Fatal("failed billable attempt was overwritten")
	}
	parent = claimBatchTestTask(t, s, db, parent.ID)
	if err := s.processWorkflowTextBatch(parent); err != nil {
		t.Fatal(err)
	}
	finishBatchTestChild(t, s, db, "完整资产结果", false)
	parent = claimBatchTestTask(t, s, db, parent.ID)
	if err := s.processWorkflowTextBatch(parent); err != nil {
		t.Fatal(err)
	}
	persisted, _ = s.repo.Task(parent.ID)
	unchanged, _ := s.repo.Task(first.ID)
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if persisted.Status != model.TaskStatusSucceeded || !strings.Contains(persisted.ResultJSON, "完整资产结果") || unchanged.Status != model.TaskStatusSucceeded || count != 5 {
		t.Fatalf("resume regenerated completed work or lost output: count=%d parent=%+v", count, persisted)
	}
}

func TestWorkflowBatchRepeatedVisitDoesNotCreateDuplicatesAndFencesOldLease(t *testing.T) {
	s, db := newBatchTestService(t)
	parent, err := s.CreateTask("batch-user", batchTestRequest())
	if err != nil {
		t.Fatal(err)
	}
	parent = claimBatchTestTask(t, s, db, parent.ID)
	raw, _ := s.decryptTaskInputJSON(parent.InputJSON)
	var input map[string]any
	_ = json.Unmarshal([]byte(raw), &input)
	for i := 0; i < 2; i++ {
		if _, pending, err := s.workflowBatchChild(parent, input, "test", "单元内容"); err != nil || !pending {
			t.Fatalf("visit: %v", err)
		}
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatalf("duplicate submission: %d", count)
	}
	// Repository transaction rejects a child from a cancelled or stale parent.
	db.Model(&model.Task{}).Where("id = ?", parent.ID).Updates(map[string]any{"status": model.TaskStatusCancelled, "lease_owner": ""})
	child := &model.Task{ID: "stale-child", UserID: parent.UserID, Status: model.TaskStatusQueued}
	if err := s.repo.CreateWorkflowBatchChild(parent, child, nil, 1); !errors.Is(err, repository.ErrTaskStateConflict) {
		t.Fatalf("stale lease admitted child: %v", err)
	}
}

func TestWorkflowBatchUsesRealWorkerAndFakeProviderWithoutBrowser(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"角色甲：第1、2集，固定资产依据\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	initial, db := newBatchTestService(t)
	s := New(repository.New(db), initial.dataDir)
	request := batchTestRequest()
	request.Input["config"].(map[string]any)["baseUrl"] = server.URL
	parent, err := s.CreateTask("batch-user", request)
	if err != nil {
		t.Fatal(err)
	}
	for turn := 0; turn < 10; turn++ {
		// Accelerate the scheduler's polling clock only when no child is queued.
		var pending int64
		db.Model(&model.Task{}).Where("operation <> ? AND status = ?", workflowBatchOperation, model.TaskStatusQueued).Count(&pending)
		if pending == 0 {
			db.Model(&model.Task{}).Where("id = ?", parent.ID).Update("next_poll_at", nil)
		}
		if err := s.taskWorker().processNextTask(); err != nil {
			t.Fatal(err)
		}
		current, _ := s.repo.Task(parent.ID)
		if current.Status == model.TaskStatusFailed {
			t.Fatalf("batch failed: %s", current.Error)
		}
		if current.Status == model.TaskStatusSucceeded {
			if calls.Load() != 3 {
				t.Fatalf("actual model calls = %d, expected two units plus final merge", calls.Load())
			}
			if current.BillingOrderID != "" || !strings.Contains(current.ResultJSON, "固定资产依据") {
				t.Fatal("invalid aggregate completion")
			}
			return
		}
	}
	t.Fatal("single-worker batch did not complete")
}

func TestWorkflowBatchChildCreditReservationRollsBackOnDuplicate(t *testing.T) {
	s, db := newBatchTestService(t)
	parent, err := s.CreateTask("batch-user", batchTestRequest())
	if err != nil {
		t.Fatal(err)
	}
	parent = claimBatchTestTask(t, s, db, parent.ID)
	if err := db.Create(&model.CreditAccount{UserID: parent.UserID, AvailableMicrocredits: 1000}).Error; err != nil {
		t.Fatal(err)
	}
	child := &model.Task{ID: "paid-child", UserID: parent.UserID, Type: "canvas_text", Status: model.TaskStatusQueued, BillingOrderID: "paid-order"}
	order := &model.BillingOrder{ID: "paid-order", TaskID: child.ID, UserID: child.UserID, IdempotencyKey: "paid-1", Status: model.BillingStatusReserved, BillingMode: "fixed_request", AmountMicrocredits: 100}
	if err := s.repo.CreateWorkflowBatchChild(parent, child, order, 1); err != nil {
		t.Fatal(err)
	}
	duplicate := *order
	duplicate.ID, duplicate.IdempotencyKey = "duplicate-order", "paid-duplicate"
	if err := s.repo.CreateWorkflowBatchChild(parent, child, &duplicate, 10); err == nil {
		t.Fatal("duplicate task was admitted")
	}
	account, err := s.repo.CreditAccount(parent.UserID)
	if err != nil {
		t.Fatal(err)
	}
	var count int64
	db.Model(&model.BillingOrder{}).Count(&count)
	if account.AvailableMicrocredits != 900 || account.ReservedMicrocredits != 100 || count != 1 {
		t.Fatalf("duplicate reservation leaked: %+v orders=%d", account, count)
	}
}

func TestWorkflowBatchMultiLevelMergeKeepsEveryPartBounded(t *testing.T) {
	s, db := newBatchTestService(t)
	parent, err := s.CreateTask("batch-user", batchTestRequest())
	if err != nil {
		t.Fatal(err)
	}
	childCount := 0
	for turn := 0; turn < 12; turn++ {
		parent = claimBatchTestTask(t, s, db, parent.ID)
		if err := s.processWorkflowTextBatch(parent); err != nil {
			t.Fatal(err)
		}
		stored, _ := s.repo.Task(parent.ID)
		if stored.Status == model.TaskStatusSucceeded {
			if childCount < 5 || !strings.Contains(stored.ResultJSON, "合并事实") {
				t.Fatal("large intermediate outputs skipped reduction")
			}
			return
		}
		child, err := s.repo.ClaimNextTask("child", time.Minute)
		if err != nil || child == nil || child.Operation == workflowBatchOperation {
			t.Fatalf("no next unit: %v", err)
		}
		if utf8.RuneCountInString(child.Prompt) > workflowBatchContextLimit+2000 {
			t.Fatal("unbounded model prompt")
		}
		var input struct {
			Metadata struct {
				Key string `json:"batchKey"`
			} `json:"metadata"`
		}
		json.Unmarshal([]byte(child.InputJSON), &input)
		text := "合并事实"
		if strings.HasPrefix(input.Metadata.Key, "map-") {
			text = strings.Repeat("集号和来源依据", 3200)
		}
		payload, _ := json.Marshal(map[string]any{"mode": "text", "text": text})
		if err := s.saveTaskCompletionWithinStorageQuota(child, payload, nil, false); err != nil {
			t.Fatal(err)
		}
		childCount++
	}
	t.Fatal("hierarchical merge failed to converge")
}

func TestWorkflowBatchRetryBlocksUncertainChargesAndCancellation(t *testing.T) {
	s, db := newBatchTestService(t)
	parent, err := s.CreateTask("batch-user", batchTestRequest())
	if err != nil {
		t.Fatal(err)
	}
	parent = claimBatchTestTask(t, s, db, parent.ID)
	parent.RouteRun = 2
	id := workflowBatchChildID(parent.ID, "test", "unit", 1)
	child := &model.Task{ID: id, UserID: parent.UserID, Type: "canvas_text", Status: model.TaskStatusFailed, BillingOrderID: "uncertain-order"}
	order := &model.BillingOrder{ID: child.BillingOrderID, UserID: parent.UserID, TaskID: id, IdempotencyKey: "uncertain", Status: model.BillingStatusUncertain}
	if err := db.Create(order).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(child).Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.workflowBatchChild(parent, nil, "test", "unit"); !errors.Is(err, errTaskBillingReview) {
		t.Fatalf("uncertain billing retried: %v", err)
	}
	db.Model(order).Update("status", model.BillingStatusRefunded)
	db.Model(child).Update("provider_cancel_status", model.ProviderCancelStatusUncertain)
	if _, _, err := s.workflowBatchChild(parent, nil, "test", "unit"); err == nil {
		t.Fatal("uncertain provider cancellation retried")
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatal("unsafe retry created new model work")
	}
}
