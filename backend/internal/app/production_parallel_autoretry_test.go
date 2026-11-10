package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// startPlansForTest does what generate_plans does for a v5 run: it records the
// remaining plan documents as started and creates their placeholders.
func startPlansForTest(t *testing.T, s *Service, runID string) {
	t.Helper()
	manifest, _, _ := orderedPlanState(t, s, runID)
	manifest.Plan.PlansStarted = true
	manifest.Plan.SelectedPlanKeys = []string{"inventory", "visual", "direction", "generation"}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.repo.UpdateProductionAgentManifest("user", runID, string(encoded)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ensureProductionPlanDocumentPlaceholders("user", runID); err != nil {
		t.Fatal(err)
	}
}

// v5SubmittedStoryFixture reads the topic, saves a valid story and starts the
// remaining plan documents, so they are the only things left to schedule.
func v5SubmittedStoryFixture(t *testing.T) (*Service, string) {
	t.Helper()
	s, _, runID := v5SubmittedStoryFixtureWithDB(t)
	return s, runID
}

func v5SubmittedStoryFixtureWithDB(t *testing.T) (*Service, *gorm.DB, string) {
	t.Helper()
	s, db, run := planFixture(t, 5)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	doc := orderedPlanDocument("story", "")
	doc["episodeArchitecture"] = productionEpisodeArchitectureFixture(3)
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": doc, "factIds": []string{}}, false)
	startPlansForTest(t, s, run.ID)
	return s, db, run.ID
}

func mutateParallelState(t *testing.T, s *Service, runID string, change func(*model.CloudAgentExecution, *cloudAgentRuntime)) {
	t.Helper()
	run, err := s.repo.CloudAgent("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		if state.ProductionParallel == nil {
			state.ProductionParallel = map[string]productionParallelWork{}
		}
		change(current, &state)
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
}

func holdParallelItem(t *testing.T, s *Service, runID, key string, rounds int) {
	t.Helper()
	mutateParallelState(t, s, runID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.ProductionParallel[key] = productionParallelWork{Key: key, Name: key, QuietHold: true, Correction: "字段待补齐", AutoRetryRounds: rounds}
	})
}

func escalateItem(t *testing.T, s *Service, runID, key string) productionParallelWork {
	t.Helper()
	run, _ := productionRuntimeState(t, s, runID)
	if err := s.escalateProductionParallelHold(run, key); err != nil {
		t.Fatal(err)
	}
	_, state := productionRuntimeState(t, s, runID)
	return state.ProductionParallel[key]
}

func TestProductionParallelQuietHoldRetriesAutomaticallyThenSetsItemAside(t *testing.T) {
	s, runID := v5SubmittedStoryFixture(t)
	holdParallelItem(t, s, runID, "visual", 0)
	work := escalateItem(t, s, runID, "visual")
	if work.AutoRetryRounds != 1 || work.QuietHold || work.Abandoned || work.RetryAt == 0 || work.Correction != "字段待补齐" {
		t.Fatalf("first hold did not become an automatic retry round: %+v", work)
	}

	holdParallelItem(t, s, runID, "visual", productionParallelAutoRetryRounds)
	mutateParallelState(t, s, runID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		work := state.ProductionParallel["visual"]
		work.Error = "仍未通过校验"
		state.ProductionParallel["visual"] = work
	})
	work = escalateItem(t, s, runID, "visual")
	if !work.Abandoned || work.QuietHold || work.RetryAt != 0 || work.TaskID != "" || work.Error != "仍未通过校验" {
		t.Fatalf("exhausted item was not set aside with its reason: %+v", work)
	}
	if work.Notice == nil || work.Notice.Severity != "warning" || strings.Contains(work.Notice.SafeMessage, "手动") {
		t.Fatalf("abandoned item has the wrong notice: %+v", work.Notice)
	}
}

func TestProductionPlanSiblingsOnlyWaitForStory(t *testing.T) {
	s, runID := v5SubmittedStoryFixture(t)
	run, state := productionRuntimeState(t, s, runID)
	_, manifest, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		t.Fatal(err)
	}
	artifacts, err := s.repo.ProductionAgentArtifacts("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	if first := productionParallelReady(manifest, doc, artifacts); len(first) != 1 || first[0].Key != "inventory" {
		t.Fatalf("a healthy first batch starts with inventory alone: %+v", first)
	}
	// Shared standards only depend on the story; a slow sibling cannot block them.
	held := map[string]productionParallelWork{"inventory": {Key: "inventory", QuietHold: true}}
	for _, work := range productionParallelReadyWithState(manifest, doc, artifacts, held) {
		keys[work.Key] = true
	}
	for _, key := range []string{"visual", "direction", "generation"} {
		if !keys[key] {
			t.Fatalf("%s must be schedulable once inventory has settled: %v", key, keys)
		}
	}
	// When all three have failed or been held, generation is released too.
	held["visual"] = productionParallelWork{Key: "visual", QuietHold: true}
	held["direction"] = productionParallelWork{Key: "direction", QuietHold: true}
	keys = map[string]bool{}
	for _, work := range productionParallelReadyWithState(manifest, doc, artifacts, held) {
		keys[work.Key] = true
	}
	if !keys["generation"] {
		t.Fatalf("generation must be schedulable once its siblings are settled: %v", keys)
	}
	// Nothing but the story is required, so a missing inventory blocks no sibling.
	for _, key := range []string{"visual", "direction", "generation"} {
		if err := productionPlanPrerequisites(manifest, doc, artifacts, key); err != nil {
			t.Fatalf("%s was blocked without a valid inventory: %v", key, err)
		}
	}
}

func TestProductionParallelStoryIsNeverSetAside(t *testing.T) {
	s, runID := v5SubmittedStoryFixture(t)
	holdParallelItem(t, s, runID, "story", productionParallelAutoRetryRounds)
	work := escalateItem(t, s, runID, "story")
	if work.Abandoned || work.AutoRetryRounds != productionParallelAutoRetryRounds+1 {
		t.Fatalf("story must keep retrying instead of being skipped: %+v", work)
	}
}

func TestProductionParallelEscalationRejectsNothingToEscalate(t *testing.T) {
	s, runID := v5SubmittedStoryFixture(t)
	mutateParallelState(t, s, runID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.ProductionParallel["visual"] = productionParallelWork{Key: "visual", Name: "visual"}
	})
	run, _ := productionRuntimeState(t, s, runID)
	if err := s.escalateProductionParallelHold(run, "visual"); err == nil {
		t.Fatal("an item that is neither held nor failed must not be escalated")
	}
}

func TestProductionParallelAutoRetryOnlyForV5Plans(t *testing.T) {
	if productionParallelAutoRetryEligible(productionManifest{}, "visual") {
		t.Fatal("a run without a plan cannot auto retry")
	}
	older := productionManifest{Plan: &productionPlan{Version: 4}}
	if productionParallelAutoRetryEligible(older, "visual") {
		t.Fatal("plans before v5 keep their old hold behavior")
	}
	current := productionManifest{Plan: &productionPlan{Version: 5}}
	if !productionParallelAutoRetryEligible(current, "visual") {
		t.Fatal("v5 plans must auto retry")
	}
	current.Storyboard = &productionStoryboard{}
	if productionParallelAutoRetryEligible(current, "visual") {
		t.Fatal("storyboard stage is outside the plan auto retry")
	}
}

func TestProductionPlanStageFinishesWithWarningWhenItemsAreSetAside(t *testing.T) {
	s, runID := v5SubmittedStoryFixture(t)
	mutateParallelState(t, s, runID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		for _, key := range []string{"inventory", "visual", "direction", "generation"} {
			state.ProductionParallel[key] = productionParallelWork{Key: key, Name: key, Abandoned: true, Error: "未通过校验"}
		}
	})
	if err := s.finalizeProductionPlanStage("user", runID); err != nil {
		t.Fatal(err)
	}
	run, state := productionRuntimeState(t, s, runID)
	_, manifest, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		t.Fatal(err)
	}
	target := productionNode(doc, state.Request.Production.TargetNodeID)
	meta, _ := target["metadata"].(map[string]any)
	stage, _ := meta["taskStage"].(string)
	if !strings.Contains(stage, "4 项待处理") || meta["status"] != "success" {
		t.Fatalf("stage did not finish with a warning count: status=%v stage=%q plan=%+v", meta["status"], stage, manifest.Plan)
	}
}

func TestProductionPlanStageWaitsWhileAnItemIsStillPending(t *testing.T) {
	s, runID := v5SubmittedStoryFixture(t)
	mutateParallelState(t, s, runID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		for _, key := range []string{"inventory", "visual", "direction"} {
			state.ProductionParallel[key] = productionParallelWork{Key: key, Name: key, Abandoned: true}
		}
	})
	if err := s.finalizeProductionPlanStage("user", runID); err != nil {
		t.Fatal(err)
	}
	run, state := productionRuntimeState(t, s, runID)
	_, _, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		t.Fatal(err)
	}
	meta, _ := productionNode(doc, state.Request.Production.TargetNodeID)["metadata"].(map[string]any)
	if stage, _ := meta["taskStage"].(string); strings.Contains(stage, "待处理") {
		t.Fatalf("stage finished while generation was still pending: %q", stage)
	}
}

func TestProductionRetryItemRevivesAbandonedItemAndKeepsModelChoice(t *testing.T) {
	s, runID := v5SubmittedStoryFixture(t)
	mutateParallelState(t, s, runID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.ProductionParallel["visual"] = productionParallelWork{
			Key: "visual", Name: "公共规范", Abandoned: true, Error: "未通过校验", AutoRetryRounds: 2,
			GenerationModel: "writer-model", GenerationChannelID: "channel-1", DisableThinking: true,
		}
	})
	if err := s.RetryProductionAgentItem("user", runID, "visual"); err != nil {
		t.Fatal(err)
	}
	_, state := productionRuntimeState(t, s, runID)
	work := state.ProductionParallel["visual"]
	if work.Abandoned || work.Error != "" || work.AutoRetryRounds != 0 || work.QuietHold || work.Notice != nil {
		t.Fatalf("retry did not clear the failed attempt: %+v", work)
	}
	if work.GenerationModel != "writer-model" || work.GenerationChannelID != "channel-1" || !work.DisableThinking || work.Name != "公共规范" {
		t.Fatalf("retry lost the item's model choice: %+v", work)
	}
}

func TestProductionRetryItemRejectsUnknownKey(t *testing.T) {
	s, runID := v5SubmittedStoryFixture(t)
	if err := s.RetryProductionAgentItem("user", runID, "not-a-plan-item"); err == nil {
		t.Fatal("an item outside the plan must not be retried")
	}
}

func TestResumeQuietHeldProductionPullsOldWaitingRunBack(t *testing.T) {
	s, runID := v5SubmittedStoryFixture(t)
	mutateParallelState(t, s, runID, func(current *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.ProductionParallel["visual"] = productionParallelWork{Key: "visual", Name: "visual", QuietHold: true}
		current.Status = "waiting_user"
	})
	if !s.resumeQuietHeldProduction("user", runID) {
		t.Fatal("an old run parked on a quiet hold was not moved")
	}
	run, _ := productionRuntimeState(t, s, runID)
	if run.Status == "waiting_user" {
		t.Fatal("run is still waiting for a person")
	}

	// Without a held item there is nothing to pull back.
	mutateParallelState(t, s, runID, func(current *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.ProductionParallel["visual"] = productionParallelWork{Key: "visual", Name: "visual"}
		current.Status = "waiting_user"
	})
	if s.resumeQuietHeldProduction("user", runID) {
		t.Fatal("a run without held items must stay as it is")
	}
}

func upstreamFailedStoryWork(t *testing.T, s *Service, db *gorm.DB, runID string, status model.TaskStatus) {
	t.Helper()
	task := model.Task{ID: "story-" + newID(), UserID: "user", Type: "canvas_text", Operation: cloudAgentStepOperation, Status: status, Error: "上游流式请求失败，生成未完成"}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	mutateParallelState(t, s, runID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.TaskIDs = append(state.TaskIDs, task.ID)
		state.ProductionParallel["story"] = productionParallelWork{
			Key: "story", Name: "story", TaskID: task.ID, Error: task.Error,
			Notice: &model.TaskExecutionDiagnostic{Severity: "error", ErrorSource: "upstream", Outcome: "failed", Phase: "execution", SafeMessage: task.Error},
		}
	})
}

func TestProductionParallelUpstreamFailedTaskEscalatesToAutomaticRetry(t *testing.T) {
	s, db, runID := v5SubmittedStoryFixtureWithDB(t)
	upstreamFailedStoryWork(t, s, db, runID, model.TaskStatusFailed)
	work := escalateItem(t, s, runID, "story")
	if work.TaskID != "" || work.AutoRetryRounds != 1 || work.RetryAt == 0 || work.Error != "" {
		t.Fatalf("failed upstream task did not become an automatic retry round: %+v", work)
	}
}

func TestProductionParallelProviderTimeoutExhaustionFailsRun(t *testing.T) {
	s, _, runID := v5SubmittedStoryFixtureWithDB(t)
	mutateParallelState(t, s, runID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.ProductionParallel["story"] = productionParallelWork{
			Key: "story", Name: "故事总纲与世界规则", Error: "等待模型响应超过单次上游请求超时（5m0s）",
			Notice: &model.TaskExecutionDiagnostic{Severity: "warning", ErrorSource: "application", Code: "provider_request_timeout", Outcome: "needs_attention", Phase: "execution"},
		}
	})

	s.failPiRunner(runID, "user", errors.New("故事总纲与世界规则生成失败"))

	run, err := s.repo.CloudAgent("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != "failed" {
		t.Fatalf("run remained recoverable after provider timeout exhaustion: status=%s", run.Status)
	}
}

func TestProductionParallelRunningTaskDoesNotEscalate(t *testing.T) {
	s, db, runID := v5SubmittedStoryFixtureWithDB(t)
	upstreamFailedStoryWork(t, s, db, runID, model.TaskStatusRunning)
	run, _ := productionRuntimeState(t, s, runID)
	if err := s.escalateProductionParallelHold(run, "story"); !errors.Is(err, repository.ErrCreationConflict) {
		t.Fatalf("running task must keep the conflict, got %v", err)
	}
}
