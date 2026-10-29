package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestProductionParallelSharedDocumentCorrectionPreservesCompletedDocuments(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction"} {
		run, state := productionRuntimeState(t, s, runID)
		m, doc, rows := orderedPlanState(t, s, runID)
		for _, work := range productionParallelReady(m, doc, rows) {
			if work.Key == key {
				if err := s.enqueueProductionParallel(run, &state, m, doc, rows, work); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	_, state := productionRuntimeState(t, s, runID)
	completeParallel(t, db, state.ProductionParallel["direction"])
	task, _ := s.repo.Task(state.ProductionParallel["direction"].TaskID)
	if err := s.settleProductionParallel("user", runID, state.ProductionParallel["direction"], task); err != nil {
		t.Fatal(err)
	}
	work := state.ProductionParallel["visual"]
	args, _ := json.Marshal(map[string]any{"key": work.Key, "name": work.Name, "factIds": []string{}, "document": orderedPlanDocument("visual", ""), "design": productionDesignFields{Variants: []productionDesignVariant{{Code: "CHR-0001-V0002", Name: "工作服", Description: "状态表应写在公共规范正文"}}}})
	call := productionRuntimeCall("production_submit")
	call.Function.Arguments = string(args)
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": productionRuntimeResult(t, call)}).Error; err != nil {
		t.Fatal(err)
	}
	task, _ = s.repo.Task(work.TaskID)
	if err := s.settleProductionParallel("user", runID, work, task); err != nil {
		t.Fatal(err)
	}
	run, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if !strings.Contains(work.Correction, "公共规范只提交 document") || work.TaskID != "" || work.Error != "" {
		t.Fatalf("specific validation was lost from retry: %+v", work)
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	if len(rows) != 3 || !productionPlanArtifactValid(m, doc, rows, "direction") {
		t.Fatal("failed visual draft removed completed documents")
	}
	if err := s.enqueueProductionParallel(run, &state, m, doc, rows, work); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	task, _ = s.repo.Task(work.TaskID)
	var input map[string]any
	_ = json.Unmarshal([]byte(task.InputJSON), &input)
	canonical := stateCanonicalFromInput(input)
	parameters := canonical.Tools[0]["function"].(map[string]any)["parameters"].(map[string]any)
	if parameters["properties"].(map[string]any)["design"] != nil || !strings.Contains(task.InputJSON, "公共规范只提交 document") {
		t.Fatal("retry exposed asset design or omitted the specific correction")
	}
	completeParallel(t, db, work)
	task, _ = s.repo.Task(work.TaskID)
	if err := s.settleProductionParallel("user", runID, work, task); err != nil {
		t.Fatal(err)
	}
	submitOrderedPlan(t, s, runID, "generation", "", "生成规范")
	if result := productionCall(t, s, runID, "production_check", map[string]any{}, false); result["valid"] != true {
		t.Fatal(result)
	}
	m, _, rows = orderedPlanState(t, s, runID)
	if len(rows) != 5 || m.Plan.AssetsStarted {
		t.Fatal("plan did not finish all five documents or started assets automatically")
	}
}

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

func TestNewV5PlanAutomaticallySchedulesAllPlanDocumentsAfterStory(t *testing.T) {
	s, _, run := planFixture(t, 5)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	runRecord, state := productionRuntimeState(t, s, run.ID)
	_, manifest, doc, err := productionLoad(s.repo, runRecord, &state)
	if err != nil {
		t.Fatal(err)
	}
	if !manifest.Plan.PlansStarted || strings.Join(manifest.Plan.SelectedPlanKeys, ",") != "inventory,visual,direction,generation" {
		t.Fatalf("new v5 plan did not persist its automatic scope: %+v", manifest.Plan)
	}
	ready := productionParallelReady(manifest, doc, nil)
	if len(ready) != 1 || ready[0].Key != "story" {
		t.Fatalf("expected story to be the first backend phase: %+v", ready)
	}
	storyDocument := orderedPlanDocument("story", "")
	storyDocument["episodeArchitecture"] = productionEpisodeArchitectureFixture(3)
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": storyDocument, "factIds": []string{}}, false)
	runRecord, state = productionRuntimeState(t, s, run.ID)
	_, manifest, doc, err = productionLoad(s.repo, runRecord, &state)
	if err != nil {
		t.Fatal(err)
	}
	artifacts, err := s.repo.ProductionAgentArtifacts("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	ready = productionParallelReady(manifest, doc, artifacts)
	if len(ready) != 1 || ready[0].Key != "inventory" || manifest.Plan.AssetsStarted {
		t.Fatalf("the durable backend plan did not schedule inventory first: ready=%+v plan=%+v", ready, manifest.Plan)
	}
	next := productionPlanNextAction(manifest, doc, artifacts)
	if next["inventoryReviewRequired"] != true || len(productionIDs(next["sourceSections"])) == 0 || next["sourceSectionText"] == nil {
		t.Fatal("v5 inventory phase did not receive the story evidence ledger inputs", next)
	}
	if err := s.enqueueProductionParallel(runRecord, &state, manifest, doc, artifacts, ready[0]); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, run.ID)
	task, err := s.repo.Task(state.ProductionParallel["inventory"].TaskID)
	if err != nil {
		t.Fatal(err)
	}
	var taskInput map[string]any
	if err := json.Unmarshal([]byte(task.InputJSON), &taskInput); err != nil {
		t.Fatal(err)
	}
	canonical := stateCanonicalFromInput(taskInput)
	toolParameters := canonical.Tools[0]["function"].(map[string]any)["parameters"].(map[string]any)
	toolProperties := toolParameters["properties"].(map[string]any)
	if toolProperties["inventoryReview"] == nil || !strings.Contains(task.InputJSON, "episodeArchitecture/EP-003") {
		t.Fatal("parallel inventory request lost its required story evidence inputs")
	}
}

func TestV5PlanSectionCallsKeepOnlySectionRelevantContext(t *testing.T) {
	t.Run("story keeps source inputs without asset catalogs", func(t *testing.T) {
		s, _, run := planFixture(t, 5)
		productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
		runRecord, state := productionRuntimeState(t, s, run.ID)
		manifest, doc, rows := orderedPlanState(t, s, run.ID)
		ready := productionParallelReady(manifest, doc, rows)
		if len(ready) != 1 || ready[0].Key != "story" {
			t.Fatalf("expected story work, got %+v", ready)
		}
		if err := s.enqueueProductionParallel(runRecord, &state, manifest, doc, rows, ready[0]); err != nil {
			t.Fatal(err)
		}
		_, state = productionRuntimeState(t, s, run.ID)
		task, err := s.repo.Task(state.ProductionParallel["story"].TaskID)
		if err != nil {
			t.Fatal(err)
		}
		var input map[string]any
		if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
			t.Fatal(err)
		}
		messages, _ := json.Marshal(stateCanonicalFromInput(input).Messages)
		context := string(messages)
		for _, field := range []string{"sourceInputs", "projectParameters"} {
			if !strings.Contains(context, field) {
				t.Fatalf("story request lost required context %q", field)
			}
		}
		for _, field := range []string{"sections", "registeredAssets", "existingAssets", "reuseInstruction"} {
			if strings.Contains(context, field) {
				t.Fatalf("story request retained unrelated context %q", field)
			}
		}
	})

	t.Run("standards keep only prerequisite documents", func(t *testing.T) {
		s, _, run := planFixture(t, 5)
		productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
		storyDocument := orderedPlanDocument("story", "")
		storyDocument["episodeArchitecture"] = productionEpisodeArchitectureFixture(3)
		story := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": storyDocument, "factIds": []string{}}, false)
		assets := []productionPlanAsset{{Key: "hero", Kind: "character", Name: "女主", Priority: 1, Purpose: "推动主线", PlannedRange: "全剧", Episodes: []int{1}}}
		absent := map[string]string{"environment": "无独立场景", "prop": "无独立道具", "sound": "无独立声音"}
		productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{StoryHash: stringValue(story["hash"]), Assets: assets, Absent: absent, InventoryReview: productionInventoryReviewForTest(t, s, run.ID, assets), Complete: true}, false)
		manifest, _, _ := orderedPlanState(t, s, run.ID)
		manifest.Plan.PlansStarted = true
		manifest.Plan.SelectedPlanKeys = []string{"visual"}
		encoded, err := json.Marshal(manifest)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.repo.UpdateProductionAgentManifest("user", run.ID, string(encoded)); err != nil {
			t.Fatal(err)
		}
		runID := run.ID
		runRecord, state := productionRuntimeState(t, s, runID)
		manifest, doc, rows := orderedPlanState(t, s, runID)
		work := productionParallelWork{Key: "visual", Name: "视觉与美术规范", Dependencies: productionParallelDependencyHash(manifest, rows, "visual")}
		if err := s.enqueueProductionParallel(runRecord, &state, manifest, doc, rows, work); err != nil {
			t.Fatal(err)
		}
		_, state = productionRuntimeState(t, s, runID)
		task, err := s.repo.Task(state.ProductionParallel["visual"].TaskID)
		if err != nil {
			t.Fatal(err)
		}
		var input map[string]any
		if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
			t.Fatal(err)
		}
		messages, _ := json.Marshal(stateCanonicalFromInput(input).Messages)
		context := string(messages)
		if !strings.Contains(context, "requiredDocuments") {
			t.Fatal("visual request omitted its prerequisite documents")
		}
		for _, field := range []string{"sourceInputs", "projectParameters", "sections", "registeredAssets", "existingAssets", "reuseInstruction"} {
			if strings.Contains(context, field) {
				t.Fatalf("visual request retained unrelated context %q", field)
			}
		}
	})
}

func TestProductionParallelReasoningDoesNotForceToolChoice(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	startPlanAssetsForTest(t, s, runID)
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.Policy.ReasoningMode = "deep" })
	run, state := productionRuntimeState(t, s, runID)
	m, doc, rows := orderedPlanState(t, s, runID)
	work := productionParallelWork{Key: "character", Name: "测试人物", ValidationAttempts: 1, Dependencies: productionParallelDependencyHash(m, rows, "character")}
	if err := s.enqueueProductionParallel(run, &state, m, doc, rows, work); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	task, err := s.repo.Task(state.ProductionParallel[work.Key].TaskID)
	if err != nil {
		t.Fatal(err)
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if got := stateCanonicalFromInput(input).ToolChoice; got != "auto" {
		t.Fatalf("reasoning asset task forced tool choice: %v", got)
	}
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
	var task model.Task
	if err := db.First(&task, "id = ?", work.TaskID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "input_json": completedTaskInputJSON(task), "result_json": productionRuntimeResult(t, call)}).Error; err != nil {
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
	submitOrderedPlan(t, s, runID, "generation", "", "生成规范")
	startPlanAssetsForTest(t, s, runID)
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ProductionPaused = false })
	cancel, done = startParallel(t, s, runID)
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 3 })
	manifest, assetDoc, assetRows := orderedPlanState(t, s, runID)
	if err := productionParallelPrerequisites(manifest, assetDoc, assetRows, "sound"); err != nil {
		t.Fatalf("sound asset remained blocked by an unselected dependency: %v", err)
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
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["sound"].TaskID != "" })
	if len(state.ProductionParallel) != 3 || len(state.TaskIDs) != initialTasks+6 {
		t.Fatal("incorrect concurrency/receipt reuse")
	}
	completeParallel(t, db, state.ProductionParallel["character"])
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["special"].TaskID != "" })
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
	if progress.DocumentCount != 5 || progress.AssetCount != 5 || progress.DocumentTotal != 5 {
		t.Fatalf("incorrect counts: %+v", progress)
	}
	if report := productionCall(t, s, runID, "production_check", map[string]any{}, false); report["valid"] != true {
		t.Fatal(report)
	}
}

func TestProductionParallelFailureDrainsIndependentWorkAndDelayedRetries(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	startPlanAssetsForTest(t, s, runID)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 3 })
	cancel()
	<-done
	initialCalls := len(state.TaskIDs)
	for _, key := range []string{"character", "environment"} {
		work := state.ProductionParallel[key]
		if work.TaskID == "" {
			t.Fatal("missing initial task", key)
		}
		if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "test failure"}).Error; err != nil {
			t.Fatal(err)
		}
		status, code := 400, "invalid_request_error"
		if key == "environment" {
			status, code = 200, "unavailable"
		}
		if err := db.Create(&model.ApiCallLog{ID: newID(), TaskID: work.TaskID, StatusCode: status, ErrorCode: code}).Error; err != nil {
			t.Fatal(err)
		}
		task, _ := s.repo.Task(work.TaskID)
		if err := s.settleProductionParallel("user", runID, work, task); err != nil {
			t.Fatal(err)
		}
	}
	_, state = productionRuntimeState(t, s, runID)
	if state.ProductionParallel["character"].Error == "" || state.ProductionParallel["environment"].TaskID != "" || state.ProductionParallel["environment"].TransientAttempts != 1 {
		t.Fatal("permanent and transient failures not isolated", state.ProductionParallel)
	}
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
		work := state.ProductionParallel["environment"]
		work.RetryAt = time.Now().Add(time.Minute).UnixMilli()
		state.ProductionParallel["environment"] = work
	})
	// Restart with a failed item, a delayed retry, and an outstanding sibling.
	// An additional independent asset must still be admitted to the free slot.
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	_, done = startParallel(t, s, runID)
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["special"].TaskID != "" })
	for _, key := range []string{"prop", "special"} {
		completeParallel(t, db, state.ProductionParallel[key])
	}
	waitParallel(t, s, runID, func(state cloudAgentRuntime) bool {
		return len(state.ProductionParallel) == 2 && state.ProductionParallel["environment"].TaskID == ""
	})
	select {
	case err := <-done:
		t.Fatal("batch stopped before delayed retry became eligible", err)
	default:
	}
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
		work := state.ProductionParallel["environment"]
		work.RetryAt = 0
		state.ProductionParallel["environment"] = work
	})
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["environment"].TaskID != "" })
	completeParallel(t, db, state.ProductionParallel["environment"])
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "1 项文稿未完成") || !strings.Contains(err.Error(), "测试character") {
			t.Fatal("batch did not report its failed item after draining", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("failed item left the batch stuck after independent work drained")
	}
	_, state = productionRuntimeState(t, s, runID)
	if len(state.ProductionParallel) != 1 || len(state.TaskIDs) != initialCalls+2 {
		t.Fatal("failed item retried automatically or dependent sound was dispatched", state.ProductionParallel)
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	if len(rows) != 8 || productionPlanPrerequisites(m, doc, rows, "sound") == nil {
		t.Fatal("independent results were lost or failed dependency was bypassed")
	}
	for _, key := range []string{"environment", "prop", "special"} {
		if !productionPlanArtifactValid(m, doc, rows, key) {
			t.Fatal("independent document not saved", key)
		}
	}
}

func TestProductionPlanRegroupPreservesReceiptsAndFillsFirstCell(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	submitOrderedPlan(t, s, runID, "visual", "", "美术规范")
	submitOrderedPlan(t, s, runID, "direction", "", "导演规范")
	submitOrderedPlan(t, s, runID, "generation", "", "生成规范")
	startPlanAssetsForTest(t, s, runID)
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

func TestProductionPlanGroupCreationLeavesUnselectedEditedAssetsUntouched(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	if result := productionCall(t, s, runID, "production_check", map[string]any{}, false); result["valid"] != true {
		t.Fatal(result)
	}
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	_, _, before := orderedPlanState(t, s, runID)
	var character model.ProductionAgentArtifact
	for _, row := range before {
		if row.Key == "character" {
			character = row
		}
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionNode(doc, character.NodeID)["metadata"].(map[string]any)["content"] = "用户手动修改的人物文稿"
	})
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"prop"}); err != nil {
		t.Fatal("starting an independent selected asset should not be blocked by an unrelated edited document", err)
	}
	if changed, err := s.ensureProductionPlanGroups("user", runID); err != nil || !changed {
		t.Fatal("creating the selected prop group should preserve the unselected edit", changed, err)
	}
	m, doc, after := orderedPlanState(t, s, runID)
	if productionNode(doc, character.NodeID)["metadata"].(map[string]any)["content"] != "用户手动修改的人物文稿" {
		t.Fatal("group creation overwrote the user's character edit")
	}
	if productionPlanArtifactValid(m, doc, after, "character") {
		t.Fatal("group creation silently adopted the user's edit as a generated receipt")
	}
	if m.Plan.Groups["prop"] == "" {
		t.Fatal("selected prop group was not created")
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
	if err := s.settleProductionParallel("user", runID, work, task); err != nil {
		t.Fatal("stale result should be checkpointed for manual retry, not left in saving state", err)
	}
	_, after := productionRuntimeState(t, s, runID)
	stale := after.ProductionParallel["visual"]
	if stale.TaskID != "" || stale.Error == "" || !stale.QuietHold || stale.RetryAt != 0 || len(after.TaskIDs) != len(state.TaskIDs) {
		t.Fatal("source change left a saving task or billed an automatic retry", stale)
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
	if state.ProductionParallel["visual"].ValidationAttempts != 1 || state.ProductionParallel["visual"].TransientAttempts != 0 {
		t.Fatalf("validation failure used the wrong retry budget: %+v", state.ProductionParallel["visual"])
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
		work.ValidationSignature, work.RepeatedValidationFailures = "same-failure", cloudAgentToolAttemptLimit
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
	if state.ProductionParallel["visual"].Error != "" || state.ProductionParallel["visual"].Attempts != 0 || state.ProductionParallel["visual"].ValidationSignature != "" || state.ProductionParallel["visual"].RepeatedValidationFailures != 0 {
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
