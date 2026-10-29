package app

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestProductionUnifiedPlanRequiresSharedRulesAndAssignsStableCodes(t *testing.T) {
	s, _, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": orderedPlanDocument("story", ""), "factIds": []string{}}, false)
	input := productionPlan{StoryHash: story["hash"].(string), Complete: true, Assets: []productionPlanAsset{{Key: "hero", Name: "林岚", Kind: "character", Episodes: []int{1}, Purpose: "追查家族秘密的主角", PlannedRange: "第一篇章"}}, Absent: map[string]string{"environment": "没有独立空间", "prop": "没有道具", "special": "没有特效", "sound": "声音归属人物"}}
	invalid := input
	invalid.Assets = append(append([]productionPlanAsset{}, input.Assets...), input.Assets[0])
	productionCall(t, s, run.ID, "production_plan_inventory", invalid, true)
	first := productionCall(t, s, run.ID, "production_plan_inventory", input, false)
	retry := productionCall(t, s, run.ID, "production_plan_inventory", input, false)
	identity := first["registeredAssets"].([]any)[0].(map[string]any)["identity"].(map[string]any)
	if !productionAssetBaseCode.MatchString(stringValue(identity["code"])) || !strings.HasPrefix(stringValue(identity["code"]), "CHR-") || productionHash(first["registeredAssets"]) != productionHash(retry["registeredAssets"]) {
		t.Fatal(first, retry)
	}
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "hero", "name": "林岚", "document": orderedPlanDocument("hero", "character"), "factIds": []string{}}, true)
	check := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if check["valid"] != false || !strings.Contains(productionJSON(check), "前置制作规范") {
		t.Fatal(check)
	}
	for _, section := range unifiedPlanSections[1:3] {
		productionCall(t, s, run.ID, "production_submit", map[string]any{"key": section.Key, "name": section.Title, "document": orderedPlanDocument(section.Key, ""), "factIds": []string{}}, false)
	}
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "generation", "name": "生成与一致性规范", "document": orderedPlanDocument("generation", ""), "factIds": []string{}}, false)
	startPlanAssetsForTest(t, s, run.ID)
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "hero", "name": "林岚", "document": orderedPlanDocument("hero", "character"), "factIds": []string{}}, false)
	check = productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if check["valid"] != true {
		t.Fatal(check)
	}
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	if err := productionComplete(s.repo, execution, &state, defaultRuntimePolicy()); err != nil {
		t.Fatal(err)
	}
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	for _, artifact := range mustPlanArtifacts(t, s, run.ID) {
		data := productionWorkflow(productionNode(doc, artifact.NodeID))
		if artifact.Key == "hero" {
			if productionHash(data["assetIdentity"]) != productionHash(identity) || data["assetProfile"] == nil {
				t.Fatal(data)
			}
		} else if data["planSection"] != artifact.Key {
			t.Fatal(data)
		}
	}
	if productionWorkflow(productionNode(doc, "group"))["planAbsent"] == nil {
		t.Fatal("absence declarations missing")
	}
}

func productionJSON(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func TestProductionAssetCodesDoNotRecycleAndAreCanvasScoped(t *testing.T) {
	s, db, run := planFixture(t, 2)
	first, err := newProductionAssetIdentity(s.repo, "agent-canvas", "story", "character")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Where("run_id = ?", run.ID).Delete(&model.ProductionAgentJob{}).Error; err != nil {
		t.Fatal(err)
	}
	second, err := newProductionAssetIdentity(s.repo, "agent-canvas", "story", "character")
	if err != nil {
		t.Fatal(err)
	}
	other, err := newProductionAssetIdentity(s.repo, "other-canvas", "story", "character")
	if err != nil {
		t.Fatal(err)
	}
	if first.Code == second.Code || first.Code == other.Code || other.ID == first.ID || strings.Split(first.Code, "-")[1] != strings.Split(second.Code, "-")[1] || strings.Split(first.Code, "-")[1] == strings.Split(other.Code, "-")[1] {
		t.Fatal(first, second, other)
	}
}

func TestProductionReconcileReusesIdentityAndRequiresReadingOriginal(t *testing.T) {
	s, db, run := productionFixture(t)
	job, _ := s.repo.ProductionAgentJob("user", run.ID)
	var m productionManifest
	_ = json.Unmarshal([]byte(job.ManifestJSON), &m)
	m.Category = "reconcile"
	identity := &productionAssetIdentity{ID: "existing-hero", Code: "CHR-0099", Kind: "character"}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		doc["nodes"] = append(creationMaps(doc["nodes"]), map[string]any{"id": "planned-hero", "type": "text", "title": "林岚", "metadata": map[string]any{"content": "温和，低沉声线", "status": "success", "shortDrama": map[string]any{"step": "story.plan", "pipelineId": "story", "assetKey": "hero", "assetIdentity": identity}}})
	})
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	page := "planned-hero-page"
	if err := s.repo.EnsureProductionAgentPage(&model.ProductionAgentPage{ID: page, UserID: "user", CanvasID: "agent-canvas", Text: "温和，低沉声线", FactsJSON: "[]"}); err != nil {
		t.Fatal(err)
	}
	m.Sources = append(m.Sources, productionSource{NodeID: "planned-hero", Step: "story.plan", Title: "林岚", Version: productionNodeHash(productionNode(doc, "planned-hero")), AssetIdentity: identity, OnDemand: true, Pages: []string{page}})
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, productionJSON(m)); err != nil {
		t.Fatal(err)
	}
	factID := productionExtractFixture(t, s, run.ID)
	args := map[string]any{"key": identity.Code, "name": "林岚", "document": productionTestDocument(), "factIds": []string{factID}}
	productionCall(t, s, run.ID, "production_submit", args, true)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": page}, false)
	result := productionCall(t, s, run.ID, "production_submit", args, false)
	if productionStoredValueHash(result["identity"]) != productionStoredValueHash(identity) {
		t.Fatal(result)
	}
	check := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if check["valid"] != false || check["missingCount"] != float64(1) {
		t.Fatal(check)
	}
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "shop", "name": "照相馆", "document": productionTestDocument(), "factIds": []string{strings.TrimSuffix(factID, ":1") + ":2"}}, false)
	check = productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if check["valid"] != true {
		t.Fatal(check)
	}
	job, _ = s.repo.ProductionAgentJob("user", run.ID)
	_ = json.Unmarshal([]byte(job.ManifestJSON), &m)
	if m.Assets[identity.Code].ID != identity.ID || !strings.HasPrefix(m.Assets["shop"].Code, "SCN-") || !productionAssetBaseCode.MatchString(m.Assets["shop"].Code) {
		t.Fatal(m.Assets)
	}
}

func TestProductionStoryboardOmitsPlannedAssetsAndStoryWhileKeepingSharedRules(t *testing.T) {
	s, db, run := storyboardFixture(t)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		nodes := creationMaps(doc["nodes"])
		signatures := map[string]any{}
		for _, section := range []string{"story", "inventory", "visual", "direction", "generation", "hero"} {
			data := map[string]any{"step": "story.plan", "pipelineId": "story", "planVersion": 2, "planSection": section}
			if section == "hero" {
				data["planAsset"] = map[string]any{"kind": "character"}
			}
			nodes = append(nodes, map[string]any{"id": section, "type": "text", "title": section, "metadata": map[string]any{"content": "完整创作设计", "status": "success", "shortDrama": data}})
			signatures[section] = "declared"
		}
		doc["nodes"] = nodes
		productionWorkflow(productionNode(doc, "target"))["sourceSignatures"] = signatures
	})
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	m, err := productionSourceManifest(canvas, state.Request)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Sources) != 4 {
		t.Fatal(m.Sources)
	}
	for _, source := range m.Sources {
		if source.NodeID == "hero" || source.NodeID == "story" || source.NodeID == "inventory" {
			t.Fatal(source)
		}
	}
}
