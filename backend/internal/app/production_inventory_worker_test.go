package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func completeInventoryWorker(t *testing.T, s *Service, runID string, work productionParallelWork, input productionPlan) {
	t.Helper()
	call := productionRuntimeCall("production_plan_inventory")
	encoded, _ := json.Marshal(input)
	call.Function.Arguments = string(encoded)
	// Commit the same model receipt used by the real scheduler, without an API call.
	if err := s.commitProductionParallel("user", runID, work, &model.Task{ID: work.TaskID}, call); err != nil {
		t.Fatal(err)
	}
}

func TestProductionInventoryWorkerIsolatesBadSectionAndPublishesDraft(t *testing.T) {
	s, _, runID := v5SubmittedStoryFixtureWithDB(t)
	assets := []productionPlanAsset{{Key: "hero", Kind: "character", Name: "主角", Priority: 1, Purpose: "推动主线", PlannedRange: "全剧"}}
	reviews := productionInventoryReviewForTest(t, s, runID, assets)
	work := enqueueDocumentPart(t, s, runID, "inventory")
	m, doc, rows := orderedPlanState(t, s, runID)
	_, bodies := productionInventoryReviewSources(*m.Plan, productionInventoryStory(doc, rows))
	for i := 0; i < 2; i++ {
		reviews[i].Append = true // First submission must not require a missing previous batch.
		reviews[i].NoAssetsReason = ""
		reviews[i].Requirements = []productionInventoryRequirement{{Subject: "主角", AssetKey: "hero", Disposition: "asset", Reason: "推动本节行动"}}
		reviews[i].Requirements[0].SourceRef = productionInventoryFragments(productionDocumentTargetHash(rows, "story"), reviews[i].Section, bodies[reviews[i].Section])[0].ID
		reviews[i].Requirements[0].Quote = ""
	}
	reviews[1].Requirements[0].SourceRef = "wrong-section-or-version"
	completeInventoryWorker(t, s, runID, work, productionPlan{StoryHash: "model-hallucinated-hash", Complete: true, Assets: assets, InventoryReview: reviews[:2]})
	m, doc, rows = orderedPlanState(t, s, runID)
	if len(m.Plan.Assets) != 1 || len(m.Plan.InventoryReview) != 1 || m.Plan.InventoryReview[0].Section != reviews[0].Section {
		t.Fatalf("accepted section lost with its invalid sibling: %+v", m.Plan)
	}
	if m.Plan.Complete || productionDocumentTargetHash(rows, "inventory") == "" || productionPlanArtifactValid(m, doc, rows, "inventory") {
		t.Fatal("draft was hidden or passed completion gates")
	}
	for _, row := range rows {
		if row.Key == "inventory" {
			node := productionNode(doc, row.NodeID)
			if productionWorkflow(node)["inventoryComplete"] != false || !strings.Contains(stringValue(node["metadata"].(map[string]any)["content"]), "待核对") {
				t.Fatal("draft status missing from projection")
			}
		}
	}
	_, state := productionRuntimeState(t, s, runID)
	pending := state.ProductionParallel["inventory"]
	if !strings.Contains(pending.Correction, "invalid_source_ref") || pending.InventoryNoProgress != 0 {
		t.Fatal("partial receipt lost error details or counted genuine progress as failure")
	}
}

func TestProductionInventoryWorkerStopsEmptyBatchesAcrossRestartAndManualRetry(t *testing.T) {
	s, db, runID := v5SubmittedStoryFixtureWithDB(t)
	for i := 1; i <= 3; i++ {
		work := enqueueDocumentPart(t, s, runID, "inventory")
		completeInventoryWorker(t, s, runID, work, productionPlan{})
		s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
		_, state := productionRuntimeState(t, s, runID)
		pending := state.ProductionParallel["inventory"]
		if pending.InventoryNoProgress != i || pending.Abandoned != (i == 3) || pending.TaskID != "" {
			t.Fatalf("empty batch %d reset bounded recovery: %+v", i, pending)
		}
	}
	m, _, _ := orderedPlanState(t, s, runID)
	m.Plan.PlansStarted, m.Plan.SelectedPlanKeys = true, []string{"inventory"}
	encoded, _ := json.Marshal(m)
	if err := s.repo.UpdateProductionAgentManifest("user", runID, string(encoded)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := s.runProductionParallel(ctx, "user", runID); err != nil {
		t.Fatal(err)
	}
	run, _ := productionRuntimeState(t, s, runID)
	if run.Status != "waiting_user" {
		t.Fatal("exhausted inventory was completed or dispatched instead of held", run.Status)
	}
	if err := s.RetryProductionAgentItem("user", runID, "inventory"); err != nil {
		t.Fatal(err)
	}
	_, state := productionRuntimeState(t, s, runID)
	pending := state.ProductionParallel["inventory"]
	if pending.Abandoned || pending.QuietHold || pending.InventoryNoProgress != 0 {
		t.Fatal("manual retry did not reopen inventory")
	}
}

func TestProductionInventoryWorkerReducesScopeAfterOutputLimit(t *testing.T) {
	s, db, runID := v5SubmittedStoryFixtureWithDB(t)
	work := enqueueDocumentPart(t, s, runID, "inventory")
	before := len(work.InventorySections)
	failDocumentPart(t, s, db, runID, work)
	_, state := productionRuntimeState(t, s, runID)
	pending := state.ProductionParallel["inventory"]
	if pending.DocumentParts != nil || pending.Error != "" || pending.InventoryNoProgress != 1 {
		t.Fatalf("inventory output limit used document splitter: %+v", pending)
	}
	work = enqueueDocumentPart(t, s, runID, "inventory")
	if len(work.InventorySections) >= before {
		t.Fatal("output-limit recovery did not reduce assigned source scope")
	}
}

func TestProductionInventoryWorkerAssignsOnlyMissingEpisodesAndScopesInstructions(t *testing.T) {
	m := productionManifest{Plan: &productionPlan{Version: 5, InventoryReviewVersion: 1}}
	fields := orderedPlanDocument("story", "")
	fields["episodeArchitecture"] = productionEpisodeArchitectureFixture(120)
	story, err := productionRenderPlanDocumentForSchema("story", "", fields, 2)
	if err != nil {
		t.Fatal(err)
	}
	rows := []model.ProductionAgentArtifact{{Key: "story", NodeID: "story-node", ContentHash: "source-version"}}
	doc := map[string]any{"nodes": []any{map[string]any{"id": "story-node", "metadata": map[string]any{"content": story}}}}
	m.Plan.StoryHash = "source-version"
	sections, _ := productionInventoryReviewSources(*m.Plan, story)
	for _, section := range sections {
		if section >= "episodeArchitecture/EP-061" && section <= "episodeArchitecture/EP-073" {
			continue
		}
		m.Plan.InventoryReview = append(m.Plan.InventoryReview, productionInventorySectionReview{Section: section})
	}
	work := productionParallelWork{Key: "inventory"}
	context := map[string]any{"requiredDocuments": strings.Repeat("full-story", 100), "sourceSectionText": "full-story-again"}
	productionInventoryWorkerContext(m, doc, rows, &work, context)
	if len(work.InventorySections) != 6 || work.InventorySections[0] != "episodeArchitecture/EP-061" || work.InventorySections[5] != "episodeArchitecture/EP-066" {
		t.Fatalf("wrong missing episode assignment: %v", work.InventorySections)
	}
	if context["requiredDocuments"] != nil || context["sourceSectionText"] != nil || context["nextAction"].(map[string]any)["inventoryReview"] != nil {
		t.Fatal("worker still receives duplicate full source or accepted ledger")
	}
	policy, prompt := productionDocumentWorkPrompt("base policy", "只生成总纲，资产总表本次不要生成", m, work, context)
	if strings.Contains(policy+prompt, "资产总表本次不要生成") || strings.Contains(policy, independentPlanPolicy) {
		t.Fatal("old stage instructions leaked into inventory")
	}
	tools := productionRuntimeTools(m, context)
	productionInventoryWorkerTools(tools, work)
	for _, tool := range tools {
		fn := tool["function"].(map[string]any)
		if fn["name"] == "production_plan_inventory" {
			props := fn["parameters"].(map[string]any)["properties"].(map[string]any)
			if props["storyHash"] != nil || props["complete"] != nil {
				t.Fatal("model still owns execution metadata")
			}
			encoded, _ := json.Marshal(props["inventoryReview"])
			if strings.Contains(string(encoded), `"quote"`) || !strings.Contains(string(encoded), `"sourceRef"`) {
				t.Fatal("model must still copy literal quotes")
			}
		}
	}
}

func TestProductionInventoryWorkerRejectsUnknownFieldWithoutErasingCheckpoint(t *testing.T) {
	s, _, runID := v5SubmittedStoryFixtureWithDB(t)
	work := enqueueDocumentPart(t, s, runID, "inventory")
	m, _, _ := orderedPlanState(t, s, runID)
	before := productionHash(m.Plan)
	call := productionRuntimeCall("production_plan_inventory")
	call.Function.Arguments = `{"assets":[],"abs":{},"inventoryReview":[]}`
	err := s.commitProductionParallel("user", runID, work, &model.Task{ID: work.TaskID}, call)
	if err == nil || !strings.Contains(err.Error(), "abs") {
		t.Fatalf("unsupported field has no precise feedback: %v", err)
	}
	m, _, _ = orderedPlanState(t, s, runID)
	if productionHash(m.Plan) != before {
		t.Fatal("unknown field damaged accepted progress")
	}
}

func TestProductionInventoryWorkerPreservesManuallyEditedDraft(t *testing.T) {
	s, db, runID := v5SubmittedStoryFixtureWithDB(t)
	work := enqueueDocumentPart(t, s, runID, "inventory")
	asset := productionPlanAsset{Key: "hero", Kind: "character", Name: "主角", Priority: 1, Purpose: "推动主线", PlannedRange: "全剧"}
	completeInventoryWorker(t, s, runID, work, productionPlan{Assets: []productionPlanAsset{asset}})
	work = enqueueDocumentPart(t, s, runID, "inventory")
	m, _, rows := orderedPlanState(t, s, runID)
	before := productionHash(m.Plan)
	var nodeID string
	for _, row := range rows {
		if row.Key == "inventory" {
			nodeID = row.NodeID
		}
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionNode(doc, nodeID)["metadata"].(map[string]any)["content"] = "用户手工修订"
	})
	call := productionRuntimeCall("production_plan_inventory")
	call.Function.Arguments = `{"assets":[],"absent":{"prop":"没有实体道具"},"inventoryReview":[]}`
	if err := s.commitProductionParallel("user", runID, work, &model.Task{ID: work.TaskID}, call); err == nil {
		t.Fatal("manual draft revision was overwritten")
	}
	m, doc, _ := orderedPlanState(t, s, runID)
	if productionHash(m.Plan) != before || stringValue(productionNode(doc, nodeID)["metadata"].(map[string]any)["content"]) != "用户手工修订" {
		t.Fatal("stale submit changed manifest or draft")
	}
}

func TestProductionLargeStoryNormalContinuationKeepsBatchSize(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionWorkflow(productionNode(doc, "group"))["parameters"].(map[string]any)["episodeCount"] = 120
	})
	run, state := productionRuntimeState(t, s, runID)
	m, doc, rows := orderedPlanState(t, s, runID)
	m.Plan.StoryStructureVersion = 1
	for _, fields := range [][]string{{"premise", "motivation", "conflict"}, {"episodeArchitecture"}, {"premise"}} {
		work := productionParallelWork{Key: "story", Name: "总纲", Dependencies: productionParallelDependencyHash(m, rows, "story"), DocumentParts: &productionDocumentParts{
			SchemaVersion: productionPlanDocumentSchemaVersion(m.Plan.Version), ExpectedHash: productionDocumentTargetHash(rows, "story"), Fields: map[string]string{}, Pending: [][]string{fields}, EpisodeBatchSize: 4,
		}}
		if err := s.enqueueProductionParallel(run, &state, m, doc, rows, work); err != nil {
			t.Fatal(err)
		}
		run, state = productionRuntimeState(t, s, runID)
		queued := state.ProductionParallel["story"].DocumentParts
		if len(queued.Pending[0]) != len(fields) || queued.EpisodeBatchSize != 4 {
			t.Fatal("ordinary enqueue subdivided a valid batch")
		}
	}
}
