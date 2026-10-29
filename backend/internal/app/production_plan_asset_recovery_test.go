package app

import (
	"encoding/json"
	"reflect"
	"slices"
	"testing"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func failPlanForAssetRecovery(t *testing.T, s *Service, runID string) {
	t.Helper()
	run, _ := productionRuntimeState(t, s, runID)
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		current.Status = "failed"
		state.ProductionParallel = map[string]productionParallelWork{"prop": {Key: "prop", Name: "道具", Error: "旧批次服务不可用", Attempts: 6}}
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
}

func readyPlanForAssetRecovery(t *testing.T) (*Service, *gorm.DB, string) {
	t.Helper()
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	startPlanAssetsForTest(t, s, runID)
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	return s, db, runID
}

func TestProductionPlanCanRecoverFailedEmptyInventoryCheckpoint(t *testing.T) {
	s, _, run := planFixture(t, 5)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	storyDocument := orderedPlanDocument("story", "")
	storyDocument["episodeArchitecture"] = productionEpisodeArchitectureFixture(3)
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": storyDocument, "factIds": []string{}}, false)

	execution, _ := s.repo.CloudAgent("user", run.ID)
	if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		current.Status = "failed"
		state.ProductionParallel = map[string]productionParallelWork{}
		state.ProductionParallel["inventory"] = productionParallelWork{Key: "inventory", Name: "资产总表", Error: "旧批次清单为空"}
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}

	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanSections("user", run.ID, []string{"inventory"}); err != nil {
		t.Fatalf("explicit inventory retry should clear its terminal error checkpoint: %v", err)
	}
	updated, state := productionRuntimeState(t, s, run.ID)
	manifest, _, _ := orderedPlanState(t, s, run.ID)
	if updated.Status != "running" || !manifest.Plan.PlansStarted || !reflect.DeepEqual(manifest.Plan.SelectedPlanKeys, []string{"inventory"}) {
		t.Fatalf("inventory recovery was not persisted: status=%s plan=%+v", updated.Status, manifest.Plan)
	}
	if _, exists := state.ProductionParallel["inventory"]; exists {
		t.Fatal("old inventory failure checkpoint was not cleared")
	}
}

func TestProductionPlanCanRecoverCompletedEmptyInventoryCheckpoint(t *testing.T) {
	s, _, run := planFixture(t, 5)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	storyDocument := orderedPlanDocument("story", "")
	storyDocument["episodeArchitecture"] = productionEpisodeArchitectureFixture(3)
	story := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": storyDocument, "factIds": []string{}}, false)
	assets := []productionPlanAsset{{Key: "hero", Kind: "character", Name: "女主", Priority: 1, Purpose: "推动主线", PlannedRange: "全剧"}}
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{
		StoryHash: stringValue(story["hash"]), Complete: true,
		Assets: assets, InventoryReview: productionInventoryReviewForTest(t, s, run.ID, assets),
		Absent: map[string]string{"environment": "无独立场景", "prop": "无独立道具", "sound": "无独立声音"},
	}, false)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, run.ID, key, "", key)
	}

	execution, _ := s.repo.CloudAgent("user", run.ID)
	job, err := s.repo.ProductionAgentJob("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var manifest productionManifest
	if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Plan.Assets = []productionPlanAsset{}
	manifest.Plan.PlansStarted = true
	manifest.Plan.SelectedPlanKeys = []string{"inventory", "visual", "direction", "generation"}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, string(encoded)); err != nil {
		t.Fatal(err)
	}
	execution, _ = s.repo.CloudAgent("user", run.ID)
	if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = "completed"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	s.disablePiRuntime = true
	completed, state := productionRuntimeState(t, s, run.ID)
	progress := s.productionAgentProgress("user", run.ID, &state)
	if !progress.InventoryRecoveryAvailable {
		t.Fatal("completed run with an invalid zero-item inventory receipt did not expose recovery")
	}
	if err := s.GenerateProductionPlanSections("user", completed.ID, []string{"inventory"}); err != nil {
		t.Fatalf("explicit inventory recovery should reopen a completed empty-inventory run: %v", err)
	}
	updated, state := productionRuntimeState(t, s, run.ID)
	manifest, _, _ = orderedPlanState(t, s, run.ID)
	if updated.Status != "running" || !manifest.Plan.PlansStarted || !reflect.DeepEqual(manifest.Plan.SelectedPlanKeys, []string{"inventory"}) {
		t.Fatalf("completed inventory recovery was not persisted: status=%s plan=%+v", updated.Status, manifest.Plan)
	}
	if _, exists := state.ProductionParallel["inventory"]; exists {
		t.Fatal("stale inventory checkpoint was not cleared")
	}
	rows, err := s.repo.ProductionAgentArtifacts("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.Key == "inventory" {
			t.Fatal("empty inventory receipt remained valid after explicit recovery")
		}
	}
}

func TestProductionPlanAssetGenerationRecoversOrphanedQueuedExecution(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	run, _ := s.repo.CloudAgent("user", runID)
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = "queued"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatalf("orphaned queued plan with no live provider calls should be recoverable: %v", err)
	}
	updated, _ := productionRuntimeState(t, s, runID)
	manifest, _, _ := orderedPlanState(t, s, runID)
	if updated.Status != "running" || !reflect.DeepEqual(manifest.Plan.SelectedAssetKeys, []string{"character"}) {
		t.Fatalf("queued asset generation did not restart: status=%s selected=%v", updated.Status, manifest.Plan.SelectedAssetKeys)
	}
}

func TestProductionPlanAssetGenerationCanRestartCancelledRunAfterCallsAreSettled(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	run, _ := s.repo.CloudAgent("user", runID)
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = "cancelled"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatalf("cancelled run with no live provider calls should admit an explicit new asset batch: %v", err)
	}
	updated, _ := productionRuntimeState(t, s, runID)
	manifest, _, _ := orderedPlanState(t, s, runID)
	if updated.Status != "running" || !reflect.DeepEqual(manifest.Plan.SelectedAssetKeys, []string{"character"}) {
		t.Fatalf("cancelled run did not restart: status=%s selected=%v", updated.Status, manifest.Plan.SelectedAssetKeys)
	}
}

func TestProductionPlanExplicitGenerationRecoversDeletedCollections(t *testing.T) {
	for _, kind := range productionPlanGroupKinds {
		for _, removeRootIndex := range []bool{false, true} {
			name := kind
			if removeRootIndex {
				name += "_without_root_index"
			}
			t.Run(name, func(t *testing.T) {
				s, db, runID := readyPlanForAssetRecovery(t)
				m, _, before := orderedPlanState(t, s, runID)
				oldGroups := map[string]string{}
				for kind, id := range m.Plan.Groups {
					oldGroups[kind] = id
				}
				productionEditCanvas(t, s, db, func(doc map[string]any) {
					nodes := []map[string]any{}
					root := productionWorkflow(productionNode(doc, m.FrameID))
					groups, _ := root["planGroups"].(map[string]any)
					for _, node := range creationMaps(doc["nodes"]) {
						group := productionWorkflow(node)["planGroup"]
						if group != nil {
							continue
						}
						nodes = append(nodes, node)
					}
					if removeRootIndex {
						for indexedKind := range groups {
							delete(groups, indexedKind)
						}
					}
					doc["nodes"] = nodes
				})
				failPlanForAssetRecovery(t, s, runID)
				run, state := productionRuntimeState(t, s, runID)
				if _, _, _, err := productionLoad(s.repo, run, &state); err == nil {
					t.Fatal("background work could revive a deleted collection")
				}
				keys := []string{kind}
				if err := s.GenerateProductionPlanAssets("user", runID, keys); err != nil {
					t.Fatal("explicit generation cannot recover deleted collections", err)
				}
				m, doc, rows := orderedPlanState(t, s, runID)
				if len(m.Plan.Groups) != 0 || !productionPlanStandardsReady(m, doc, rows) {
					t.Fatal("cleanup recreated groups or changed the saved standards")
				}
				for _, prior := range before {
					if _, ok := planSection(prior.Key); ok && !productionPlanArtifactValid(m, doc, rows, prior.Key) {
						t.Fatal("saved standards invalidated", prior.Key)
					}
				}
				if changed, err := s.ensureProductionPlanGroups("user", runID); err != nil || !changed {
					t.Fatal("stopped unrelated checkpoints blocked collection creation", changed, err)
				}
				m, doc, _ = orderedPlanState(t, s, runID)
				if len(m.Plan.Groups) != len(keys) {
					t.Fatal("unselected categories were created", m.Plan.Groups)
				}
				for _, key := range keys {
					if m.Plan.Groups[key] == oldGroups[key] || productionNode(doc, oldGroups[key]) != nil {
						t.Fatal("deleted collection ID was resurrected")
					}
				}
			})
		}
	}
}

func TestProductionPlanExplicitGenerationRecoversDeletedAssetInExistingCollection(t *testing.T) {
	s, db, runID := readyPlanForAssetRecovery(t)
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	submitOrderedPlan(t, s, runID, "environment", "environment", "测试environment")
	m, _, rows := orderedPlanState(t, s, runID)
	groupID := m.Plan.Groups["character"]
	var deleted, preserved model.ProductionAgentArtifact
	for _, row := range rows {
		if row.Key == "character" {
			deleted = row
		}
		if row.Key == "environment" {
			preserved = row
		}
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		nodes := []map[string]any{}
		for _, node := range creationMaps(doc["nodes"]) {
			if node["id"] != deleted.NodeID {
				nodes = append(nodes, node)
			}
		}
		doc["nodes"] = nodes
	})
	failPlanForAssetRecovery(t, s, runID)
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal(err)
	}
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	m, doc, rows := orderedPlanState(t, s, runID)
	var first model.ProductionAgentArtifact
	for _, row := range rows {
		if row.Key == "character" {
			first = row
		}
		if row.Key == "environment" && (row.NodeID != preserved.NodeID || row.ContentHash != preserved.ContentHash) {
			t.Fatal("unrelated saved asset changed")
		}
	}
	if first.NodeID == deleted.NodeID || m.Plan.Groups["character"] != groupID || !productionPlanArtifactValid(m, doc, rows, "character") {
		t.Fatal("asset regeneration did not reuse its live group with a new node")
	}
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	_, _, rows = orderedPlanState(t, s, runID)
	for _, row := range rows {
		if row.Key == "character" && row.NodeID != first.NodeID {
			t.Fatal("idempotent submit changed random node identity")
		}
	}
}

func TestProductionPlanExplicitGenerationRepairsMissingCollectionIndex(t *testing.T) {
	s, db, runID := readyPlanForAssetRecovery(t)
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	m, _, rows := orderedPlanState(t, s, runID)
	groupID := m.Plan.Groups["character"]
	var deleted model.ProductionAgentArtifact
	for _, row := range rows {
		if row.Key == "character" {
			deleted = row
		}
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		root := productionWorkflow(productionNode(doc, m.FrameID))
		delete(root["planGroups"].(map[string]any), "character")
		nodes := []map[string]any{}
		for _, node := range creationMaps(doc["nodes"]) {
			if node["id"] != deleted.NodeID {
				nodes = append(nodes, node)
			}
		}
		doc["nodes"] = nodes
	})
	failPlanForAssetRecovery(t, s, runID)
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal("explicit generation should repair a missing index for the intact group", err)
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	if m.Plan.Groups["character"] != groupID || productionWorkflow(productionNode(doc, m.FrameID))["planGroups"].(map[string]any)["character"] != groupID || productionPlanArtifactValid(m, doc, rows, "character") {
		t.Fatalf("recovery did not rebind the existing verified group: want=%s manifest=%s index=%v valid=%v", groupID, m.Plan.Groups["character"], productionWorkflow(productionNode(doc, m.FrameID))["planGroups"].(map[string]any)["character"], productionPlanArtifactValid(m, doc, rows, "character"))
	}
}

func TestProductionPlanExplicitGenerationReplacesEmptyChangedCollection(t *testing.T) {
	s, db, runID := readyPlanForAssetRecovery(t)
	m, _, _ := orderedPlanState(t, s, runID)
	oldGroupID := m.Plan.Groups["character"]
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		group := productionNode(doc, oldGroupID)
		productionWorkflow(group)["pipelineId"] = "repurposed-pipeline"
	})
	failPlanForAssetRecovery(t, s, runID)
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatal("explicit generation should replace an empty changed group", err)
	}
	if changed, err := s.ensureProductionPlanGroups("user", runID); err != nil || !changed {
		t.Fatal("missing character group was not recreated", changed, err)
	}
	m, doc, _ := orderedPlanState(t, s, runID)
	if m.Plan.Groups["character"] == oldGroupID || productionNode(doc, oldGroupID) == nil || productionNode(doc, m.Plan.Groups["character"]) == nil {
		t.Fatal("recovery must retain the old frame and bind a newly created group")
	}
}

func TestProductionPlanAssetGenerationRetiresChangedGroupAndPreservesChildren(t *testing.T) {
	s, db, runID := readyPlanForAssetRecovery(t)
	manifest, _, _ := orderedPlanState(t, s, runID)
	oldGroupID := manifest.Plan.Groups["character"]
	userNode := map[string]any{
		"id": "user-owned-child", "type": "text", "title": "用户保留内容", "parentId": oldGroupID,
		"width": 400, "height": 280, "position": map[string]any{"x": 40, "y": 400},
		"metadata": map[string]any{"content": "此节点不属于方案生成回执，应保留"},
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionWorkflow(productionNode(doc, oldGroupID))["pipelineId"] = "another-pipeline"
		doc["nodes"] = append(creationMaps(doc["nodes"]), userNode)
	})
	failPlanForAssetRecovery(t, s, runID)
	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanAssetKinds("user", runID, []string{"character"}, ProductionAssetModelSelection{}); err != nil {
		t.Fatalf("stale groups and unverified children must not block explicit asset generation: %v", err)
	}
	manifest, doc, _ := orderedPlanState(t, s, runID)
	if manifest.Plan.Groups["character"] != "" || productionNode(doc, oldGroupID) == nil || productionNode(doc, "user-owned-child") == nil {
		t.Fatal("recovery must detach the stale group binding while retaining its frame and child")
	}
	if productionNode(doc, "user-owned-child")["metadata"].(map[string]any)["content"] != userNode["metadata"].(map[string]any)["content"] {
		t.Fatal("recovery changed user-owned content")
	}
	if changed, err := s.ensureProductionPlanGroups("user", runID); err != nil || !changed {
		t.Fatalf("a fresh selected group should be created after recovery: changed=%v err=%v", changed, err)
	}
	manifest, doc, _ = orderedPlanState(t, s, runID)
	newGroupID := manifest.Plan.Groups["character"]
	if newGroupID == "" || newGroupID == oldGroupID || productionNode(doc, oldGroupID) == nil || productionNode(doc, "user-owned-child") == nil {
		t.Fatal("new generation group replaced or adopted the stale frame")
	}
}

func TestProductionPlanAssetGenerationDoesNotAdoptConflictingRootGroup(t *testing.T) {
	s, db, runID := readyPlanForAssetRecovery(t)
	manifest, _, _ := orderedPlanState(t, s, runID)
	oldGroupID := manifest.Plan.Groups["character"]
	conflictID := "user-existing-group"
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		root := productionNode(doc, manifest.FrameID)
		productionWorkflow(root)["planGroups"].(map[string]any)["character"] = conflictID
		doc["nodes"] = append(creationMaps(doc["nodes"]), map[string]any{
			"id": conflictID, "type": "frame", "title": "其他业务分组", "width": 800, "height": 600,
			"position": map[string]any{"x": 2000, "y": 0}, "metadata": map[string]any{"content": "保留"},
		})
	})
	failPlanForAssetRecovery(t, s, runID)
	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatalf("a conflicting root index must not block explicit asset generation: %v", err)
	}
	manifest, doc, _ := orderedPlanState(t, s, runID)
	if manifest.Plan.Groups["character"] != "" || productionNode(doc, oldGroupID) == nil || productionNode(doc, conflictID) == nil {
		t.Fatal("recovery adopted or removed a pre-existing group")
	}
	if changed, err := s.ensureProductionPlanGroups("user", runID); err != nil || !changed {
		t.Fatalf("selected category should receive a fresh group: changed=%v err=%v", changed, err)
	}
	manifest, doc, _ = orderedPlanState(t, s, runID)
	if id := manifest.Plan.Groups["character"]; id == "" || id == conflictID || productionWorkflow(productionNode(doc, manifest.FrameID))["planGroups"].(map[string]any)["character"] != id || productionNode(doc, conflictID) == nil {
		t.Fatal("fresh group was not bound without deleting the conflicting frame")
	}
}

func TestExplicitPropRetryRepairsOnlyUnsubmittedValidationCheckpoint(t *testing.T) {
	s, _, runID := readyPlanForAssetRecovery(t)
	run, state := productionRuntimeState(t, s, runID)
	manifest, doc, beforeArtifacts := orderedPlanState(t, s, runID)
	var characterWork productionParallelWork
	for _, candidate := range productionParallelReady(manifest, doc, beforeArtifacts) {
		if candidate.Key == "character" {
			characterWork = candidate
			break
		}
	}
	if characterWork.Key == "" {
		t.Fatal("fixture did not expose a character task")
	}
	if err := s.enqueueProductionParallel(run, &state, manifest, doc, beforeArtifacts, characterWork); err != nil {
		t.Fatal(err)
	}
	run, state = productionRuntimeState(t, s, runID)
	manifest.Plan.SelectedAssetKeys = []string{"environment"}
	if err := s.repo.UpdateProductionAgentManifest("user", runID, productionJSON(manifest)); err != nil {
		t.Fatal(err)
	}
	if state.ProductionParallel == nil {
		state.ProductionParallel = map[string]productionParallelWork{}
	}
	legacyTarget := "0208785dddf4a80011c8be1ccd641fbab7a3be607c5e401fa66424f02972b72f"
	state.ProductionParallel["prop"] = productionParallelWork{
		Key: "prop", Name: "测试prop", Error: productionUnsubmittedPropValidationFailure,
		QuietHold: true, Dependencies: "9c314fd4ae875f697ac3732a881aa9f344c5510b44b2232b88dcd76bf98a1c13", TargetHash: &legacyTarget,
		Notice: &model.TaskExecutionDiagnostic{
			Phase: "validation", ErrorSource: "application", Outcome: "needs_revision",
			TaskSubmitted: false, SafeMessage: productionUnsubmittedPropValidationFailure,
		},
	}
	if !productionStaleUnsubmittedPropFailure(manifest, beforeArtifacts, *productionPlanItem(manifest, "prop"), state.ProductionParallel["prop"]) {
		t.Fatal("legacy dependency and target hashes were not recognized as stale")
	}
	characterWork = state.ProductionParallel["character"]
	characterWork.Error = "已提交任务失败"
	characterWork.Notice = &model.TaskExecutionDiagnostic{Phase: "execution", ErrorSource: "upstream", TaskSubmitted: true}
	state.ProductionParallel["character"] = characterWork
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}

	progress := productionPlanAssetProgress(manifest, doc, beforeArtifacts, &state, nil, false)
	for _, item := range progress {
		if item.Key == "prop" && (item.Status == "failed" || item.Error != "") {
			t.Fatalf("unselected stale prop checkpoint was projected as a current failure: %+v", item)
		}
	}

	if err := s.prepareProductionPlanAssetGeneration("user", runID, []string{"prop"}); err != nil {
		t.Fatal(err)
	}
	_, repaired := productionRuntimeState(t, s, runID)
	if _, exists := repaired.ProductionParallel["prop"]; exists {
		t.Fatal("explicit retry did not clear the unsubmitted prop validation checkpoint")
	}
	if work := repaired.ProductionParallel["character"]; work.TaskID != characterWork.TaskID || work.Notice == nil || !work.Notice.TaskSubmitted {
		t.Fatalf("submitted task checkpoint was changed: %+v", work)
	}
	_, _, afterArtifacts := orderedPlanState(t, s, runID)
	if !reflect.DeepEqual(beforeArtifacts, afterArtifacts) {
		t.Fatal("checkpoint repair changed existing artifact receipts")
	}
	if err := s.prepareProductionPlanAssetGeneration("user", runID, []string{"prop"}); err != nil {
		t.Fatalf("repeating checkpoint repair should be idempotent: %v", err)
	}
}

func TestProductionPlanAssetGenerationRecoversGroupBeforeSettlingCompletedCall(t *testing.T) {
	s, db, runID := readyPlanForAssetRecovery(t)
	run, state := productionRuntimeState(t, s, runID)
	manifest, doc, rows := orderedPlanState(t, s, runID)
	var work productionParallelWork
	for _, candidate := range productionParallelReady(manifest, doc, rows) {
		if candidate.Key == "character" {
			work = candidate
			break
		}
	}
	if work.Key == "" {
		t.Fatal("character asset was not eligible for a generation call")
	}
	if err := s.enqueueProductionParallel(run, &state, manifest, doc, rows, work); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["character"]
	completedTaskID := work.TaskID
	completeParallel(t, db, work)
	manifest, _, _ = orderedPlanState(t, s, runID)
	oldGroupID := manifest.Plan.Groups["character"]
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		nodes := []map[string]any{}
		for _, node := range creationMaps(doc["nodes"]) {
			if node["id"] != oldGroupID {
				nodes = append(nodes, node)
			}
		}
		doc["nodes"] = nodes
	})
	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatalf("a completed response must settle after explicit group recovery: %v", err)
	}
	_, state = productionRuntimeState(t, s, runID)
	if state.ProductionParallel["character"].TaskID == completedTaskID {
		t.Fatal("the prior successful response was not settled before the retry batch")
	}
	manifest, doc, _ = orderedPlanState(t, s, runID)
	if productionNode(doc, oldGroupID) != nil || manifest.Plan.Groups["character"] != "" {
		t.Fatal("stale group was revived while settling the completed response")
	}
}

func TestProductionPlanAssetCandidatePreservesEditedAsset(t *testing.T) {
	s, db, runID := readyPlanForAssetRecovery(t)
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	_, _, rows := orderedPlanState(t, s, runID)
	var original model.ProductionAgentArtifact
	for _, row := range rows {
		if row.Key == "character" {
			original = row
		}
	}
	if original.NodeID == "" {
		t.Fatal("test fixture did not produce a character asset receipt")
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionNode(doc, original.NodeID)["metadata"].(map[string]any)["content"] = "人工修改的角色档案"
	})
	failPlanForAssetRecovery(t, s, runID)
	s.disablePiRuntime = true
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"character"}); err != nil {
		t.Fatalf("edited selected asset should start as a candidate version: %v", err)
	}
	manifest, doc, after := orderedPlanState(t, s, runID)
	if productionNode(doc, original.NodeID)["metadata"].(map[string]any)["content"] != "人工修改的角色档案" {
		t.Fatal("candidate start changed the manually edited asset")
	}
	if !slices.Contains(manifest.Plan.NewVersionAssetKeys, "character") {
		t.Fatalf("candidate version was not prepared: %v", manifest.Plan.NewVersionAssetKeys)
	}
	if len(after) != len(rows) {
		t.Fatal("candidate start replaced the existing artifact receipt before generation")
	}
	if !productionPlanArtifactValid(manifest, doc, after, "visual") {
		t.Fatal("unrelated plan standards became invalid")
	}
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	manifest, doc, after = orderedPlanState(t, s, runID)
	var candidateNodeID string
	for _, row := range after {
		if row.Key == "character" {
			candidateNodeID = row.NodeID
		}
	}
	if len(after) != len(rows) || candidateNodeID == "" || candidateNodeID == original.NodeID {
		t.Fatal("candidate generation did not replace the receipt with a new node")
	}
	if productionNode(doc, original.NodeID)["metadata"].(map[string]any)["content"] != "人工修改的角色档案" {
		t.Fatal("candidate generation overwrote the original asset")
	}
	if slices.Contains(manifest.Plan.NewVersionAssetKeys, "character") {
		t.Fatal("candidate authorization remained after the new receipt was saved")
	}
}

func TestProductionPlanRecoveryRetiresChangedCollectionAndPreservesVerifiedChildren(t *testing.T) {
	s, _, runID := readyPlanForAssetRecovery(t)
	submitOrderedPlan(t, s, runID, "character", "character", "测试character")
	run, state := productionRuntimeState(t, s, runID)
	m, doc, rows := orderedPlanState(t, s, runID)
	groupID := m.Plan.Groups["character"]
	group := productionNode(doc, groupID)
	productionWorkflow(group)["pipelineId"] = "stale-pipeline"
	policy, err := s.RuntimePolicy()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := productionResetMissingPlanAssets(s.repo, run, &state, m, doc, rows, policy); err != nil {
		t.Fatal("changed collection metadata should not block explicit recovery", err)
	}
	group = productionNode(doc, groupID)
	rootIndex := productionWorkflow(productionNode(doc, m.FrameID))["planGroups"].(map[string]any)
	if m.Plan.Groups["character"] != "" || rootIndex["character"] != nil || productionWorkflow(group)["pipelineId"] != "stale-pipeline" || group["id"] != groupID {
		t.Fatal("recovery must retire only the invalid binding and preserve the old group")
	}
	if productionNode(doc, rows[len(rows)-1].NodeID) == nil {
		t.Fatal("recovery removed an existing verified child asset")
	}
}

func TestProductionPlanAssetRecoveryRejectsChangedOrRetainedNodesAtomically(t *testing.T) {
	for _, change := range []string{"group_marker", "root_binding", "orphan", "edited_asset", "missing_standard", "missing_root", "unknown_key", "other_user", "missing_dependency"} {
		t.Run(change, func(t *testing.T) {
			s, db, runID := readyPlanForAssetRecovery(t)
			submitOrderedPlan(t, s, runID, "character", "character", "测试character")
			m, _, _ := orderedPlanState(t, s, runID)
			productionEditCanvas(t, s, db, func(doc map[string]any) {
				group := productionNode(doc, m.Plan.Groups["character"])
				switch change {
				case "group_marker":
					productionWorkflow(group)["pipelineId"] = "another-pipeline"
				case "root_binding":
					productionWorkflow(productionNode(doc, m.FrameID))["planGroups"].(map[string]any)["character"] = "another-group"
				case "orphan":
					group["id"] = "different-group"
				case "missing_root":
					productionNode(doc, m.FrameID)["id"] = "different-root"
				case "missing_dependency":
					nodes := []map[string]any{}
					for _, node := range creationMaps(doc["nodes"]) {
						if node["id"] != m.Plan.Groups["character"] && productionWorkflow(node)["assetKey"] != "character" {
							nodes = append(nodes, node)
						}
					}
					doc["nodes"] = nodes
				default:
					for _, node := range creationMaps(doc["nodes"]) {
						key := productionWorkflow(node)["assetKey"]
						if change == "edited_asset" && key == "character" {
							node["metadata"].(map[string]any)["content"] = "人工修改"
						}
						if change == "missing_standard" && key == "visual" {
							node["id"] = "different-standard"
						}
					}
				}
			})
			failPlanForAssetRecovery(t, s, runID)
			job, _ := s.repo.ProductionAgentJob("user", runID)
			canvas, _ := s.repo.CanvasProjectForUser("user", job.CanvasID)
			rows, _ := s.repo.ProductionAgentArtifacts("user", runID)
			keys, user := []string{"character"}, "user"
			if change == "unknown_key" {
				keys = []string{"unknown"}
			}
			if change == "other_user" {
				user = "another-user"
			}
			if change == "missing_dependency" {
				keys = []string{"sound"}
			}
			err := s.GenerateProductionPlanAssets(user, runID, keys)
			if change == "missing_standard" || change == "missing_dependency" {
				if err != nil {
					t.Fatalf("asset generation should not require other standards or dependency assets: %v", err)
				}
				return
			}
			if change == "group_marker" || change == "root_binding" || change == "orphan" || change == "edited_asset" {
				if err != nil {
					t.Fatalf("explicit asset generation should retire stale group pointers or create a candidate version: %v", err)
				}
				afterJob, _ := s.repo.ProductionAgentJob("user", runID)
				afterCanvas, _ := s.repo.CanvasProjectForUser("user", job.CanvasID)
				afterRows, _ := s.repo.ProductionAgentArtifacts("user", runID)
				if afterJob == nil || afterCanvas == nil || len(afterRows) < len(rows) {
					t.Fatal("recovery discarded the plan, canvas content, or existing asset history")
				}
				return
			}
			if err == nil {
				t.Fatal("invalid recovery accepted", change)
			}
			afterJob, _ := s.repo.ProductionAgentJob("user", runID)
			afterCanvas, _ := s.repo.CanvasProjectForUser("user", job.CanvasID)
			afterRows, _ := s.repo.ProductionAgentArtifacts("user", runID)
			if afterJob.ManifestJSON != job.ManifestJSON || afterCanvas.PayloadJSON != canvas.PayloadJSON || len(afterRows) != len(rows) {
				t.Fatal("rejected recovery partially changed saved state")
			}
		})
	}
}
