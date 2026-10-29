package app

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestProductionPlanManualAssetsUsesSavedContinuityContract(t *testing.T) {
	for _, change := range []string{"unchanged", "edited", "deleted", "continuity_upgrade_prose", "continuity_contract"} {
		t.Run(change, func(t *testing.T) {
			s, db, run := planFixture(t, 3)
			m, _, _ := orderedPlanState(t, s, run.ID)
			m.Plan.ContinuityVersion = 0
			if err := s.repo.UpdateProductionAgentManifest("user", run.ID, productionJSON(m)); err != nil {
				t.Fatal(err)
			}
			productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
			document := orderedPlanDocument("story", "")
			document["relationships"] = "女主救出弟弟，终局兄妹获救。"
			relationship := productionRelationshipRecord{Code: "REL-001", Subject: "女主", Object: "弟弟", Relation: "siblings", Direction: "older_sister_younger_brother", Canonical: "姐姐与弟弟", Source: "已保存总纲", Scope: "全剧"}
			assets := []productionPlanAsset{{Key: "hero", Kind: "character", Name: "女主", Purpose: "主要人物", PlannedRange: "全剧"}}
			if change == "continuity_contract" {
				document["relationships"] = relationshipLedgerRow(relationship)
				assets = append(assets, productionPlanAsset{Key: "brother", Kind: "character", Name: "弟弟", Purpose: "救援目标", PlannedRange: "全剧"})
			}
			story := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "总纲", "document": document}, false)
			productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{
				StoryHash: stringValue(story["hash"]), Complete: true,
				Assets: assets,
				Absent: map[string]string{"environment": "无独立场景", "prop": "无独立道具", "sound": "无独立声音"},
			}, false)
			for _, key := range []string{"visual", "direction", "generation"} {
				submitOrderedPlan(t, s, run.ID, key, "", key)
			}
			productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
			if err := s.completeCloudAgentPiRun("user", run.ID); err != nil {
				t.Fatal(err)
			}
			m, savedDoc, rows := orderedPlanState(t, s, run.ID)
			switch change {
			case "edited", "deleted":
				productionEditCanvas(t, s, db, func(doc map[string]any) {
					for _, row := range rows {
						if row.Key != "story" {
							continue
						}
						if change == "edited" {
							productionNode(doc, row.NodeID)["metadata"].(map[string]any)["content"] = "人工修改"
						} else {
							productionNode(doc, row.NodeID)["id"] = "deleted-story"
						}
					}
				})
			case "continuity_upgrade_prose", "continuity_contract":
				m.Plan.ContinuityVersion = 1
				if change == "continuity_contract" {
					// Both participants remain registered. Only the persisted fact for
					// the same REL-ID contradicts the unchanged story receipt.
					relationship.Direction = "older_brother_younger_sister"
					relationship.Canonical = "哥哥与妹妹"
					m.Plan.Relationships = []productionRelationshipRecord{relationship}
					if err := productionValidateRelationshipParticipants(*m.Plan); err != nil {
						t.Fatal(err)
					}
					content := productionPlanStoryContent(m, savedDoc, rows, "", "")
					issues := strings.Join(productionPlanContinuityIssues(m, savedDoc, rows, "story", content, nil), "；")
					if !strings.Contains(issues, "REL-001") || !strings.Contains(issues, "结构化关系事实不一致") {
						t.Fatalf("fixture did not establish an explicit persisted relationship conflict: %s", issues)
					}
				}
				if err := s.repo.UpdateProductionAgentManifest("user", run.ID, productionJSON(m)); err != nil {
					t.Fatal(err)
				}
			}
			_, state := productionRuntimeState(t, s, run.ID)
			progress := s.productionAgentProgress("user", run.ID, &state)
			wantReady := change == "unchanged" || change == "continuity_upgrade_prose"
			wantAssetGenerationReady := change != "deleted"
			if progress.PlanReady != wantReady || progress.Validated != wantReady || progress.AssetGenerationReady != wantAssetGenerationReady || progress.ArtifactCount != 5 || progress.AssetsStarted {
				t.Fatalf("incorrect manual asset readiness: %+v", progress)
			}
			// Asset task creation is never gated by plan readiness, including
			// when the saved story document was edited or deleted.
			if err := s.GenerateProductionPlanAssets("user", run.ID, []string{"hero"}); err != nil {
				t.Fatalf("asset start must not be blocked by plan state: %v", err)
			}
			m, _, after := orderedPlanState(t, s, run.ID)
			// A deleted story node only drops its own stale receipt.
			wantRows := 5
			if change == "deleted" {
				wantRows = 4
			}
			if !m.Plan.AssetsStarted || len(after) != wantRows {
				t.Fatalf("asset action did not start or changed saved documents: started=%v rows=%d", m.Plan.AssetsStarted, len(after))
			}
		})
	}
}

func TestProductionPlanCompletedRunCanResumeMissingPlanDocuments(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	m, _, rows := orderedPlanState(t, s, runID)
	var visual model.ProductionAgentArtifact
	for _, row := range rows {
		if row.Key == "visual" {
			visual = row
		}
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionNode(doc, visual.NodeID)["id"] = "deleted-visual-document"
	})
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	if err := s.ControlProductionAgent("user", runID, "resume"); err != nil {
		t.Fatal("completed plan with a missing document should resume that document", err)
	}
	run, _ := productionRuntimeState(t, s, runID)
	m, document, rows := orderedPlanState(t, s, runID)
	if run.Status != "running" || productionPlanArtifactValid(m, document, rows, "visual") {
		t.Fatalf("resume did not reopen the incomplete plan checkpoint: status=%s", run.Status)
	}
}

func allPlanAssetKeys(t *testing.T, s *Service, runID string) []string {
	t.Helper()
	m, _, _ := orderedPlanState(t, s, runID)
	keys := []string{}
	for _, item := range m.Plan.Assets {
		keys = append(keys, item.Key)
	}
	return keys
}

func startPlanAssetsForTest(t *testing.T, s *Service, runID string) {
	t.Helper()
	if report := productionCall(t, s, runID, "production_check", map[string]any{}, false); report["valid"] != true {
		t.Fatal(report)
	}
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, allPlanAssetKeys(t, s, runID)); err != nil {
		t.Fatal(err)
	}
}

func TestProductionPlanAssetsRequireManualStart(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	assertBlocked := func() {
		t.Helper()
		m, _, _ := orderedPlanState(t, s, runID)
		if m.Plan.AssetsStarted || len(m.Plan.Groups) != 0 {
			t.Fatal("plan stage created asset groups")
		}
		if changed, err := s.ensureProductionPlanGroups("user", runID); err != nil || changed {
			t.Fatal("plan stage created groups", changed, err)
		}
	}
	for _, key := range []string{"visual", "direction", "generation"} {
		assertBlocked()
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	assertBlocked()
	requirePlanAction(t, s, runID, "validation", "")
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	execution, state := productionRuntimeState(t, s, runID)
	m, doc, rows := orderedPlanState(t, s, runID)
	progress := s.productionAgentProgress("user", runID, &state)
	if execution.Status != "completed" || !progress.PlanReady || progress.AssetsStarted || progress.TotalPages != 5 || len(rows) != 5 || len(productionParallelReady(m, doc, rows)) != 0 {
		t.Fatalf("plan did not stop at manual boundary: %+v", progress)
	}
	if err := s.GenerateProductionPlanAssets("other-user", runID, []string{"character"}); err == nil {
		t.Fatal("another user started assets")
	}
	if err := s.GenerateProductionPlanAssets("user", runID, allPlanAssetKeys(t, s, runID)); err != nil {
		t.Fatal(err)
	}
	m, doc, rows = orderedPlanState(t, s, runID)
	if !m.Plan.AssetsStarted || len(productionParallelReady(m, doc, rows)) == 0 {
		t.Fatal("explicit action did not release assets")
	}
	execution, state = productionRuntimeState(t, s, runID)
	revision := execution.Revision
	if err := s.GenerateProductionPlanAssets("user", runID, allPlanAssetKeys(t, s, runID)); err != nil {
		t.Fatal(err)
	}
	after, _ := productionRuntimeState(t, s, runID)
	if after.StateJSON != execution.StateJSON || after.Revision < revision {
		t.Fatal("duplicate action restarted work")
	}
	if changed, err := s.ensureProductionPlanGroups("user", runID); err != nil || !changed {
		t.Fatal("manual action did not permit grouping", changed, err)
	}
	for _, key := range []string{"character", "sound", "environment", "prop", "special"} {
		submitOrderedPlan(t, s, runID, key, key, "测试"+key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal("asset completion failed to update own summary", err)
	}
}

func TestProductionPlanAssetsCanStartFromWaitingUserAfterRefresh(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	run, state := productionRuntimeState(t, s, runID)
	state.ProductionPaused = false
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = "waiting_user"
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatalf("waiting_user checkpoint should accept a fresh asset batch: %v", err)
	}
	updated, _ := productionRuntimeState(t, s, runID)
	if updated.Status != "running" {
		t.Fatalf("asset task did not start from waiting_user: %s", updated.Status)
	}
}

func TestProductionPlanManualAssetsAdmitEditedDocuments(t *testing.T) {
	for _, changed := range []string{"story", "inventory", "visual", "direction", "generation"} {
		t.Run(changed, func(t *testing.T) {
			s, db, runID := parallelPlanFixture(t)
			for _, key := range []string{"visual", "direction", "generation"} {
				submitOrderedPlan(t, s, runID, key, "", key)
			}
			// Resuming a plan never grants permission for the asset stage.
			if err := s.ControlProductionAgent("user", runID, "resume"); err != nil {
				t.Fatal(err)
			}
			productionCall(t, s, runID, "production_check", map[string]any{}, false)
			if err := s.completeCloudAgentPiRun("user", runID); err != nil {
				t.Fatal(err)
			}
			m, _, rows := orderedPlanState(t, s, runID)
			if m.Plan.AssetsStarted {
				t.Fatal("ordinary resume authorized assets")
			}
			productionEditCanvas(t, s, db, func(doc map[string]any) {
				for _, row := range rows {
					if row.Key == changed {
						productionNode(doc, row.NodeID)["metadata"].(map[string]any)["content"] = "人工修订的文稿"
					}
				}
			})
			if err := s.GenerateProductionPlanAssets("user", runID, allPlanAssetKeys(t, s, runID)); err != nil {
				t.Fatalf("edited %s document blocked asset task creation: %v", changed, err)
			}
			m, _, after := orderedPlanState(t, s, runID)
			if !m.Plan.AssetsStarted || len(rows) != len(after) {
				t.Fatalf("asset task did not start or saved documents moved: started=%v rows=%d/%d", m.Plan.AssetsStarted, len(rows), len(after))
			}
		})
	}
}
