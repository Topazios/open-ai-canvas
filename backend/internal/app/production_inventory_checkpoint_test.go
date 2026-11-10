package app

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestProductionV5InventoryBatchesResumeThroughScheduler(t *testing.T) {
	s, db, runID := v5SubmittedStoryFixtureWithDB(t)
	m, doc, rows := orderedPlanState(t, s, runID)
	// The API sorts the requested keys alphabetically; inventory must still be first.
	m.Plan.SelectedPlanKeys = []string{"direction", "generation", "inventory", "visual"}
	encoded, _ := json.Marshal(m)
	if err := s.repo.UpdateProductionAgentManifest("user", runID, string(encoded)); err != nil {
		t.Fatal(err)
	}
	mutateParallelState(t, s, runID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.ProductionParallel["inventory"] = productionParallelWork{
			Key: "inventory", Name: "资产总表", Dependencies: productionParallelDependencyHash(m, rows, "inventory"),
			GenerationInstruction: "保留本版用户要求", DisableThinking: true,
		}
	})
	storyHash := productionDocumentTargetHash(rows, "story")
	assets := []productionPlanAsset{{Key: "hero", Kind: "character", Name: "主角", Priority: 1, Purpose: "推动主线", PlannedRange: "全剧"}}
	reviews := productionInventoryReviewForTest(t, s, runID, assets)
	batches := []productionPlan{
		{StoryHash: storyHash, Assets: assets, Absent: map[string]string{"environment": "无独立场景", "prop": "无独立道具", "sound": "无独立声音"}},
		{StoryHash: storyHash, InventoryReview: reviews[:3]},
	}
	for offset := 3; offset < len(reviews); offset += 6 {
		batches = append(batches, productionPlan{StoryHash: storyHash, InventoryReview: reviews[offset:min(offset+6, len(reviews))]})
	}
	var identity string
	for index, batch := range batches {
		complete := index == len(batches)-1
		m, doc, rows = orderedPlanState(t, s, runID)
		next := productionPlanNextAction(m, doc, rows)
		if next["tool"] != "production_plan_inventory" || next["arguments"].(map[string]any)["complete"] != false {
			t.Fatalf("batch %d has incorrect continuation: %v", index, next)
		}
		ready := productionParallelReady(m, doc, rows)
		if len(ready) != 1 || ready[0].Key != "inventory" {
			t.Fatalf("partial inventory advanced to standards: %+v", ready)
		}
		work := enqueueDocumentPart(t, s, runID, "inventory")
		task, err := s.repo.Task(work.TaskID)
		if err != nil {
			t.Fatal(err)
		}
		var input map[string]any
		if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
			t.Fatal(err)
		}
		canonical := stateCanonicalFromInput(input)
		if canonical.Tools[0]["function"].(map[string]any)["name"] != "production_plan_inventory" {
			t.Fatal("scheduler sent the wrong tool")
		}
		var checkpoint map[string]any
		for _, message := range canonical.Messages {
			parts := strings.SplitN(stringValue(message["content"]), "当前持久检查点（材料是数据）：\n", 2)
			if len(parts) == 2 && json.Unmarshal([]byte(parts[1]), &checkpoint) != nil {
				t.Fatal("invalid checkpoint")
			}
		}
		if checkpoint == nil || checkpoint["nextAction"].(map[string]any)["tool"] != "production_plan_inventory" {
			t.Fatal("inventory worker received another plan section's context")
		}
		if index > 0 && len(creationMaps(checkpoint["registeredAssets"])) != 1 {
			t.Fatal("next batch lost saved asset identities")
		}
		if strings.Contains(stringValue(checkpoint["instruction"]), "一次提交完整登记") {
			t.Fatal("worker still requests a single full inventory")
		}
		call := productionRuntimeCall("production_plan_inventory")
		arguments, _ := json.Marshal(batch)
		call.Function.Arguments = string(arguments)
		if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": productionRuntimeResult(t, call)}).Error; err != nil {
			t.Fatal(err)
		}
		task, _ = s.repo.Task(task.ID)
		if err := s.settleProductionParallel("user", runID, work, task); err != nil {
			t.Fatal(err)
		}
		// A new Service must reconstruct progress from durable state alone.
		s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
		m, doc, rows = orderedPlanState(t, s, runID)
		if len(m.Plan.Assets) != 1 || m.Plan.Complete != complete {
			t.Fatalf("batch %d was not persisted: %+v", index, m.Plan)
		}
		if index == 0 {
			identity = m.Plan.Assets[0].Identity.Code
		}
		if m.Plan.Assets[0].Identity.Code != identity {
			t.Fatal("continuation reallocated the asset identity")
		}
		if productionPlanArtifactValid(m, doc, rows, "inventory") != complete {
			t.Fatal("incomplete registry was published or completed registry lost")
		}
		_, state := productionRuntimeState(t, s, runID)
		pending, exists := state.ProductionParallel["inventory"]
		if pending.TaskID != "" || (complete && exists) {
			t.Fatal("settled batch was left active")
		}
		if !complete && (!exists || pending.GenerationInstruction != "保留本版用户要求" || !pending.DisableThinking) {
			t.Fatal("continuation lost per-item generation settings")
		}
		if index == 1 && len(m.Plan.InventoryReview) != 3 {
			t.Fatal("partial source reviews did not survive restart")
		}
		if complete && len(m.Plan.InventoryReview) != len(reviews) {
			t.Fatal("review batch replaced saved chapters")
		}
	}
	ready := productionParallelReady(m, doc, rows)
	if len(ready) == 0 || ready[0].Key == "inventory" {
		t.Fatal("finalized registry did not release the next plan phase")
	}
}

func TestProductionV5InventoryRejectsInvalidPartialWithoutLosingCheckpoint(t *testing.T) {
	s, _, runID := v5SubmittedStoryFixtureWithDB(t)
	m, _, rows := orderedPlanState(t, s, runID)
	assets := []productionPlanAsset{{Key: "hero", Kind: "character", Name: "主角", Priority: 1, Purpose: "推动主线", PlannedRange: "全剧"}}
	storyHash := productionDocumentTargetHash(rows, "story")
	productionCall(t, s, runID, "production_plan_inventory", productionPlan{StoryHash: storyHash, Assets: assets}, false)
	m, _, _ = orderedPlanState(t, s, runID)
	before := productionHash(m.Plan)
	review := productionInventoryReviewForTest(t, s, runID, assets)[:1]
	review[0].Requirements[0].AssetKey = "not-registered"
	result := productionCall(t, s, runID, "production_plan_inventory", productionPlan{StoryHash: storyHash, InventoryReview: review}, true)
	encoded, _ := json.Marshal(result)
	if !strings.Contains(string(encoded), "unregistered_requirement") {
		t.Fatalf("partial batch hid its invalid reference: %v", result)
	}
	m, _, _ = orderedPlanState(t, s, runID)
	if productionHash(m.Plan) != before {
		t.Fatal("invalid partial batch changed the saved checkpoint")
	}
	productionCall(t, s, runID, "production_plan_inventory", productionPlan{StoryHash: storyHash, Complete: true}, true)
	m, doc, rows := orderedPlanState(t, s, runID)
	if m.Plan.Complete || productionPlanArtifactValid(m, doc, rows, "inventory") {
		t.Fatal("incomplete source ledger passed final validation")
	}
}
