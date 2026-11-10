package app

import (
	"context"
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestAssetDispatchRequiresDurableContainerAndNode(t *testing.T) {
	s, db, runID := readyPlanForAssetRecovery(t)
	m, _, _ := orderedPlanState(t, s, runID)
	oldGroup := m.Plan.Groups["character"]
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		nodes := []map[string]any{}
		for _, node := range creationMaps(doc["nodes"]) {
			if node["id"] != oldGroup {
				nodes = append(nodes, node)
			}
		}
		doc["nodes"] = nodes
	})
	m, doc, rows := orderedPlanState(t, s, runID)
	for _, work := range productionParallelReady(m, doc, rows) {
		if work.Key == "character" {
			t.Fatal("missing container admitted a model task")
		}
	}
	run, state := productionRuntimeState(t, s, runID)
	work := productionParallelWork{Key: "character", Name: "人物", Dependencies: productionParallelDependencyHash(m, rows, "character")}
	before := len(state.TaskIDs)
	if err := s.enqueueProductionParallel(run, &state, m, doc, rows, work); err == nil {
		t.Fatal("direct enqueue bypassed target validation")
	}
	_, state = productionRuntimeState(t, s, runID)
	if len(state.TaskIDs) != before {
		t.Fatal("invalid target created a billable task")
	}
	if changed, err := s.ensureProductionPlanGroups("user", runID); err != nil || !changed {
		t.Fatal(changed, err)
	}
	m, doc, _ = orderedPlanState(t, s, runID)
	if m.Plan.Groups["character"] != oldGroup || !productionAssetTargetPresent(m, doc, "character") {
		t.Fatal("non-deleted missing projection was not recovered")
	}
}

func TestDeletingLastAssetContainerCancelsPlaceholderWorkWithoutResurrection(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal(err)
	}
	m, _, _ := orderedPlanState(t, s, runID)
	group, id := m.Plan.Groups["character"], m.Plan.AssetPlaceholderNodeIDs["character"]
	task := model.Task{ID: "owned-placeholder-task", UserID: "user", ProjectID: "agent-canvas", Status: model.TaskStatusQueued, Operation: cloudAgentStepOperation}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	run, _ := productionRuntimeState(t, s, runID)
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		state.ProductionParallel = map[string]productionParallelWork{"character": {Key: "character", TaskID: task.ID}}
		state.TaskIDs = append(state.TaskIDs, task.ID)
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ReconcileCanvasNodeTasks(context.Background(), "user", "agent-canvas", group); err != nil {
		t.Fatal(err)
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	if productionNode(doc, group) != nil || productionNode(doc, id) != nil || m.Plan.SelectedAssetKeys == nil || len(m.Plan.SelectedAssetKeys) != 0 || len(productionParallelReady(m, doc, rows)) != 0 {
		t.Fatal("deleted last selection expanded into all assets", m.Plan.SelectedAssetKeys)
	}
	_, state := productionRuntimeState(t, s, runID)
	if state.ProductionParallel["character"].TaskID != "" {
		t.Fatal("deleted placeholder retained active scheduler work")
	}
	if changed, err := s.ensureProductionPlanGroups("user", runID); err != nil || changed {
		t.Fatal("deleted container was recreated", changed, err)
	}
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	stale, _ := creationDocument(canvas.PayloadJSON)
	stale["nodes"] = append(creationMaps(stale["nodes"]), map[string]any{"id": id, "type": "text", "parentId": group}, map[string]any{"id": "late-child", "type": "text", "parentId": id})
	policy, _ := s.RuntimePolicy()
	if err := saveCloudAgentDocument(s.repo, canvas, stale, policy); err != nil {
		t.Fatal(err)
	}
	if productionNode(stale, id) != nil || productionNode(stale, "late-child") != nil {
		t.Fatal("late callback restored deleted descendants")
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal(err)
	}
	m, doc, _ = orderedPlanState(t, s, runID)
	if m.Plan.Groups["character"] == group || m.Plan.AssetPlaceholderNodeIDs["character"] == id || !productionAssetTargetPresent(m, doc, "character") {
		t.Fatal("explicit regeneration did not get fresh visible targets")
	}
}

func TestEmptyAssetSelectionSurvivesCheckpoint(t *testing.T) {
	m := productionManifest{Plan: &productionPlan{AssetsStarted: true, SelectedAssetKeys: []string{}, Assets: []productionPlanAsset{{Key: "hero"}}}}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var restored productionManifest
	if err := json.Unmarshal(raw, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.Plan.SelectedAssetKeys == nil || productionPlanAssetSelected(restored, "hero") {
		t.Fatal("empty selection became an implicit select-all", string(raw))
	}
}
