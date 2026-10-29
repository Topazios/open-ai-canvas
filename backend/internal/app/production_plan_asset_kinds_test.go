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
	if err := s.GenerateProductionPlanAssetKinds("user", run.ID, []string{"character"}, ProductionAssetModelSelection{}); err != nil {
		t.Fatal(err)
	}
	manifest, _, _ := orderedPlanState(t, s, run.ID)
	if !reflect.DeepEqual(manifest.Plan.SelectedAssetKinds, []string{"character"}) || !manifest.Plan.PlansStarted || !reflect.DeepEqual(manifest.Plan.SelectedPlanKeys, []string{"inventory"}) {
		t.Fatalf("category generation did not schedule in-task extraction: %+v", manifest.Plan)
	}
	manifest, doc, rows := orderedPlanState(t, s, run.ID)
	ready := productionParallelReady(manifest, doc, rows)
	if len(ready) != 1 || ready[0].Key != "inventory" {
		t.Fatalf("in-task extraction was not dispatched: %+v", ready)
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
