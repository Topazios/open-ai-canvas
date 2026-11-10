package app

import (
	"errors"
	"net/http"
	"testing"

	"infinite-canvas/backend/internal/model"
)

// readyForAssetTasks finishes the plan documents and leaves the run waiting
// for the user to create asset tasks.
func readyForAssetTasks(t *testing.T) (*Service, string) {
	t.Helper()
	s, _, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	return s, runID
}

func TestProductionPlanAssetsStartWithoutTaskRecord(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	if err := db.Unscoped().Where("id = ?", runID).Delete(&model.Task{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, allPlanAssetKeys(t, s, runID)); err != nil {
		t.Fatalf("missing historical task record blocked asset task creation: %v", err)
	}
	if m, _, _ := orderedPlanState(t, s, runID); !m.Plan.AssetsStarted {
		t.Fatal("asset task did not start")
	}
}

func TestProductionPlanAssetsMissingCanvasIsReadableConflict(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("id = ?", "agent-canvas").Delete(&model.CanvasProject{}).Error; err != nil {
		t.Fatal(err)
	}
	err := s.GenerateProductionPlanAssets("user", runID, []string{"character"})
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Status != http.StatusConflict || appErr.Message == "" {
		t.Fatalf("missing canvas must be a readable 409, got %T %v", err, err)
	}
}

func TestProductionPlanFinishedKindRequiresExplicitRegeneration(t *testing.T) {
	s, runID := readyForAssetTasks(t)
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssetKinds("user", runID, []string{"character"}, ProductionAssetModelSelection{}); err != nil {
		t.Fatal(err)
	}
	m, _, _ := orderedPlanState(t, s, runID)
	run, _ := productionRuntimeState(t, s, runID)
	if len(m.Plan.NewVersionAssetKeys) != 0 || run.Status != "completed" {
		t.Fatal("default repeat reopened a completed asset", run.Status)
	}
	if err := s.GenerateProductionPlanAssetKinds("user", runID, []string{"character"}, ProductionAssetModelSelection{Regenerate: true, RequestID: "regenerate-1"}); err != nil {
		t.Fatal(err)
	}
	m, _, _ = orderedPlanState(t, s, runID)
	if len(m.Plan.NewVersionAssetKeys) != 1 || m.Plan.NewVersionAssetKeys[0] != "character" {
		t.Fatal("explicit regeneration did not mark only the chosen identity")
	}
	before := productionHash(m)
	if err := s.GenerateProductionPlanAssetKinds("user", runID, []string{"character"}, ProductionAssetModelSelection{Regenerate: true, RequestID: "regenerate-1"}); err != nil {
		t.Fatal(err)
	}
	m, _, _ = orderedPlanState(t, s, runID)
	if before != productionHash(m) {
		t.Fatal("duplicate request changed the manifest")
	}
}

func TestProductionPlanInFlightKindAcknowledgesDuplicate(t *testing.T) {
	s, runID := readyForAssetTasks(t)
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal(err)
	}
	err := s.GenerateProductionPlanAssetKinds("user", runID, []string{"character"}, ProductionAssetModelSelection{})
	if err != nil {
		t.Fatal(err)
	}
}

func TestProductionPlanPropWithUnsettledSucceededTaskStartsNewTask(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: "prop-unsettled-task", UserID: "user", Type: "canvas_text", Status: model.TaskStatusSucceeded}).Error; err != nil {
		t.Fatal(err)
	}
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
		state.TaskIDs = append(state.TaskIDs, "prop-unsettled-task")
		state.ProductionParallel = map[string]productionParallelWork{"prop": {Key: "prop", Name: "道具", TaskID: "prop-unsettled-task"}}
	})
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"prop"}); err != nil {
		t.Fatalf("unsettled succeeded prop task blocked a new asset task: %v", err)
	}
	if _, state := productionRuntimeState(t, s, runID); state.ProductionParallel["prop"].TaskID == "prop-unsettled-task" {
		t.Fatal("stale prop checkpoint was kept")
	}
}
