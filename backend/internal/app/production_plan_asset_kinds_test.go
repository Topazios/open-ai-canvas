package app

import (
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestProductionPlanAssetKeysForKindsUsesOnlyUnfinishedMembers(t *testing.T) {
	progress := []ProductionPlanAssetProgress{
		{Key: "C001", Kind: "character", Status: "pending"},
		{Key: "C002", Kind: "character", Status: "failed"},
		{Key: "C003", Kind: "character", Status: "complete"},
		{Key: "C004", Kind: "character", Status: "saving"},
		{Key: "E001", Kind: "environment", Status: "pending"},
	}
	got := productionPlanAssetKeysForKinds(progress, map[string]bool{"character": true})
	if want := []string{"C001", "C002"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("category selection = %v, want %v", got, want)
	}
}

func TestProductionPlanAssetKindExtractionFlowsIntoSelectedGeneration(t *testing.T) {
	s, _, run := planFixture(t, 5)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	storyDocument := orderedPlanDocument("story", "")
	storyDocument["episodeArchitecture"] = productionEpisodeArchitectureFixture(3)
	story := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": storyDocument, "factIds": []string{}}, false)
	initialAssets := []productionPlanAsset{{Key: "scene", Kind: "environment", Name: "旧照相馆", Purpose: "主要冲突空间", PlannedRange: "全剧", Priority: 1}}
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{
		StoryHash: stringValue(story["hash"]), Complete: true,
		Assets: initialAssets, InventoryReview: productionInventoryReviewForTest(t, s, run.ID, initialAssets),
		Absent: map[string]string{"character": "待从总纲提取", "prop": "无独立道具", "sound": "无独立声音"},
	}, false)
	execution, state := productionRuntimeState(t, s, run.ID)
	if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = "completed"
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	s.disablePiRuntime = true
	selection := ProductionAssetModelSelection{Instruction: "保留人物独特的动作习惯", ReasoningEffort: ReasoningEffort("high")}
	if err := s.GenerateProductionPlanAssetKinds("user", run.ID, []string{"character"}, selection); err != nil {
		t.Fatal(err)
	}
	manifest, containerDoc, _ := orderedPlanState(t, s, run.ID)
	group := productionNode(containerDoc, manifest.Plan.Groups["character"])
	if group == nil || group["type"] != "frame" {
		t.Fatal("category container must be committed before inventory extraction")
	}
	for _, node := range creationMaps(containerDoc["nodes"]) {
		if node["parentId"] == group["id"] {
			t.Fatal("unknown asset count must not create invented placeholder nodes")
		}
	}
	if !reflect.DeepEqual(manifest.Plan.SelectedAssetKinds, []string{"character"}) || !manifest.Plan.PlansStarted || !reflect.DeepEqual(manifest.Plan.SelectedPlanKeys, []string{"inventory"}) {
		t.Fatalf("category generation did not schedule in-task extraction: %+v", manifest.Plan)
	}
	manifest, doc, rows := orderedPlanState(t, s, run.ID)
	ready := productionParallelReady(manifest, doc, rows)
	if len(ready) != 1 || ready[0].Key != "inventory" {
		t.Fatalf("in-task extraction was not dispatched: %+v", ready)
	}
	_, extractionState := productionRuntimeState(t, s, run.ID)
	if extractionState.ProductionParallel["inventory"].Dependencies != ready[0].Dependencies {
		t.Fatal("persisted inventory settings cannot replace a dispatch checkpoint with missing dependencies")
	}
	selectedAssets := []productionPlanAsset{
		{Key: "scene", Kind: "environment", Name: "旧照相馆", Purpose: "主要冲突空间", PlannedRange: "全剧", Priority: 1},
		{Key: "hero", Kind: "character", Name: "主角", Purpose: "推动主线", PlannedRange: "全剧", Priority: 1},
	}
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{
		StoryHash: stringValue(story["hash"]), Complete: true,
		Assets: selectedAssets, InventoryReview: productionInventoryReviewForTest(t, s, run.ID, selectedAssets),
		Absent: map[string]string{"prop": "无独立道具", "sound": "无独立声音"},
	}, false)
	manifest, _, rows = orderedPlanState(t, s, run.ID)
	if !manifest.Plan.AssetsStarted || !reflect.DeepEqual(manifest.Plan.SelectedAssetKeys, []string{"hero"}) || len(manifest.Plan.SelectedAssetKinds) != 0 {
		t.Fatalf("inventory extraction did not continue into the requested asset category: plan=%+v rows=%d", manifest.Plan, len(rows))
	}
	_, state = productionRuntimeState(t, s, run.ID)
	if state.ProductionAssetExtractionSelection != nil || state.ProductionParallel["hero"].GenerationInstruction != selection.Instruction || state.ProductionParallel["hero"].GenerationReasoningEffort != selection.ReasoningEffort {
		t.Fatal("inventory completion lost the selected content generation settings")
	}
	if _, err := s.ensureProductionPlanGroups("user", run.ID); err != nil {
		t.Fatal(err)
	}
	manifest, containerDoc, rows = orderedPlanState(t, s, run.ID)
	placeholder := productionNode(containerDoc, manifest.Plan.AssetPlaceholderNodeIDs["hero"])
	if placeholder == nil || placeholder["parentId"] != group["id"] {
		t.Fatal("inventory completion did not materialize the asset inside its original container")
	}
}

func TestProductionPlanAssetKindAdmissionCreatesContainersBeforeDispatch(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	s.disablePiRuntime = true
	run, state := productionRuntimeState(t, s, runID)
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = "completed"
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	var before int64
	db.Model(&model.Task{}).Count(&before)
	if err := s.GenerateProductionPlanAssetKinds("user", runID, []string{"character", "prop"}, ProductionAssetModelSelection{Instruction: "保留原文设定"}); err != nil {
		t.Fatal(err)
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	groupIDs := map[string]string{}
	for _, kind := range []string{"character", "prop"} {
		groupIDs[kind] = m.Plan.Groups[kind]
		if productionNode(doc, groupIDs[kind]) == nil {
			t.Fatalf("accepted request is missing the %s container", kind)
		}
	}
	if len(m.Plan.AssetPlaceholderNodeIDs) != 2 {
		t.Fatal("known selected assets must have durable placeholders before admission returns")
	}
	var after int64
	db.Model(&model.Task{}).Count(&after)
	if after != before {
		t.Fatal("admission called the model or created child tasks before materialization")
	}
	// The execution intent survives losing all process-local scheduler state.
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	m, doc, rows = orderedPlanState(t, s, runID)
	ready := productionParallelReady(m, doc, rows)
	if len(ready) != 2 {
		t.Fatalf("wrong materialized dispatch scope: %+v", ready)
	}
	for _, work := range ready {
		item := productionPlanItem(m, work.Key)
		if productionNode(doc, m.Plan.AssetPlaceholderNodeIDs[work.Key]) == nil || m.Plan.Groups[item.Kind] != groupIDs[item.Kind] {
			t.Fatal("dispatch can start without a durable content node in the admitted container")
		}
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	again, _, _ := orderedPlanState(t, s, runID)
	if !reflect.DeepEqual(m.Plan.AssetPlaceholderNodeIDs, again.Plan.AssetPlaceholderNodeIDs) || !reflect.DeepEqual(m.Plan.Groups, again.Plan.Groups) {
		t.Fatal("materialization duplicated containers or content nodes")
	}
}

func TestProductionPlanAssetKindAdmissionRejectsBeforeCreatingContainer(t *testing.T) {
	s, _, run := planFixture(t, 5)
	s.disablePiRuntime = true
	for _, selection := range []ProductionAssetModelSelection{{}, {ReasoningEffort: ReasoningEffort("invalid")}} {
		if err := s.GenerateProductionPlanAssetKinds("user", run.ID, []string{"character"}, selection); err == nil {
			t.Fatal("invalid request or missing story was accepted")
		}
	}
	m, _, _ := orderedPlanState(t, s, run.ID)
	if len(m.Plan.Groups) != 0 || m.Plan.AssetsStarted || len(m.Plan.SelectedAssetKinds) > 0 {
		t.Fatal("rejected request left behind containers or executable generation intent")
	}
}

func TestProductionPlanAssetKindAdmissionAppendsWithoutReplacingLiveTask(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanAssetKinds("user", runID, []string{"character"}, ProductionAssetModelSelection{}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	run, state := productionRuntimeState(t, s, runID)
	ready := productionParallelReady(m, doc, rows)
	if len(ready) != 1 || ready[0].Key != "character" {
		t.Fatal("unexpected initial category scope", ready)
	}
	if err := s.enqueueProductionParallel(run, &state, m, doc, rows, ready[0]); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	original := state.ProductionParallel["character"]
	for i := 0; i < 2; i++ {
		if err := s.GenerateProductionPlanAssetKinds("user", runID, []string{"prop"}, ProductionAssetModelSelection{Instruction: "明确道具使用方式"}); err != nil {
			t.Fatal(err)
		}
		_, state = productionRuntimeState(t, s, runID)
		if !reflect.DeepEqual(state.ProductionParallel["character"], original) {
			t.Fatal("appending a category replaced or reset the running character task")
		}
	}
	m, doc, _ = orderedPlanState(t, s, runID)
	if productionNode(doc, m.Plan.Groups["prop"]) == nil || len(m.Plan.SelectedAssetKeys) != 2 || state.ProductionParallel["prop"].GenerationInstruction != "明确道具使用方式" {
		t.Fatal("appended category was not durably admitted without duplicating its members")
	}
}

func TestProductionPlanAssetKindAdmissionRecreatesOnlyExplicitlyDeletedCategory(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanAssetKinds("user", runID, []string{"character", "prop"}, ProductionAssetModelSelection{}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	m, _, _ := orderedPlanState(t, s, runID)
	oldGroup, keptGroup := m.Plan.Groups["character"], m.Plan.Groups["prop"]
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		var kept []map[string]any
		for _, node := range creationMaps(doc["nodes"]) {
			if node["id"] != oldGroup && node["parentId"] != oldGroup {
				kept = append(kept, node)
			}
		}
		doc["nodes"] = kept
	})
	if err := s.GenerateProductionPlanAssetKinds("user", runID, []string{"character"}, ProductionAssetModelSelection{}); err != nil {
		t.Fatal(err)
	}
	m, doc, _ := orderedPlanState(t, s, runID)
	if m.Plan.Groups["character"] == oldGroup || productionNode(doc, m.Plan.Groups["character"]) == nil || m.Plan.Groups["prop"] != keptGroup {
		t.Fatal("explicit recreation revived old IDs or replaced an unrelated container")
	}
}

func TestLegacyPlanAssetGenerationUsesOnlySavedStoryAndSelectedAsset(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	s.disablePiRuntime = true
	run, state := productionRuntimeState(t, s, runID)
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = "completed"
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}

	if err := s.GenerateProductionPlanAssets("user", runID, []string{"sound"}); err != nil {
		t.Fatalf("legacy plan asset generation should not require other standards or dependency assets: %v", err)
	}
	manifest, doc, rows := orderedPlanState(t, s, runID)
	ready := productionParallelReady(manifest, doc, rows)
	if len(ready) != 1 || ready[0].Key != "sound" {
		t.Fatalf("scheduler included prerequisites outside the saved plan selection: %+v", ready)
	}
	if got := productionPlanDependencies(manifest, rows, "sound"); len(got) != 1 || got["story"] == "" {
		t.Fatalf("asset generation should depend only on the saved story: %#v", got)
	}
	if ready[0].Dependencies != productionParallelDependencyHash(manifest, rows, "sound") {
		t.Fatalf("asset scheduler retained pre-start dependencies: %s", ready[0].Dependencies)
	}
}
