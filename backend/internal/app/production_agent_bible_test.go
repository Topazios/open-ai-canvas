package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/repository"
)

func TestProductionAgentNewBibleScopeIncludesEightSections(t *testing.T) {
	s, _, run := productionFixture(t)
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	productionWorkflow(productionNode(doc, "target"))["step"] = "assets.bible"
	encoded, _ := json.Marshal(doc)
	canvas.PayloadJSON = string(encoded)
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	manifest, err := productionSourceManifest(canvas, state.Request)
	if err != nil || len(manifest.BibleSections) != 8 {
		t.Fatal(manifest, err)
	}
}

func TestProductionAgentRestoreDeclaredBibleScopePreservesProgress(t *testing.T) {
	s, db, run := productionFixture(t)
	id := productionExtractFixture(t, s, run.ID)
	job, _ := s.repo.ProductionAgentJob("user", run.ID)
	var original productionManifest
	if err := json.Unmarshal([]byte(job.ManifestJSON), &original); err != nil {
		t.Fatal(err)
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		target := productionNode(doc, "target")
		productionWorkflow(target)["step"] = "assets.bible"
		original.Category, original.TargetHash = "bible", productionTargetHash(target)
		data := productionWorkflow(productionNode(doc, "group"))
		data["step"] = "assets.bible"
		data["assetGroup"].(map[string]any)["kind"] = "bible"
	})
	encoded, _ := json.Marshal(original)
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, string(encoded)); err != nil {
		t.Fatal(err)
	}
	ids := []string{id, strings.TrimSuffix(id, ":1") + ":2"}
	for _, key := range []string{"settings", "style"} {
		productionCall(t, s, run.ID, "production_submit", map[string]any{"key": key, "name": key, "document": productionTestDocument(), "factIds": ids}, false)
	}
	productionCall(t, s, run.ID, "production_query", map[string]any{}, false)
	if check := productionCall(t, s, run.ID, "production_check", map[string]any{}, false); check["valid"] != true {
		t.Fatal(check)
	}
	job, _ = s.repo.ProductionAgentJob("user", run.ID)
	if err := json.Unmarshal([]byte(job.ManifestJSON), &original); err != nil {
		t.Fatal(err)
	}
	artifacts, _ := s.repo.ProductionAgentArtifacts("user", run.ID)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		keys := []string{}
		for _, section := range productionBibleSections {
			keys = append(keys, section.Key)
		}
		productionWorkflow(productionNode(doc, "group"))["assetGroup"].(map[string]any)["sections"] = keys
	})
	before, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	restored, manifest, _, err := productionLoad(s.repo, execution, &state)
	if err != nil || restored.Validated || len(manifest.BibleSections) != 8 {
		t.Fatal(restored, manifest, err)
	}
	stored, _ := s.repo.ProductionAgentJob("user", run.ID)
	if stored.Validated || stored.ManifestJSON != restored.ManifestJSON {
		t.Fatal("scope and invalidated coverage must persist together", stored)
	}
	policy := productionScopedPolicy("Base rules", manifest)
	if !strings.Contains(policy, `"key":"generation"`) || productionScopedPolicy(policy, manifest) != policy {
		t.Fatal("restored scope absent from model policy or repeated on each call")
	}
	if strings.Contains(productionScopedPolicy("Base rules", original), `"key":"generation"`) {
		t.Fatal("legacy model policy expanded without a declared scope")
	}
	manifest.BibleSections = nil
	if !reflect.DeepEqual(manifest, original) {
		t.Fatal("scope recovery changed source/read/query progress", manifest, original)
	}
	after, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	afterArtifacts, _ := s.repo.ProductionAgentArtifacts("user", run.ID)
	if before.PayloadJSON != after.PayloadJSON || !reflect.DeepEqual(artifacts, afterArtifacts) {
		t.Fatal("recovery rewrote existing content or receipts")
	}
	check := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	missing := check["pendingWork"].(map[string]any)["missingBibleSections"].([]any)
	if check["valid"] != false || len(missing) != 6 {
		t.Fatal("two artifacts incorrectly complete eight-section scope", check)
	}
	for _, entry := range missing {
		section := entry.(map[string]any)
		productionCall(t, s, run.ID, "production_submit", map[string]any{"key": section["key"], "name": section["name"], "document": productionTestDocument(), "factIds": ids}, false)
	}
	if check := productionCall(t, s, run.ID, "production_check", map[string]any{}, false); check["valid"] != true {
		t.Fatal(check)
	}
	// A stale recovery must not overwrite progress saved by a newer operation.
	if err := s.repo.RestoreProductionAgentScope("user", run.ID, job.ManifestJSON, job.ManifestJSON); err != repository.ErrCreationConflict {
		t.Fatal("stale scope write accepted", err)
	}
}

func TestProductionAgentBibleScopeRecoveryBoundaries(t *testing.T) {
	for _, scenario := range []string{"legacy", "completed", "cancelled", "failed", "source-edited", "target-edited", "unknown-section", "duplicate-section", "wrong-container", "manual-artifact"} {
		t.Run(scenario, func(t *testing.T) {
			s, db, run := productionFixture(t)
			job, _ := s.repo.ProductionAgentJob("user", run.ID)
			var m productionManifest
			if err := json.Unmarshal([]byte(job.ManifestJSON), &m); err != nil {
				t.Fatal(err)
			}
			productionEditCanvas(t, s, db, func(doc map[string]any) {
				target := productionNode(doc, "target")
				productionWorkflow(target)["step"] = "assets.bible"
				m.Category, m.TargetHash = "bible", productionTargetHash(target)
				data := productionWorkflow(productionNode(doc, "group"))
				data["step"] = "assets.bible"
				group := data["assetGroup"].(map[string]any)
				group["kind"] = "bible"
				if scenario != "legacy" && scenario != "manual-artifact" {
					group["sections"] = []string{"settings", "style", "performance"}
				}
				switch scenario {
				case "source-edited":
					productionNode(doc, "body")["metadata"].(map[string]any)["content"] = "人工修改正文"
				case "target-edited":
					target["title"] = "人工修改目标"
				case "unknown-section":
					group["sections"] = []string{"settings", "style", "unknown"}
				case "duplicate-section":
					group["sections"] = []string{"settings", "style", "style"}
				case "wrong-container":
					group["manifestId"] = "another-target"
				}
			})
			encoded, _ := json.Marshal(m)
			if err := s.repo.UpdateProductionAgentManifest("user", run.ID, string(encoded)); err != nil {
				t.Fatal(err)
			}
			if scenario == "manual-artifact" {
				id := productionExtractFixture(t, s, run.ID)
				receipt := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "settings", "name": "settings", "document": productionTestDocument(), "factIds": []string{id}}, false)
				productionEditCanvas(t, s, db, func(doc map[string]any) {
					productionNode(doc, receipt["nodeId"].(string))["metadata"].(map[string]any)["content"] = "人工修改规范"
					productionWorkflow(productionNode(doc, "group"))["assetGroup"].(map[string]any)["sections"] = []string{"settings", "style", "performance"}
				})
				productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "settings", "name": "settings", "document": productionTestDocument(), "factIds": []string{id}}, true)
				return
			}
			execution, _ := s.repo.CloudAgent("user", run.ID)
			if scenario == "completed" || scenario == "cancelled" || scenario == "failed" {
				execution.Status = scenario
			}
			state, _ := cloudAgentDecode(execution)
			_, manifest, _, err := productionLoad(s.repo, execution, &state)
			wantError := scenario != "legacy" && scenario != "completed" && scenario != "cancelled" && scenario != "failed"
			if (err != nil) != wantError {
				t.Fatal("unexpected recovery result", manifest, err)
			}
			stored, _ := s.repo.ProductionAgentJob("user", run.ID)
			if scenario == "failed" {
				if len(manifest.BibleSections) != 3 {
					t.Fatal("failed job did not adopt declared scope", manifest)
				}
			} else if stored.ManifestJSON != string(encoded) {
				t.Fatal("legacy, terminal or invalid job was changed", stored.ManifestJSON)
			}
		})
	}
}

func TestProductionAgentEightBibleSectionsAndIncrementalCompletion(t *testing.T) {
	s, _, run := productionFixture(t)
	id := productionExtractFixture(t, s, run.ID)
	job, _ := s.repo.ProductionAgentJob("user", run.ID)
	var m productionManifest
	json.Unmarshal([]byte(job.ManifestJSON), &m)
	m.Category = "bible"
	for _, section := range productionBibleSections {
		m.BibleSections = append(m.BibleSections, section.Key)
	}
	encoded, _ := json.Marshal(m)
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, string(encoded)); err != nil {
		t.Fatal(err)
	}
	status := productionCall(t, s, run.ID, "production_status", map[string]any{}, false)
	if len(status["bibleSections"].([]any)) != 8 {
		t.Fatal(status)
	}
	for i, key := range []string{"settings", "style", "story_continuity", "art_direction", "cinematography", "performance", "sound", "generation"} {
		section, _ := productionBibleSectionFor(key)
		args := map[string]any{"key": key, "name": section.Name, "document": productionTestDocument(), "factIds": []string{id, strings.TrimSuffix(id, ":1") + ":2"}}
		receipt := productionCall(t, s, run.ID, "production_submit", args, false)
		if replay := productionCall(t, s, run.ID, "production_submit", args, false); replay["reused"] != true {
			t.Fatal(replay)
		}
		canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
		doc, _ := creationDocument(canvas.PayloadJSON)
		data := productionWorkflow(productionNode(doc, receipt["nodeId"].(string)))
		if data["bibleSection"] != key || data["step"] != section.Step {
			t.Fatal(data)
		}
		check := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
		if check["valid"] != (i == 7) {
			t.Fatal("premature completion or missing completion", check)
		}
		pending := check["pendingWork"].(map[string]any)["missingBibleSections"].([]any)
		if len(pending) != 7-i {
			t.Fatal("wrong remaining sections", pending)
		}
	}
	rows, _ := s.repo.ProductionAgentArtifacts("user", run.ID)
	if len(rows) != 8 {
		t.Fatal("duplicate or missing bible nodes", len(rows))
	}
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "unsupported", "name": "unsupported", "document": productionTestDocument(), "factIds": []string{id}}, true)
}
