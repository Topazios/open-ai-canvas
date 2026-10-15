package app

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func productionTestDocument() map[string]string {
	return map[string]string{
		"facts":          "第1集：林岚提着旧相机走进照相馆。",
		"design":         "设计建议：深色便装，保持固定发型；正文未给出外貌。",
		"variants":       "当前正文无额外服装状态。",
		"sound":          "设计建议：清亮中音区、自然语速、普通话；情绪克制，激动时保持声线。配音提示词：清晰、自然、克制，不夸张尖叫。",
		"prompt":         "人物参考，林岚持旧相机，深色便装，遵循项目统一表现风格。",
		"negativePrompt": "不改变身份，不增加道具，不改变相机外观。",
		"continuity":     "人物服装和旧相机在连续场次保持一致。",
		"uncertainties":  "外貌和声线为制作建议，正文没有明确规定。",
	}
}

func TestProductionAgentStructuredDocumentAndVoice(t *testing.T) {
	s, _, run := productionFixture(t)
	id := productionExtractFixture(t, s, run.ID)
	document := productionTestDocument()
	delete(document, "sound")
	args := map[string]any{"key": "林岚", "name": "林岚", "document": document, "factIds": []string{id}}
	bad := productionCall(t, s, run.ID, "production_submit", args, true)
	if bad["requiredAction"] != "fix_arguments" || !strings.Contains(stringValue(bad["error"]), "sound") {
		t.Fatal(bad)
	}
	artifacts, _ := s.repo.ProductionAgentArtifacts("user", run.ID)
	if len(artifacts) != 0 {
		t.Fatal("incomplete character saved as complete")
	}
	document["sound"] = productionTestDocument()["sound"]
	first := productionCall(t, s, run.ID, "production_submit", args, false)
	query := productionCall(t, s, run.ID, "production_query", map[string]any{"assetKey": "林岚"}, false)
	if query["expectedHash"] != first["hash"] || !strings.Contains(stringValue(query["content"]), "## 角色声音\n设计建议") {
		t.Fatal(query)
	}
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	profile := productionWorkflow(productionNode(doc, first["nodeId"].(string)))["assetProfile"].(map[string]any)
	if sounds := profile["sounds"].([]any); len(sounds) != 1 || sounds[0] != document["sound"] {
		t.Fatal(profile)
	}
	checked := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if checked["valid"] != true {
		t.Fatal(checked)
	}
}

func TestProductionAgentLegacyDraftReturnsSpecificRepair(t *testing.T) {
	s, db, run := productionFixture(t)
	id := productionExtractFixture(t, s, run.ID)
	receipt := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "林岚", "name": "林岚", "document": productionTestDocument(), "factIds": []string{id}}, false)
	var oldHash string
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		node := productionNode(doc, receipt["nodeId"].(string))
		node["metadata"].(map[string]any)["content"] = "正文事实：林岚回到照相馆。"
		oldHash = productionArtifactHash(node)
	})
	// Simulate a receipt saved by the old backend, not a manual edit.
	db.Model(&model.ProductionAgentArtifact{}).Where("run_id = ?", run.ID).Update("content_hash", oldHash)
	checked := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if checked["valid"] != false {
		t.Fatal("legacy prose passed quality check")
	}
	work := checked["pendingWork"].(map[string]any)
	repairs := work["repairArtifacts"].([]any)
	if len(repairs) != 1 || repairs[0].(map[string]any)["expectedHash"] != oldHash {
		t.Fatal(work)
	}
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "林岚", "name": "林岚", "document": productionTestDocument(), "factIds": []string{}, "expectedHash": oldHash}, false)
	if result := productionCall(t, s, run.ID, "production_check", map[string]any{}, false); result["valid"] != true {
		t.Fatal(result)
	}
}

func TestProductionAgentVoiceRevisionKeepsVariantsAndConflicts(t *testing.T) {
	s, _, run := productionFixture(t)
	id := productionExtractFixture(t, s, run.ID)
	document := productionTestDocument()
	args := map[string]any{
		"key": "林岚", "name": "林岚", "document": document, "factIds": []string{id},
		"design": map[string]any{"variants": []map[string]string{{"name": "便装", "description": "深色便装"}}, "conflicts": []string{"服装颜色为设计建议"}},
	}
	first := productionCall(t, s, run.ID, "production_submit", args, false)
	if replay := productionCall(t, s, run.ID, "production_submit", args, false); replay["reused"] != true {
		t.Fatal("unchanged variant write was not idempotent", replay)
	}
	document["sound"] += "保持句尾平稳。"
	productionCall(t, s, run.ID, "production_submit", map[string]any{
		"key": "林岚", "name": "林岚", "document": document, "factIds": []string{}, "expectedHash": first["hash"],
	}, false)
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	profile := productionWorkflow(productionNode(doc, first["nodeId"].(string)))["assetProfile"].(map[string]any)
	if len(profile["variants"].([]any)) != 1 || len(profile["conflicts"].([]any)) != 1 {
		t.Fatal("voice update erased existing design", profile)
	}
	if profile["sounds"].([]any)[0] != document["sound"] {
		t.Fatal("voice index not updated")
	}
}

func TestProductionAgentEarlyEndDoesNotHaveThreeAttemptLimit(t *testing.T) {
	s, _, run := productionFixture(t)
	for i := 0; i < 8; i++ {
		if err := s.productionAgentRepair("user", run.ID); err != nil {
			t.Fatal("premature end count failed a recoverable task", err)
		}
		call, err := s.productionRepairCall("user", run.ID, "test")
		if err != nil || call.Function.Name != "production_read" {
			t.Fatal(call, err)
		}
	}
}

func TestProductionAgentCheckSuppliesMissingFactsAfterAllQueried(t *testing.T) {
	s, _, run := productionFixture(t)
	id := productionExtractFixture(t, s, run.ID)
	productionCall(t, s, run.ID, "production_query", map[string]any{"kind": "character"}, false)
	checked := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	work := checked["pendingWork"].(map[string]any)
	facts := work["facts"].([]any)
	if len(facts) != 1 || facts[0].(map[string]any)["id"] != id {
		t.Fatal(work)
	}
}

func TestProductionAgentPolicyUpgradePreservesOtherSystemRules(t *testing.T) {
	updated := productionCurrentPolicy("Existing system rules\n本轮是制作长任务。只能使用 production_* 工具\nold policy")
	if !strings.HasPrefix(updated, "Existing system rules") || strings.Contains(updated, "old policy") || productionCurrentPolicy(updated) != updated {
		t.Fatal("policy upgrade duplicates or drops unrelated rules")
	}
}

func TestProductionAgentLegacyVariantHashDoesNotBypassManualEdits(t *testing.T) {
	node := map[string]any{"title": "林岚", "parentId": "group", "metadata": map[string]any{
		"content": "原始文稿", "shortDrama": map[string]any{"assetProfile": map[string]any{
			"variants": []productionDesignVariant{{Name: "便装", Description: "深色"}},
		}},
	}}
	meta := node["metadata"].(map[string]any)
	legacy := productionHash([]any{node["title"], node["parentId"], meta["content"], meta["shortDrama"]})
	encoded, _ := json.Marshal(node)
	var saved map[string]any
	json.Unmarshal(encoded, &saved)
	if !productionArtifactMatches(saved, legacy) {
		t.Fatal("unchanged legacy variant rejected")
	}
	saved["metadata"].(map[string]any)["content"] = "人工修改文稿"
	if productionArtifactMatches(saved, legacy) {
		t.Fatal("manual edit accepted")
	}
}

func TestProductionAgentBibleOnlyTwoDocumentsCoverAllFacts(t *testing.T) {
	s, _, run := productionFixture(t)
	id := productionExtractFixture(t, s, run.ID)
	job, _ := s.repo.ProductionAgentJob("user", run.ID)
	var manifest productionManifest
	json.Unmarshal([]byte(job.ManifestJSON), &manifest)
	manifest.Category = "bible"
	encoded, _ := json.Marshal(manifest)
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, string(encoded)); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"settings", "style"} {
		productionCall(t, s, run.ID, "production_submit", map[string]any{"key": key, "name": key, "document": productionTestDocument(), "factIds": []string{id, strings.TrimSuffix(id, ":1") + ":2"}}, false)
	}
	checked := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if checked["valid"] != true || checked["artifactCount"] != float64(2) {
		t.Fatal(checked)
	}
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "extra", "name": "extra", "document": productionTestDocument(), "factIds": []string{id}}, true)
	// No user confirmation field is read at completion.
	execution, _ := s.repo.CloudAgent("user", run.ID)
	err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, _ := cloudAgentDecode(current)
		state.PiAssistantResponses = 1
		return cloudAgentSave(current, &state)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.completeCloudAgentPiRun("user", run.ID); err != nil {
		t.Fatal(err)
	}
}
