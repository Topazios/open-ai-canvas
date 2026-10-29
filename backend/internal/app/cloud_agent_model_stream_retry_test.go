package app

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func failInterruptedModelResponse(t *testing.T, db *gorm.DB, taskID string) {
	t.Helper()
	const message = "read tcp 192.0.2.1:1234->192.0.2.2:443: read: connection reset by peer"
	if err := db.Create(&model.ApiCallLog{ID: newID(), TaskID: taskID, StatusCode: 200, RequestKind: "create", Error: message}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{"status": model.TaskStatusFailed, "error": message}).Error; err != nil {
		t.Fatal(err)
	}
}

func TestProductionRuntimeRetriesInterruptedModelResponse(t *testing.T) {
	s, db, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	submitOrderedPlan(t, s, run.ID, "story", "", "故事总纲")
	before := mustPlanArtifacts(t, s, run.ID)
	task, done := productionRuntimeStart(t, s, run.ID, []map[string]any{{"role": "user", "content": "continue production"}})
	failInterruptedModelResponse(t, db, task.ID)
	var retryID string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		_, state := productionRuntimeState(t, s, run.ID)
		if state.ActiveTaskID != "" && state.ActiveTaskID != task.ID {
			retryID = state.ActiveTaskID
			for _, receipt := range state.ProductionModelReceipts {
				if receipt == task.ID {
					t.Fatal("failed receipt would replay instead of retrying")
				}
			}
			break
		}
		select {
		case got := <-done:
			t.Fatalf("model bridge returned before retry: %v", got.err)
		case <-time.After(10 * time.Millisecond):
		}
	}
	if retryID == "" {
		t.Fatal("interrupted model step was not rescheduled")
	}
	if got := productionRuntimeFinish(t, db, retryID, done, productionRuntimeCall("production_plan_inventory")); got.err != nil {
		t.Fatal(got.err)
	}
	if after := mustPlanArtifacts(t, s, run.ID); productionHash(after) != productionHash(before) {
		t.Fatal("retry changed already saved production artifacts")
	}
	_, state := productionRuntimeState(t, s, run.ID)
	if state.ActiveTaskID != "" {
		t.Fatal("successful retry left an active model step")
	}
}

func TestCloudAgentPiModelInterruptedResponseRetryLimit(t *testing.T) {
	s, db, _ := agentMediaFixture(t)
	s.disablePiRuntime = true
	s.legacyCloudAgentRootTask = false
	req := agentTestRequest()
	req.PermissionMode, req.ReasoningMode = "auto", "off"
	run, err := s.CreateCloudAgentRun("user", req, "")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	done := make(chan error, 1)
	finished := make(chan struct{})
	t.Cleanup(func() { cancel(); <-finished })
	go func() {
		defer close(finished)
		_, err := s.cloudAgentPiModel(ctx, "user", run.ID, map[string]json.RawMessage{"messages": json.RawMessage(`[{"role":"user","content":"continue"}]`), "thinkingLevel": json.RawMessage(`"off"`)})
		done <- err
	}()
	seen := map[string]bool{}
	for {
		select {
		case err := <-done:
			if err == nil || ctx.Err() != nil || len(seen) != cloudAgentModelStepRetries+1 {
				t.Fatalf("retry limit not respected: attempts=%d err=%v context=%v", len(seen), err, ctx.Err())
			}
			_, state := productionRuntimeState(t, s, run.ID)
			if state.ActiveTaskID != "" {
				t.Fatal("exhausted retry left a failed active step")
			}
			return
		case <-ctx.Done():
			t.Fatal("model step did not stop at the retry limit")
		case <-time.After(10 * time.Millisecond):
		}
		_, state := productionRuntimeState(t, s, run.ID)
		if id := state.ActiveTaskID; id != "" && !seen[id] {
			seen[id] = true
			if len(seen) > cloudAgentModelStepRetries+1 {
				t.Fatal("model bridge exceeded retry limit")
			}
			failInterruptedModelResponse(t, db, id)
		}
	}
}

func TestProductionParallelInterruptedResponseKeepsCompletedSibling(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 2 })
	cancel()
	<-done
	completeParallel(t, db, state.ProductionParallel["direction"])
	sibling, err := s.repo.Task(state.ProductionParallel["direction"].TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.settleProductionParallel("user", runID, state.ProductionParallel["direction"], sibling); err != nil {
		t.Fatal(err)
	}
	before := mustPlanArtifacts(t, s, runID)
	work := state.ProductionParallel["visual"]
	failInterruptedModelResponse(t, db, work.TaskID)
	failed, err := s.repo.Task(work.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.settleProductionParallel("user", runID, work, failed); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if work.TaskID != "" || work.Error != "" || work.RetryAt == 0 || work.Attempts != 1 {
		t.Fatalf("failed item was not scheduled for bounded retry: %+v", work)
	}
	if _, exists := state.ProductionParallel["direction"]; exists {
		t.Fatal("completed sibling was scheduled again")
	}
	if after := mustPlanArtifacts(t, s, runID); productionHash(after) != productionHash(before) {
		t.Fatal("failed sibling changed completed production artifacts")
	}
}

func TestProductionParallelTransientRetryBudgetExceedsSingleStepBudget(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 2 })
	cancel()
	<-done

	work := state.ProductionParallel["visual"]
	// A production document is idempotent, so transient provider failures use
	// the production retry budget after the ordinary Agent step budget is spent.
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
		item := state.ProductionParallel[work.Key]
		item.TransientAttempts = cloudAgentModelStepRetries
		state.ProductionParallel[work.Key] = item
	})
	work.TransientAttempts = cloudAgentModelStepRetries
	task, err := s.repo.Task(work.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.recordProductionParallelFailure("user", runID, work, task, errors.New("temporary upstream failure"), true); err != nil {
		t.Fatal(err)
	}
	_, after := productionRuntimeState(t, s, runID)
	work = after.ProductionParallel[work.Key]
	if work.Error != "" || work.TaskID != "" || work.RetryAt == 0 || work.TransientAttempts != cloudAgentModelStepRetries+1 {
		t.Fatalf("transient production failure exhausted the wrong budget: %+v", work)
	}
}
