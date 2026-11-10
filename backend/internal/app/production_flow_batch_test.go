package app

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func batchTestGraph(root string) productionFlowGraph {
	return productionFlowGraph{Root: root, Source: "v2", UserID: "user", RunID: "run", Existing: map[string]model.ProductionFlowUnit{}, Aggregates: map[string][]model.ProductionFlowUnit{}}
}

func adoptBatchGraphUnit(t *testing.T, g *productionFlowGraph, u model.ProductionFlowUnit, reply any) {
	t.Helper()
	result, issues := productionFlowValidate(u, productionFlowJSON(reply))
	if len(issues) != 0 {
		t.Fatalf("%s: %+v", u.Stage, issues)
	}
	u.ResultJSON, u.Status = result, "accepted"
	g.Existing[u.ID] = u
}

func TestProductionFlowBatchesPackWithoutLosingSourceIdentity(t *testing.T) {
	sources := []productionFlowSource{}
	for i := 0; i < 136; i++ {
		sources = append(sources, productionFlowSource{ID: fmt.Sprint(i), Text: strings.Repeat("文", 500)})
	}
	batches := productionFlowSourceBatches(sources)
	if len(batches) != 34 {
		t.Fatal("small sources were not packed", len(batches))
	}
	seen := 0
	for _, batch := range batches {
		for _, src := range batch {
			if src.ID != fmt.Sprint(seen) {
				t.Fatal("source order/identity changed")
			}
			seen++
		}
	}
	g := batchTestGraph("inventory")
	if productionFlowInventoryGraph(&g, sources) {
		t.Fatal("unextracted registry completed")
	}
	if len(g.Units) != 34 {
		t.Fatal("mandatory second model pass or atomic extraction returned", len(g.Units))
	}
	for _, u := range g.Units {
		if u.Stage != "extract" {
			t.Fatal(u.Stage)
		}
	}
}

func TestProductionFlowIntegratedCoverageRequiresEverySourceAndSound(t *testing.T) {
	g := batchTestGraph("inventory")
	productionFlowInventoryGraph(&g, []productionFlowSource{{ID: "a", Text: "林岚推门。"}, {ID: "b", Text: "林岚看照片。"}})
	u := g.Units[0]
	reply := flowReply(u).(map[string]any)
	reviews := reply["sourceReviews"].([]productionFlowSourceReview)
	reply["sourceReviews"] = reviews[:1]
	result, issues := productionFlowValidate(u, productionFlowJSON(reply))
	if len(issues) == 0 || !strings.Contains(productionFlowJSON(issues), "source_coverage") {
		t.Fatal("second source was silently ignored")
	}
	u.ResultJSON = result
	reply["sourceReviews"] = reviews
	reply["candidates"] = []productionFlowCandidate{}
	result, issues = productionFlowValidate(u, productionFlowJSON(reply))
	if len(issues) != 0 {
		t.Fatal("local coverage repair lost valid candidates", issues)
	}
	u.ResultJSON = result
	value := productionFlowValue(u)
	if len(value["candidates"].([]any)) != 2 {
		t.Fatal("accepted extraction was recreated/lost")
	}
	delete(reply, "soundReview")
	u.ResultJSON = "{}"
	_, issues = productionFlowValidate(u, productionFlowJSON(reply))
	if !strings.Contains(productionFlowJSON(issues), "missing_sound_review") {
		t.Fatal("sound coverage was relaxed")
	}
}

func TestProductionFlowControlBoundsRetriesAndReducesCongestion(t *testing.T) {
	var c productionFlowControl
	c.initialize("inventory", "v2", 100, 136)
	if c.Window != 8 || c.RetryBudget != 24 {
		t.Fatal(c)
	}
	now := time.Now()
	c.congestion(now)
	if c.limit(100, now) != 0 || c.limit(100, now.Add(16*time.Second)) != 4 {
		t.Fatal("no backpressure", c)
	}
	c.congestion(now.Add(time.Second))
	if c.Window != 4 {
		t.Fatal("old in-flight failures repeatedly collapsed window")
	}
	for i := 0; i < 24; i++ {
		if !c.retry() {
			t.Fatal("early budget exhaustion")
		}
	}
	if c.retry() || c.TotalRetries != 24 {
		t.Fatal("unbounded retry", c)
	}
	for i := 0; i < 4; i++ {
		c.accepted(100)
	}
	if c.Window != 5 {
		t.Fatal("window did not recover on accepted throughput", c)
	}
}

func TestProductionFlowWaitUsesTerminalEventsAndCancellation(t *testing.T) {
	events := make(chan CanvasTaskEventView, 2)
	events <- CanvasTaskEventView{TaskID: "foreign", Status: model.TaskStatusSucceeded}
	events <- CanvasTaskEventView{TaskID: "ours", Status: model.TaskStatusSucceeded}
	started := time.Now()
	if err := productionFlowWait(context.Background(), events, map[string]productionParallelWork{"unit": {TaskID: "ours"}}); err != nil || time.Since(started) > 200*time.Millisecond {
		t.Fatal("notification did not wake scheduler", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := productionFlowWait(ctx, nil, nil); err != context.Canceled {
		t.Fatal("stop did not wake scheduler", err)
	}
}

func TestProductionFlowIntegratedExtractionSplitAggregatesCoverageLocally(t *testing.T) {
	g := batchTestGraph("inventory")
	productionFlowInventoryGraph(&g, []productionFlowSource{{ID: "a", Text: "林岚推门。"}, {ID: "b", Text: "林岚查看相机。"}})
	u := g.Units[0]
	if !productionFlowRestructure(&u) {
		t.Fatal("source batch did not split")
	}
	g.Units = nil
	g.splitChildren(u)
	children := append([]model.ProductionFlowUnit(nil), g.Units...)
	for i := range children {
		children[i].ResultJSON, _ = productionFlowValidate(children[i], productionFlowJSON(flowReply(children[i])))
	}
	result, issues := productionFlowAggregate(u, children)
	if len(issues) != 0 {
		t.Fatal("source/coverage references broke on aggregation", issues, result)
	}
}

func TestProductionFlowAdmissionSubmitsSeveralAssignmentsWithoutRebuildingGraph(t *testing.T) {
	s, _, id := flowFixture(t)
	for pass := 0; pass < 3; pass++ {
		g, _ := flowGraph(t, s, id, "story")
		for _, u := range g.Units {
			if u.Status == "accepted" {
				continue
			}
			if u.Stage == "registry" {
				break
			}
			result, issues := productionFlowValidate(u, productionFlowJSON(flowReply(u)))
			if len(issues) > 0 {
				t.Fatal(issues)
			}
			u.ResultJSON, u.Status = result, "accepted"
			if err := s.repo.SaveProductionFlowUnit(&u, u.TaskID, u.Generation); err != nil {
				t.Fatal(err)
			}
		}
	}
	g, _ := flowGraph(t, s, id, "story")
	if len(g.Units) != 3+len(productionCurrentPlanKinds) {
		t.Fatal("expected independent registry assignments for all categories", len(g.Units))
	}
	run, state := productionRuntimeState(t, s, id)
	if _, err := s.claimProductionFlow(run, &state, "batch-owner"); err != nil {
		t.Fatal(err)
	}
	run, state = productionRuntimeState(t, s, id)
	m, doc, rows := orderedPlanState(t, s, id)
	before := len(state.TaskIDs)
	if changed, err := s.advanceProductionFlow(run, &state, m, doc, rows, "story"); err != nil || !changed {
		t.Fatal(changed, err)
	}
	_, state = productionRuntimeState(t, s, id)
	if len(state.TaskIDs)-before < 2 {
		t.Fatal("independent registry assignments not admitted together", state.ProductionFlowControl)
	}
}

func TestProductionFlowExhaustedBudgetRecoversAutomaticallyBeforeHolding(t *testing.T) {
	s, _, id := flowFixture(t)
	g, _ := flowGraph(t, s, id, "story")
	u := g.Units[0]
	u.Status = "repair"
	if err := s.repo.SaveProductionFlowUnit(&u, u.TaskID, u.Generation); err != nil {
		t.Fatal(err)
	}
	mutateParallelState(t, s, id, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.ProductionFlowControl = productionFlowControl{Scope: "story:" + g.Source, Window: 8, RetrySpent: 6, RetryBudget: 6, TotalRetries: 12, Submitted: 20, Received: 20}
	})
	run, state := productionRuntimeState(t, s, id)
	m, doc, rows := orderedPlanState(t, s, id)
	before := len(state.TaskIDs)
	if changed, err := s.advanceProductionFlow(run, &state, m, doc, rows, "story"); err != nil || !changed {
		t.Fatal(changed, err)
	}
	run, state = productionRuntimeState(t, s, id)
	if run.Status != "running" || state.ProductionPaused || len(state.TaskIDs) != before || state.ProductionFlowControl.RecoveryRounds != 1 || state.ProductionFlowControl.CooldownUntil <= time.Now().UnixMilli() {
		t.Fatal("retry window required a manual continuation", run.Status, state.ProductionFlowControl)
	}
	mutateParallelState(t, s, id, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.ProductionFlowControl.RetrySpent = state.ProductionFlowControl.RetryBudget
		state.ProductionFlowControl.RecoveryRounds = 3
		state.ProductionFlowControl.CooldownUntil = 0
	})
	run, state = productionRuntimeState(t, s, id)
	if changed, err := s.advanceProductionFlow(run, &state, m, doc, rows, "story"); err != nil || !changed {
		t.Fatal(changed, err)
	}
	run, state = productionRuntimeState(t, s, id)
	if run.Status != "waiting_user" || !state.ProductionPaused || len(state.TaskIDs) != before || !strings.Contains(run.FailureMessage, "多轮自动恢复") {
		t.Fatal("exhausted run kept dispatching or lost its reason", run.Status, state.ProductionFlowControl)
	}
	if err := s.repo.MutateCloudAgent(run.UserID, id, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		if err := productionFlowResetHeld(repo, current, &state, ""); err != nil {
			return err
		}
		state.ProductionPaused = false
		current.Status = "running"
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	run, state = productionRuntimeState(t, s, id)
	c := state.ProductionFlowControl
	if c.TotalRetries != 12 || c.Submitted != 20 || c.Received != 20 || c.RetrySpent != 0 || c.ManualRounds != 1 || c.Window != 4 || c.RecoveryRounds != 0 {
		t.Fatal("manual continuation reset cumulative counters", c)
	}
	saved, err := s.repo.ProductionFlowUnit(run.UserID, id, g.Units[0].ID)
	if err != nil || saved.Status != "repair" {
		t.Fatal("manual continuation recreated pending assignment", err, saved)
	}
	if _, err := s.claimProductionFlow(run, &state, "manual-budget-resume"); err != nil {
		t.Fatal(err)
	}
	run, state = productionRuntimeState(t, s, id)
	m, doc, rows = orderedPlanState(t, s, id)
	if changed, err := s.advanceProductionFlow(run, &state, m, doc, rows, "story"); err != nil || !changed {
		t.Fatal("pending assignment did not resume", changed, err)
	}
	_, state = productionRuntimeState(t, s, id)
	if len(state.TaskIDs) != before+1 || state.ProductionFlowControl.Submitted != 21 {
		t.Fatal("continuation did not admit exactly one preserved assignment", state.ProductionFlowControl)
	}
}

func TestProductionFlowSourceCacheCannotHideChangedAdoptionOrLeakMutations(t *testing.T) {
	s, db, id := flowFixture(t)
	publishFlowTestRoot(t, s, db, id, "story")
	run, _ := productionRuntimeState(t, s, id)
	m, doc, rows := orderedPlanState(t, s, id)
	cache := newProductionFlowSourceCache()
	sections, bodies, err := productionFlowPublishedSources(s.repo, run, m, doc, rows, cache)
	if err != nil {
		t.Fatal(err)
	}
	key, expected := sections[0], bodies[sections[0]]
	bodies[key] = "corrupted"
	_, bodies, err = productionFlowPublishedSources(s.repo, run, m, doc, rows, cache)
	if err != nil || bodies[key] != expected {
		t.Fatal("cached source shared mutable state", err)
	}
	if err := db.Model(&model.ProductionFlowUnit{}).Where("id = ?", m.Plan.FlowStoryUnits[0]).Update("status", "held").Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err := productionFlowPublishedSources(s.repo, run, m, doc, rows, cache); err == nil {
		t.Fatal("cache bypassed current adoption check")
	}
}
