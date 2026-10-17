package app

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func parallelPlanFixture(t *testing.T) (*Service, *gorm.DB, string) {
	t.Helper()
	s, db, run := planFixture(t, 2)
	m, doc, rows := orderedPlanState(t, s, run.ID)
	if len(productionParallelReady(m, doc, rows)) != 0 {
		t.Fatal("unread topic admitted parallel work")
	}
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := submitOrderedPlan(t, s, run.ID, "story", "", "故事总纲")
	items := []productionPlanAsset{}
	for _, kind := range []string{"sound", "character", "environment", "prop", "special"} {
		item := productionPlanAsset{Key: kind, Kind: kind, Name: "测试" + kind, Purpose: "剧情必要资产", PlannedRange: "第一篇章", Episodes: []int{1}}
		if kind == "sound" {
			item.DependsOn = []string{"character"}
		}
		items = append(items, item)
	}
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{StoryHash: story["hash"].(string), Assets: items, Complete: true}, false)
	return s, db, run.ID
}

func TestProductionParallelDrainPreservesCheckpoint(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	run, state := productionRuntimeState(t, s, runID)
	before := run.StateJSON
	s.BeginDrain()
	if _, err := s.runProductionParallel(context.Background(), "user", runID); !errors.Is(err, context.Canceled) {
		t.Fatalf("draining scheduler should yield: %v", err)
	}
	if err := s.enqueueCloudAgentTaskWithWork(run, &state, CreateTaskRequest{}, nil, &productionParallelWork{Key: "visual"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("draining admission should yield: %v", err)
	}
	after, _ := productionRuntimeState(t, s, runID)
	if after.StateJSON != before || after.Status != run.Status || after.FailureMessage != run.FailureMessage {
		t.Fatal("shutdown changed the persisted run or marked it failed")
	}
}

func waitParallel(t *testing.T, s *Service, runID string, ready func(cloudAgentRuntime) bool) cloudAgentRuntime {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		_, state := productionRuntimeState(t, s, runID)
		if ready(state) {
			return state
		}
		time.Sleep(10 * time.Millisecond)
	}
	_, state := productionRuntimeState(t, s, runID)
	t.Fatalf("parallel checkpoint did not advance: %+v", state.ProductionParallel)
	return state
}

func startParallel(t *testing.T, s *Service, runID string) (context.CancelFunc, <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	finished := make(chan struct{})
	go func() { defer close(finished); _, err := s.runProductionParallel(ctx, "user", runID); done <- err }()
	t.Cleanup(func() { cancel(); <-finished })
	return cancel, done
}

func completeParallel(t *testing.T, db *gorm.DB, work productionParallelWork) {
	t.Helper()
	kind := work.Key
	if _, ok := planSection(work.Key); ok {
		kind = ""
	}
	args, _ := json.Marshal(map[string]any{"key": work.Key, "name": work.Name, "document": orderedPlanDocument(work.Key, kind), "factIds": []string{}})
	call := productionRuntimeCall("production_submit")
	call.Function.Arguments = string(args)
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": productionRuntimeResult(t, call)}).Error; err != nil {
		t.Fatal(err)
	}
}

func TestProductionParallelDependenciesPauseRestartAndOutOfOrder(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	_, initial := productionRuntimeState(t, s, runID)
	initialTasks := len(initial.TaskIDs)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 2 })
	if state.ProductionParallel["visual"].TaskID == "" || state.ProductionParallel["direction"].TaskID == "" || state.ActiveTaskID != "" {
		t.Fatal("standards not independently scheduled")
	}
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ProductionPaused = true })
	completeParallel(t, db, state.ProductionParallel["direction"])
	waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 1 })
	completeParallel(t, db, state.ProductionParallel["visual"])
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 0 })
	if len(state.TaskIDs) != initialTasks+2 {
		t.Fatalf("paused job dispatched assets: %v", state.TaskIDs)
	}
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ProductionPaused = false })
	cancel, done = startParallel(t, s, runID)
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 3 })
	if _, ok := state.ProductionParallel["sound"]; ok {
		t.Fatal("dependent sound started before character")
	}
	if len(state.TaskIDs) != initialTasks+5 {
		t.Fatalf("duplicate calls after restart: %v", state.TaskIDs)
	}
	// Recover the same three in-flight task IDs after another process boundary.
	cancel()
	<-done
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	_, done = startParallel(t, s, runID)
	completeParallel(t, db, state.ProductionParallel["environment"])
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["special"].TaskID != "" })
	if len(state.ProductionParallel) != 3 || len(state.TaskIDs) != initialTasks+6 {
		t.Fatal("incorrect concurrency/receipt reuse")
	}
	completeParallel(t, db, state.ProductionParallel["character"])
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["sound"].TaskID != "" })
	for _, work := range state.ProductionParallel {
		completeParallel(t, db, work)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("parallel phase did not finish")
	}
	_, state = productionRuntimeState(t, s, runID)
	if len(state.TaskIDs) != initialTasks+7 || len(state.ProductionParallel) != 0 {
		t.Fatalf("duplicate or uncommitted tasks: %+v", state.ProductionParallel)
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	for _, row := range rows {
		if !productionPlanArtifactValid(m, doc, rows, row.Key) {
			t.Fatalf("invalid committed result %s", row.Key)
		}
	}
	if len(m.Plan.Groups) != 5 {
		t.Fatal("missing category groups")
	}
	progress := s.productionAgentProgress("user", runID, &state)
	if progress.DocumentCount != 4 || progress.AssetCount != 5 || progress.DocumentTotal != 5 {
		t.Fatalf("incorrect counts: %+v", progress)
	}
	submitOrderedPlan(t, s, runID, "generation", "", "生成规范")
	if report := productionCall(t, s, runID, "production_check", map[string]any{}, false); report["valid"] != true {
		t.Fatal(report)
	}
}

func TestProductionPlanRegroupPreservesReceiptsAndFillsFirstCell(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	submitOrderedPlan(t, s, runID, "visual", "", "美术规范")
	submitOrderedPlan(t, s, runID, "direction", "", "导演规范")
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	submitOrderedPlan(t, s, runID, "sound", "sound", "测试sound")
	_, before, rows := orderedPlanState(t, s, runID)
	contents := map[string]string{}
	identities := map[string]string{}
	for _, row := range rows {
		node := productionNode(before, row.NodeID)
		contents[row.NodeID] = node["metadata"].(map[string]any)["content"].(string)
		identities[row.NodeID] = productionStoredValueHash(productionWorkflow(node)["assetIdentity"])
	}
	if changed, err := s.ensureProductionPlanGroups("user", runID); err != nil || !changed {
		t.Fatal(changed, err)
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	for _, row := range rows {
		node := productionNode(doc, row.NodeID)
		if node["metadata"].(map[string]any)["content"] != contents[row.NodeID] || productionStoredValueHash(productionWorkflow(node)["assetIdentity"]) != identities[row.NodeID] || !productionPlanArtifactValid(m, doc, rows, row.Key) {
			t.Fatalf("regroup changed content or invalidated receipt: %s", row.Key)
		}
		if row.Key == "story" || row.Key == "character" {
			frame := productionNode(doc, productionPlanParent(m, row.Key))
			p := frame["position"].(map[string]any)
			np := node["position"].(map[string]any)
			if numberValue(np["x"], 0)-numberValue(p["x"], 0) != 24 || numberValue(np["y"], 0)-numberValue(p["y"], 0) != 100 {
				t.Fatalf("empty first cell: %v %v", p, np)
			}
		}
	}
	if productionStoredValueHash(productionNode(doc, m.FrameID)["position"]) != productionStoredValueHash(productionNode(before, m.FrameID)["position"]) {
		t.Fatal("regroup pushed the root away from its former children")
	}
	if changed, err := s.ensureProductionPlanGroups("user", runID); err != nil || changed {
		t.Fatal("regroup not idempotent", changed, err)
	}
}

func TestProductionParallelRejectsChangedPredecessorWithoutRetry(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 2 })
	cancel()
	<-done
	work := state.ProductionParallel["visual"]
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		for _, node := range creationMaps(doc["nodes"]) {
			if productionWorkflow(node)["assetKey"] == "story" {
				node["metadata"].(map[string]any)["content"] = "edited"
			}
		}
	})
	completeParallel(t, db, work)
	task, err := s.repo.Task(work.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.settleProductionParallel("user", runID, work, task); err == nil {
		t.Fatal("changed predecessor accepted")
	}
	_, after := productionRuntimeState(t, s, runID)
	if after.ProductionParallel["visual"].TaskID != work.TaskID || len(after.TaskIDs) != len(state.TaskIDs) {
		t.Fatal("source change created retry")
	}
}

func TestProductionParallelCancellationCleansAllChildren(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 2 })
	cancel()
	<-done
	if err := s.CancelCloudAgent(context.Background(), "user", runID); err != nil {
		t.Fatal(err)
	}
	for _, work := range state.ProductionParallel {
		task, err := s.repo.Task(work.TaskID)
		if err != nil || !cloudAgentTaskTerminal(task.Status) {
			t.Fatal("orphaned child task", task, err)
		}
	}
	run, _ := productionRuntimeState(t, s, runID)
	if run.Status != "cancelled" || run.CleanupPending {
		t.Fatal("cancellation did not finish")
	}
}

func TestProductionPlanLayoutReservesTitleSpaceAndIgnoresTaskAnchor(t *testing.T) {
	m := productionManifest{FrameID: "root", Plan: &productionPlan{Version: 2}}
	frame := map[string]any{"id": "root", "position": map[string]any{"x": 10.0, "y": 20.0}}
	nodes := []map[string]any{frame}
	byKey := map[string]map[string]any{}
	for _, key := range []string{"generation", "$summary", "direction", "inventory", "story", "visual"} {
		node := map[string]any{"id": key, "parentId": "root", "metadata": map[string]any{"shortDrama": map[string]any{"assetKey": key}}}
		nodes = append(nodes, node)
		byKey[key] = node
	}
	productionLayoutPlanGroup(m, frame, nodes)
	for index, key := range []string{"story", "inventory", "visual", "direction", "generation"} {
		node := byKey[key]
		p := node["position"].(map[string]any)
		if numberValue(p["x"], 0) != 34+float64(index%3)*424 || numberValue(p["y"], 0) != 120+float64(index/3)*productionPlanRowPitch || node["width"] != 400 || node["height"] != 280 {
			t.Fatal("grid order or size", key, node)
		}
	}
	if productionPlanRowPitch-280 < 48 {
		t.Fatal("titles overlap preceding cards")
	}
	if byKey["$summary"]["position"] != nil {
		t.Fatal("hidden task anchor occupies a grid cell")
	}
}

func TestProductionParallelWaitsForAccountSlotsWithoutFailingRun(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	policy, err := s.RuntimePolicy()
	if err != nil {
		t.Fatal(err)
	}
	active, err := s.repo.ActiveTaskCountForKind("user", model.TaskConcurrencyAgent)
	if err != nil {
		t.Fatal(err)
	}
	if policy.Task.ActiveTaskLimit <= 0 {
		t.Fatal("fixture needs a bounded account queue")
	}
	for i := active; i < int64(policy.Task.ActiveTaskLimit); i++ {
		if err := db.Create(&model.Task{ID: "busy-" + newID(), UserID: "user", Type: "canvas_text", Operation: cloudAgentStepOperation, Status: model.TaskStatusQueued}).Error; err != nil {
			t.Fatal(err)
		}
	}
	_, initial := productionRuntimeState(t, s, runID)
	cancel, done := startParallel(t, s, runID)
	// No new slot is available, even though no parallel item is in flight yet.
	time.Sleep(600 * time.Millisecond)
	run, state := productionRuntimeState(t, s, runID)
	if cloudAgentRunTerminal(run.Status) || len(state.TaskIDs) != len(initial.TaskIDs) {
		t.Fatal("full queue failed the run or dispatched a task")
	}
	if err := db.Model(&model.Task{}).Where("user_id = ? AND id LIKE ?", "user", "busy-%").Update("status", model.TaskStatusSucceeded).Error; err != nil {
		t.Fatal(err)
	}
	waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 2 })
	cancel()
	<-done
}

func TestProductionParallelInvalidOutputAndExplicitResumeKeepCompletedSibling(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 2 })
	cancel()
	<-done
	completeParallel(t, db, state.ProductionParallel["direction"])
	task, _ := s.repo.Task(state.ProductionParallel["direction"].TaskID)
	if err := s.settleProductionParallel("user", runID, state.ProductionParallel["direction"], task); err != nil {
		t.Fatal(err)
	}
	work := state.ProductionParallel["visual"]
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"toolCalls":[]}`}).Error; err != nil {
		t.Fatal(err)
	}
	task, _ = s.repo.Task(work.TaskID)
	if err := s.settleProductionParallel("user", runID, work, task); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	if state.ProductionParallel["visual"].TaskID != "" || state.ProductionParallel["visual"].Correction == "" || state.ProductionParallel["visual"].RetryAt == 0 {
		t.Fatal("invalid output not scheduled for local correction")
	}
	// Exhaustion belongs to this item only; continuing must keep its sibling.
	run, err := s.repo.CloudAgent("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, _ := cloudAgentDecode(current)
		work := state.ProductionParallel["visual"]
		work.Error = "字段待补齐"
		work.Attempts = 4
		state.ProductionParallel["visual"] = work
		current.Status = "failed"
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err = s.ControlProductionAgent("user", runID, "resume"); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	if state.ProductionParallel["visual"].Error != "" || state.ProductionParallel["visual"].Attempts != 0 {
		t.Fatal("failed item cannot resume")
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "direction") {
		t.Fatal("successful sibling lost")
	}
	ready := productionParallelReady(m, doc, rows)
	if len(ready) != 1 || ready[0].Key != "visual" {
		t.Fatalf("resume redoes saved work: %+v", ready)
	}
}
