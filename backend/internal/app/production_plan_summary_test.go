package app

import (
	"reflect"
	"testing"

	"gorm.io/gorm"
)

func completedCharacterPlanWithStaleSummary(t *testing.T, recorded bool) (*Service, *gorm.DB, string, string) {
	t.Helper()
	s, db, runID := parallelPlanFixture(t)
	s.disablePiRuntime = true
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	productionCall(t, s, runID, "production_check", map[string]any{}, false)
	if err := s.completeCloudAgentPiRun("user", runID); err != nil {
		t.Fatal(err)
	}
	_, doc, _ := orderedPlanState(t, s, runID)
	stale := stringValue(productionNode(doc, "target")["metadata"].(map[string]any)["content"])
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
	m, doc, _ := orderedPlanState(t, s, runID)
	want := stringValue(productionNode(doc, "target")["metadata"].(map[string]any)["content"])
	if want == stale || m.Plan.SummaryContent != want {
		t.Fatal("fixture did not save a distinct asset completion checkpoint")
	}
	if !recorded {
		m.Plan.SummaryContent = ""
		if err := s.repo.UpdateProductionAgentManifest("user", runID, productionJSON(m)); err != nil {
			t.Fatal(err)
		}
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionNode(doc, "target")["metadata"].(map[string]any)["content"] = stale
		productionWorkflow(productionNode(doc, m.FrameID))["planAssetsStarted"] = false
	})
	return s, db, runID, want
}

func TestProductionPlanSummaryRestoresCheckpointBeforeNextAssetKind(t *testing.T) {
	for _, recorded := range []bool{false, true} {
		for _, kind := range []string{"environment", "prop", "sound"} {
			name := kind
			if recorded {
				name += "_recorded"
			}
			t.Run(name, func(t *testing.T) {
				s, _, runID, want := completedCharacterPlanWithStaleSummary(t, recorded)
				run, state := productionRuntimeState(t, s, runID)
				if _, _, _, err := productionLoad(s.repo, run, &state); err == nil {
					t.Fatal("background loads must not silently accept stale progress")
				}
				before, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
				if _, _, _, err := productionLoad(s.repo, run, &state, productionLoadForAssetGeneration); err != nil {
					t.Fatal("read-only category selection rejected a provable system checkpoint", err)
				}
				after, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
				if before.PayloadJSON != after.PayloadJSON || before.Revision != after.Revision {
					t.Fatal("read-only checkpoint check wrote to the canvas")
				}
				if err := s.GenerateProductionPlanAssetKinds("user", runID, []string{kind}, ProductionAssetModelSelection{}); err != nil {
					t.Fatalf("next asset category was blocked: %v", err)
				}
				m, doc, rows := orderedPlanState(t, s, runID)
				target := productionNode(doc, "target")
				if target["metadata"].(map[string]any)["content"] != want || productionTargetHash(target) != m.Plan.SummaryHash {
					t.Fatal("start did not persist the exact original checkpoint")
				}
				if !reflect.DeepEqual(m.Plan.SelectedAssetKeys, []string{kind}) || !m.Plan.AssetsStarted || productionWorkflow(productionNode(doc, m.FrameID))["planAssetsStarted"] != true {
					t.Fatal("new selection or root progress was not restored", m.Plan.SelectedAssetKeys)
				}
				if len(rows) != 6 || !productionPlanArtifactValid(m, doc, rows, "character") {
					t.Fatal("checkpoint recovery changed completed characters or plan documents")
				}
				_, state = productionRuntimeState(t, s, runID)
				found := false
				for _, event := range state.Events {
					found = found || (event.Type == "canvas_updated" && event.Payload["operation"] == "production_summary_restore")
				}
				if !found {
					t.Fatal("checkpoint restore did not publish a canvas update")
				}
			})
		}
	}
}

func TestProductionPlanSummaryRejectsRealEdits(t *testing.T) {
	s, _, runID, _ := completedCharacterPlanWithStaleSummary(t, true)
	run, state := productionRuntimeState(t, s, runID)
	_, m, doc, err := productionLoad(s.repo, run, &state, productionLoadForAssetGeneration)
	if err != nil {
		t.Fatal(err)
	}
	baseline := productionJSON(doc)
	changes := map[string]func(map[string]any){
		"content":    func(n map[string]any) { n["metadata"].(map[string]any)["content"] = "保留我手动写的备注" },
		"title":      func(n map[string]any) { n["title"] = "手动改名" },
		"parent":     func(n map[string]any) { n["parentId"] = "another-frame" },
		"sources":    func(n map[string]any) { productionWorkflow(n)["sourceNodeIds"] = []string{"replacement"} },
		"signatures": func(n map[string]any) { productionWorkflow(n)["sourceSignatures"] = map[string]any{"topic": "changed"} },
		"parameters": func(n map[string]any) { productionWorkflow(n)["parameters"] = map[string]any{"episodeCount": 999} },
		"pipeline":   func(n map[string]any) { productionWorkflow(n)["pipelineId"] = "other-pipeline" },
		"run": func(n map[string]any) {
			productionWorkflow(n)["productionAgent"] = map[string]any{"runId": "other-run"}
		},
		"owner": func(n map[string]any) { productionWorkflow(n)["materializedTaskId"] = "other-run" },
		"asset": func(n map[string]any) { productionWorkflow(n)["assetOutput"] = true },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			copy, _ := creationDocument(baseline)
			target := productionNode(copy, "target")
			change(target)
			before := productionJSON(target)
			if _, ok := productionPlanSummaryCheckpoint(target, runID, m); ok {
				t.Fatal("manual edit was mistaken for system progress")
			}
			if productionJSON(target) != before {
				t.Fatal("failed checkpoint probe mutated the node")
			}
		})
	}
}

func TestProductionPlanSummaryDoesNotWriteWhenSourceChanged(t *testing.T) {
	s, db, runID, _ := completedCharacterPlanWithStaleSummary(t, true)
	run, state := productionRuntimeState(t, s, runID)
	_, m, _, err := productionLoad(s.repo, run, &state, productionLoadForAssetGeneration)
	if err != nil {
		t.Fatal(err)
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionNode(doc, m.Sources[0].NodeID)["metadata"].(map[string]any)["content"] = "修改后的选题"
	})
	before, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err := s.GenerateProductionPlanAssetKinds("user", runID, []string{"prop"}, ProductionAssetModelSelection{}); err == nil {
		t.Fatal("changed source was accepted during checkpoint recovery")
	}
	after, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	afterRun, _ := productionRuntimeState(t, s, runID)
	if after.PayloadJSON != before.PayloadJSON || after.Revision != before.Revision || afterRun.Revision != run.Revision {
		t.Fatal("rejected recovery partially changed the canvas or run")
	}
}
