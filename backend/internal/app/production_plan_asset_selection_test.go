package app

import (
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestProductionPlanSelectedAssetsFinishAndAppend(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	for _, keys := range [][]string{nil, {"unknown"}} {
		if err := s.GenerateProductionPlanAssets("user", runID, keys); err == nil {
			t.Fatalf("invalid selection admitted: %v", keys)
		}
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character", "character"}, ProductionAssetModelSelection{}); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal("duplicate request was not idempotent", err)
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	if len(m.Plan.SelectedAssetKeys) != 1 || len(productionParallelReady(m, doc, rows)) != 1 || productionPlanPrerequisites(m, doc, rows, "prop") == nil {
		t.Fatal("selection did not constrain both scheduling and submit")
	}
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal("subset cannot finish", err)
	}
	_, _, before := orderedPlanState(t, s, runID)
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"sound"}); err != nil {
		t.Fatal("cannot append after restart", err)
	}
	m, doc, rows = orderedPlanState(t, s, runID)
	ready := productionParallelReady(m, doc, rows)
	if len(ready) != 1 || ready[0].Key != "sound" || len(rows) != len(before) {
		t.Fatal("append regenerated existing or unselected assets")
	}
	submitOrderedPlan(t, s, runID, "sound", "sound", "测试sound")
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	m, doc, rows = orderedPlanState(t, s, runID)
	for _, previous := range before {
		for _, current := range rows {
			if current.Key == previous.Key && current.ContentHash != previous.ContentHash {
				t.Fatal("saved asset changed")
			}
		}
	}
	_, state := productionRuntimeState(t, s, runID)
	progress := s.productionAgentProgress("user", runID, &state)
	if progress.AssetCount != 2 || progress.AssetTotal != 5 || progress.TotalPages != 6 || !progress.Validated || len(progress.Assets) != 5 {
		t.Fatalf("inaccurate selected vs total progress: %+v", progress)
	}
}

func TestProductionPlanAssetGenerationCreatesReusableCanvasPlaceholders(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character", "environment"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	m, doc, _ := orderedPlanState(t, s, runID)
	placeholders := map[string]string{}
	for _, node := range creationMaps(doc["nodes"]) {
		workflow := productionWorkflow(node)
		generation, _ := workflow["planGeneration"].(map[string]any)
		if generation["runId"] == runID {
			placeholders[stringValue(workflow["assetKey"])] = stringValue(node["id"])
		}
	}
	if len(placeholders) != 2 || placeholders["character"] == "" || placeholders["environment"] == "" {
		t.Fatalf("selected assets were not materialized on canvas: %#v; started=%v selected=%v groups=%v", placeholders, m.Plan.AssetsStarted, m.Plan.SelectedAssetKeys, m.Plan.Groups)
	}
	for _, key := range []string{"character", "environment"} {
		item := productionPlanItem(m, key)
		if m.Plan.Groups[productionPlanGroupKind(*item)] == "" || productionNode(doc, m.Plan.Groups[productionPlanGroupKind(*item)]) == nil {
			t.Fatalf("asset group missing for %s", key)
		}
		workflow := productionWorkflow(productionNode(doc, placeholders[key]))
		sources, ok := workflow["sourceNodeIds"].([]any)
		if !ok || len(sources) != 1 || sources[0] != m.FrameID {
			t.Fatalf("asset placeholder has invalid workflow sources: %#v", workflow)
		}
	}
	run, err := s.repo.CloudAgent("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	runState, err := cloudAgentDecode(run)
	if err != nil {
		t.Fatal(err)
	}
	canvas, err := s.repo.CanvasProjectForUser("user", runState.Request.CanvasID)
	if err != nil {
		t.Fatal(err)
	}
	staleDoc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	delete(productionWorkflow(productionNode(staleDoc, placeholders["character"])), "sourceNodeIds")
	stalePayload, err := json.Marshal(staleDoc)
	if err != nil {
		t.Fatal(err)
	}
	canvas.PayloadJSON = string(stalePayload)
	if err := s.repo.UpsertCanvasProject(canvas); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	_, repairedDoc, _ := orderedPlanState(t, s, runID)
	repairedSources, ok := productionWorkflow(productionNode(repairedDoc, placeholders["character"]))["sourceNodeIds"].([]any)
	if !ok || len(repairedSources) != 1 || repairedSources[0] != m.FrameID {
		t.Fatalf("existing asset placeholder was not repaired: %#v", repairedSources)
	}
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "character") {
		t.Fatal("generated asset receipt missing")
	}
	var characterRow *model.ProductionAgentArtifact
	for i := range rows {
		if rows[i].Key == "character" {
			characterRow = &rows[i]
			break
		}
	}
	if characterRow == nil || characterRow.NodeID != placeholders["character"] || productionWorkflow(productionNode(doc, characterRow.NodeID))["planGeneration"] != nil {
		got := ""
		if characterRow != nil {
			got = characterRow.NodeID
		}
		t.Fatalf("completed artifact did not replace its placeholder: node=%s placeholder=%s", got, placeholders["character"])
	}
}

func TestProductionPlanAssetAppendMustBeExplicitForModelSelection(t *testing.T) {
	if productionAssetModelSelectionEmpty(ProductionAssetModelSelection{ContinueAppend: true}) {
		t.Fatal("append-only selection was ignored")
	}
	if !productionAssetModelSelectionEmpty(ProductionAssetModelSelection{}) {
		t.Fatal("empty model selection should remain empty")
	}
	fresh := ProductionAssetModelSelection{}
	if productionPlanAssetAppendAuthorized(&fresh) {
		t.Fatal("plan-level generation must not implicitly append")
	}
	append := ProductionAssetModelSelection{ContinueAppend: true}
	if !productionPlanAssetAppendAuthorized(&append) || productionPlanAssetAppendAuthorized(nil) {
		t.Fatal("only the explicit append control may authorize adding work")
	}
	manifest := productionManifest{Plan: &productionPlan{AssetsStarted: true, SelectedAssetKeys: []string{"character"}}}
	if !productionPlanAssetSelectionIsIdempotent(manifest, []string{"character"}) || productionPlanAssetSelectionIsIdempotent(manifest, []string{"environment"}) {
		t.Fatal("active duplicate submission and new work were not distinguished")
	}
}

func TestProductionProgressShowsAppendedAssetsWaitingForDispatch(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"prop"}); err != nil {
		t.Fatal(err)
	}
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
		state.ProductionParallel = map[string]productionParallelWork{
			"character": {Key: "character", Name: "测试character"},
		}
	})
	_, state := productionRuntimeState(t, s, runID)
	progress := s.productionAgentProgress("user", runID, &state)
	got := map[string]string{}
	for _, item := range progress.ParallelItems {
		got[item.Key] = item.Status
	}
	if got["character"] != "queued" || got["prop"] != "queued" {
		t.Fatalf("active and not-yet-dispatched assets were not distinguished: %#v", got)
	}
}

func TestProductionPlanActiveCategoryAppendPreservesLiveWork(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal(err)
	}
	_, initial := productionRuntimeState(t, s, runID)
	_, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["character"].TaskID != "" })
	original := state.ProductionParallel["character"]
	_, _, before := orderedPlanState(t, s, runID)
	for _, key := range []string{"environment", "prop", "sound", "special", "character", "environment"} {
		if err := s.GenerateProductionPlanAssets("user", runID, []string{key}, ProductionAssetModelSelection{ContinueAppend: true}); err != nil {
			t.Fatalf("append %s: %v", key, err)
		}
	}
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool {
		return state.ProductionParallel["environment"].TaskID != "" && state.ProductionParallel["prop"].TaskID != ""
	})
	if !reflect.DeepEqual(state.ProductionParallel["character"], original) || state.ProductionParallel["sound"].TaskID != "" {
		t.Fatal("append replaced the live checkpoint or bypassed its dependency")
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	if len(m.Plan.SelectedAssetKeys) != 5 || len(m.Plan.Groups) != 5 || len(rows) != len(before) {
		t.Fatal("scope/groups were not appended without regenerating documents")
	}
	for _, row := range before {
		if !productionPlanArtifactValid(m, doc, rows, row.Key) {
			t.Fatal("new sibling groups invalidated a receipt", row.Key)
		}
	}
	// Commit the original response after appending other categories. Its
	// dependency hash must still match the receipts used before the append.
	completeParallel(t, db, original)
	for _, key := range []string{"environment", "prop"} {
		completeParallel(t, db, state.ProductionParallel[key])
	}
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool {
		return state.ProductionParallel["sound"].TaskID != "" && state.ProductionParallel["special"].TaskID != ""
	})
	for _, key := range []string{"sound", "special"} {
		completeParallel(t, db, state.ProductionParallel[key])
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("appended categories did not finish")
	}
	m, doc, rows = orderedPlanState(t, s, runID)
	for _, key := range []string{"character", "environment", "prop", "sound", "special"} {
		if !productionPlanArtifactValid(m, doc, rows, key) {
			t.Fatal("asset not committed", key)
		}
	}
	_, state = productionRuntimeState(t, s, runID)
	if len(state.TaskIDs)-len(initial.TaskIDs) != 5 {
		t.Fatalf("duplicate requests dispatched additional calls: %d", len(state.TaskIDs)-len(initial.TaskIDs))
	}
}

func TestProductionPlanActiveAppendPreservesSavedAssetReceiptsAndRetriesOnlyTarget(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character", "prop"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	run, state := productionRuntimeState(t, s, runID)
	m, doc, before := orderedPlanState(t, s, runID)
	for _, work := range productionParallelReady(m, doc, before) {
		if work.Key == "prop" {
			if err := s.enqueueProductionParallel(run, &state, m, doc, before, work); err != nil {
				t.Fatal(err)
			}
		}
	}
	_, state = productionRuntimeState(t, s, runID)
	original := state.ProductionParallel["prop"]
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
		state.ProductionParallel["environment"] = productionParallelWork{Key: "environment", Error: "失败待重试", Attempts: 6}
		state.ProductionParallel["special"] = productionParallelWork{Key: "special", Error: "保留原失败", Attempts: 6}
	})
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"environment"}, ProductionAssetModelSelection{ContinueAppend: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	if !reflect.DeepEqual(state.ProductionParallel["prop"], original) || state.ProductionParallel["special"].Error != "保留原失败" {
		t.Fatal("append changed unrelated work")
	}
	if _, exists := state.ProductionParallel["environment"]; exists {
		t.Fatal("requested failed checkpoint was not reset")
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	for i, row := range before {
		if rows[i].ContentHash != row.ContentHash || !productionPlanArtifactValid(m, doc, rows, row.Key) {
			t.Fatal("adding a sibling group changed an existing receipt", row.Key)
		}
	}
}

func TestProductionPlanSelectedRetryLeavesUnselectedFailuresIdle(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	startPlanAssetsForTest(t, s, runID)
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	run, _ := productionRuntimeState(t, s, runID)
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		state, _ := cloudAgentDecode(current)
		state.ProductionParallel = map[string]productionParallelWork{
			"character":   {Key: "character", Name: "测试character", Error: "服务不可用", Attempts: 6},
			"environment": {Key: "environment", Name: "测试environment", RetryAt: time.Now().Add(time.Hour).UnixMilli()},
			"prop":        {Key: "prop", Name: "测试prop", Error: "输入有误"},
		}
		current.Status = "failed"
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character", "sound"}); err != nil {
		t.Fatal(err)
	}
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	_, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["character"].TaskID != "" })
	if state.ProductionParallel["character"].Attempts != 1 || state.ProductionParallel["sound"].TaskID != "" {
		t.Fatal("retry counter or dependency order incorrect")
	}
	completeParallel(t, db, state.ProductionParallel["character"])
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["sound"].TaskID != "" })
	completeParallel(t, db, state.ProductionParallel["sound"])
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("unselected retry checkpoint blocked completion")
	}
	_, state = productionRuntimeState(t, s, runID)
	if state.ProductionParallel["prop"].Error != "输入有误" || state.ProductionParallel["environment"].TaskID != "" {
		t.Fatal("unselected work was changed or dispatched")
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
}

func TestProductionPlanSelectionRejectsInFlightTask(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	startPlanAssetsForTest(t, s, runID)
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	run, state := productionRuntimeState(t, s, runID)
	m, doc, rows := orderedPlanState(t, s, runID)
	if err := s.enqueueProductionParallel(run, &state, m, doc, rows, productionParallelReady(m, doc, rows)[0]); err != nil {
		t.Fatal(err)
	}
	if err := s.ControlProductionAgent("user", runID, "pause"); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"prop"}); err == nil || !strings.Contains(err.Error(), "执行或保存") {
		t.Fatal("in-flight response could be dropped", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.runProductionParallel(ctx, "user", runID); err != context.Canceled {
		t.Fatal(err)
	}
}

func TestProductionPlanAssetRetrySettlesSucceededUncommittedTask(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	run, state := productionRuntimeState(t, s, runID)
	manifest, doc, rows := orderedPlanState(t, s, runID)
	var selected productionParallelWork
	for _, work := range productionParallelReady(manifest, doc, rows) {
		if work.Key == "character" {
			selected = work
		}
	}
	if selected.Key == "" {
		t.Fatal("selected character asset was not ready")
	}
	if err := s.enqueueProductionParallel(run, &state, manifest, doc, rows, selected); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	work := state.ProductionParallel["character"]
	completeParallel(t, db, work)
	s.disablePiRuntime = true
	run, _ = productionRuntimeState(t, s, runID)
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = "failed"
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatalf("explicit retry should first recover the succeeded model response: %v", err)
	}
	manifest, doc, rows = orderedPlanState(t, s, runID)
	var recovered *model.ProductionAgentArtifact
	for i := range rows {
		if rows[i].Key == "character" {
			recovered = &rows[i]
		}
	}
	if recovered == nil || !productionArtifactMatches(productionNode(doc, recovered.NodeID), recovered.ContentHash) || !slices.Contains(manifest.Plan.NewVersionAssetKeys, "character") {
		t.Fatal("recovered response was not preserved before the explicitly requested new version")
	}
	_, state = productionRuntimeState(t, s, runID)
	if state.ProductionParallel["character"].TaskID != "" {
		t.Fatal("explicit retry retained the stale succeeded task receipt")
	}
}

func TestProductionPlanAssetsCanResumeAfterCancelledActiveTask(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal(err)
	}
	s.disablePiRuntime = true

	const cancelledTaskID = "cancelled-production-model-task"
	if err := db.Create(&model.Task{ID: cancelledTaskID, UserID: "user", ProjectID: "agent-canvas", Type: "canvas_text", Status: model.TaskStatusCancelled}).Error; err != nil {
		t.Fatal(err)
	}
	run, state := productionRuntimeState(t, s, runID)
	state.ProductionPaused = true
	state.ActiveTaskID = cancelledTaskID
	state.TaskIDs = append(state.TaskIDs, cancelledTaskID)
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = "running"
		current.ActiveTaskID = cancelledTaskID
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}

	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatalf("cancelled task should permit selected asset generation to resume: %v", err)
	}
	updated, resumed := productionRuntimeState(t, s, runID)
	if updated.Status != "running" || updated.ActiveTaskID != "" || resumed.ActiveTaskID != "" || resumed.ProductionPaused {
		t.Fatalf("cancelled task checkpoint was not cleared and resumed: status=%s active=%s paused=%v", updated.Status, resumed.ActiveTaskID, resumed.ProductionPaused)
	}
	if len(resumed.ProductionModelReceipts) != 0 {
		t.Fatalf("cancelled task receipts were retained: %#v", resumed.ProductionModelReceipts)
	}
}

func TestProductionPlanAssetSelectionRecoversStaleRunningCheckpointAsNewBatch(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	manifest, _, _ := orderedPlanState(t, s, runID)
	characterName := productionPlanItem(manifest, "character").Name
	submitOrderedPlan(t, s, runID, "character", "character", characterName)
	_, _, before := orderedPlanState(t, s, runID)

	// Simulate a browser refresh after a backend runner disappeared while its
	// persisted execution status remained running.
	run, state := productionRuntimeState(t, s, runID)
	state.ProductionPaused = false
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = "running"
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatalf("stale running checkpoint should start a fresh asset version: %v", err)
	}
	updated, next := productionRuntimeState(t, s, runID)
	manifest, doc, rows := orderedPlanState(t, s, runID)
	if updated.Status != "running" || !reflect.DeepEqual(manifest.Plan.SelectedAssetKeys, []string{"character"}) {
		t.Fatalf("new batch did not replace the selected execution scope: status=%s keys=%v", updated.Status, manifest.Plan.SelectedAssetKeys)
	}
	ready := productionParallelReady(manifest, doc, rows)
	if len(ready) != 1 || ready[0].Key != "character" {
		t.Fatalf("new batch did not prepare the selected asset: ready=%#v selected=%v versions=%v valid=%v action=%#v", ready, manifest.Plan.SelectedAssetKeys, manifest.Plan.NewVersionAssetKeys, productionPlanArtifactValid(manifest, doc, rows, "character"), productionPlanNextAction(manifest, doc, rows))
	}
	for _, original := range before {
		if productionNode(doc, original.NodeID) == nil || !productionArtifactMatches(productionNode(doc, original.NodeID), original.ContentHash) {
			t.Fatalf("starting a new asset batch changed the previous %s version", original.Key)
		}
	}
	if next.ActiveTaskID != "" {
		t.Fatalf("stale checkpoint retained an active model task: %s", next.ActiveTaskID)
	}
	oldNodeID := before[0].NodeID
	oldNode := productionNode(doc, oldNodeID)
	oldContent := oldNode["metadata"].(map[string]any)["content"]
	characterName = productionPlanItem(manifest, "character").Name
	submitOrderedPlan(t, s, runID, "character", "character", characterName)
	manifest, doc, rows = orderedPlanState(t, s, runID)
	var latest model.ProductionAgentArtifact
	for _, row := range rows {
		if row.Key == "character" {
			latest = row
		}
	}
	if latest.NodeID == oldNodeID || productionNode(doc, oldNodeID) == nil || productionNode(doc, oldNodeID)["metadata"].(map[string]any)["content"] != oldContent {
		t.Fatal("new asset generation overwrote or removed the previous version")
	}
	newNode := productionNode(doc, latest.NodeID)
	if newNode["title"] != characterName+" · 第 2 版" || !productionPlanArtifactValid(manifest, doc, rows, "character") {
		t.Fatalf("new version was not recorded as the current valid asset: title=%v receipt=%+v", newNode["title"], latest)
	}
}
