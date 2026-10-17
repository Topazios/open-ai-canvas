package app

import (
	"context"
	"errors"
	"testing"
	"time"

	agentruntime "infinite-canvas/backend/internal/agent/runtime"
	"infinite-canvas/backend/internal/model"
)

func updateTestGlobalConcurrency(t *testing.T, s *Service, configure func(*RuntimePolicySetting)) {
	t.Helper()
	policy, err := s.RuntimePolicy()
	if err != nil {
		t.Fatal(err)
	}
	configure(&policy)
	if _, err := s.UpdateRuntimePolicySetting(&model.User{ID: "admin", Role: model.UserRoleAdmin}, policy); err != nil {
		t.Fatal(err)
	}
}

func TestProductionParallelFollowsPolicyChangesAndRestoresLargerCheckpoint(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	submitOrderedPlan(t, s, runID, "visual", "", "美术规范")
	submitOrderedPlan(t, s, runID, "direction", "", "导演规范")
	updateTestGlobalConcurrency(t, s, func(p *RuntimePolicySetting) {
		p.Task.AgentConcurrency = 1
		p.Task.TextConcurrency = 9
		p.Task.ActiveTaskLimit = 99
	})
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 1 })
	first := state.ProductionParallel["character"]
	if first.TaskID == "" {
		t.Fatal("first independent dossier was not admitted")
	}
	updateTestGlobalConcurrency(t, s, func(p *RuntimePolicySetting) { p.Task.AgentConcurrency = 4 })
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 4 })
	if state.ProductionParallel["character"].TaskID != first.TaskID || state.ProductionParallel["sound"].TaskID != "" {
		t.Fatal("policy expansion duplicated work or crossed a dependency barrier")
	}
	if view := s.productionAgentProgress("user", runID, &state); view.ConcurrencyLimit != 4 {
		t.Fatalf("progress did not read global policy: %+v", view)
	}
	cancel()
	<-done
	updateTestGlobalConcurrency(t, s, func(p *RuntimePolicySetting) { p.Task.AgentConcurrency = 1 })
	// Decode and resume a four-call checkpoint under a smaller policy. Existing
	// receipts remain valid; a pending retry must also wait for the new capacity.
	work := state.ProductionParallel["special"]
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
		work.TaskID = ""
		state.ProductionParallel["special"] = work
	})
	cancel, done = startParallel(t, s, runID)
	completeParallel(t, db, state.ProductionParallel["character"])
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { _, exists := state.ProductionParallel["character"]; return !exists })
	completeParallel(t, db, state.ProductionParallel["environment"])
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool {
		_, exists := state.ProductionParallel["environment"]
		return !exists
	})
	// Give the real scheduler more than one pass while the last old call holds
	// the sole global slot, then assert neither a retry nor sound was submitted.
	time.Sleep(300 * time.Millisecond)
	_, state = productionRuntimeState(t, s, runID)
	if state.ProductionParallel["special"].TaskID != "" || state.ProductionParallel["sound"].TaskID != "" {
		t.Fatal("policy shrink admitted new or retry work before old requests drained")
	}
	completeParallel(t, db, state.ProductionParallel["prop"])
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["sound"].TaskID != "" })
	if state.ProductionParallel["special"].TaskID != "" {
		t.Fatal("retry bypassed the global agent window")
	}
	completeParallel(t, db, state.ProductionParallel["sound"])
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["special"].TaskID != "" })
	completeParallel(t, db, state.ProductionParallel["special"])
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("parallel phase did not finish")
	}
	cancel()
}

func TestMediaRecoverySlotsFollowGlobalPolicyAndRelease(t *testing.T) {
	s, _ := newMediaRecoveryTestService(t)
	updateTestGlobalConcurrency(t, s, func(p *RuntimePolicySetting) { p.Resource.MediaRecoveryConcurrency = 1 })
	_, release1, err := s.acquireMediaRecoverySlot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release1()
	if _, _, err := s.acquireMediaRecoverySlot(context.Background()); !errors.Is(err, errMediaRecoveryBusy) {
		t.Fatalf("ignored resource concurrency: %v", err)
	}
	updateTestGlobalConcurrency(t, s, func(p *RuntimePolicySetting) { p.Resource.MediaRecoveryConcurrency = 3 })
	ctx2, release2, err := s.acquireMediaRecoverySlot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release2()
	_, release3, err := s.acquireMediaRecoverySlot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release3()
	updateTestGlobalConcurrency(t, s, func(p *RuntimePolicySetting) { p.Resource.MediaRecoveryConcurrency = 1 })
	if ctx2.Err() != nil {
		t.Fatal("policy shrink cancelled active storage")
	}
	release1()
	release2()
	if _, _, err := s.acquireMediaRecoverySlot(context.Background()); !errors.Is(err, errMediaRecoveryBusy) {
		t.Fatalf("admitted before draining old slots: %v", err)
	}
	release3()
	_, release4, err := s.acquireMediaRecoverySlot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	release4()
}

func TestAgentSessionGateRefreshesGlobalPolicy(t *testing.T) {
	t.Setenv("YINGCE_AGENT_URL", "")
	s, _ := newMediaRecoveryTestService(t)
	_, before := agentruntime.ProcessUsage()
	t.Cleanup(func() { agentruntime.SetProcessLimit(before) })
	updateTestGlobalConcurrency(t, s, func(p *RuntimePolicySetting) { p.Task.AgentMaxSessions = 2 })
	applied, err := s.syncAgentSessionLimit(context.Background(), 0)
	if err != nil || applied != 2 {
		t.Fatalf("initial sync: %d %v", applied, err)
	}
	updateTestGlobalConcurrency(t, s, func(p *RuntimePolicySetting) { p.Task.AgentMaxSessions = 7 })
	applied, err = s.syncAgentSessionLimit(context.Background(), applied)
	_, effective := agentruntime.ProcessUsage()
	if err != nil || applied != 7 || effective != 7 {
		t.Fatalf("policy update not applied: %d %d %v", applied, effective, err)
	}
}
