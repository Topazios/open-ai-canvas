package app

import (
	"fmt"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestProductionAssetSubjectRejectsCrossedDossierWithoutRejectingRelations(t *testing.T) {
	item := &productionPlanAsset{Name: "许慎言", Aliases: []string{"许先生"}, Identity: &productionAssetIdentity{Code: "CHR-D004-456"}}
	for _, facts := range []string{"人物编码：CHR-D004-451；姓名：裴归舟", "人物编码：CHR-D004-456；姓名：裴归舟", "**姓名**：裴归舟"} {
		if err := productionValidateAssetSubject(item, facts); err == nil {
			t.Fatalf("crossed subject accepted: %s", facts)
		}
	}
	for _, facts := range []string{"人物编码：CHR-D004-456；姓名：许慎言（青年阶段）", "姓名：许先生；关系人物裴归舟，关联人物编码CHR-D004-451", "亲属姓名：裴归舟；继承父亲的眼神，但不是父亲本人"} {
		if err := productionValidateAssetSubject(item, facts); err != nil {
			t.Fatal(err)
		}
	}
	facts := productionAssetSubjectFacts(item, "制作设计：官服用深灰色。")
	if productionAssetSubjectFacts(item, facts) != facts || !strings.Contains(facts, "CHR-D004-456") {
		t.Fatal("subject heading duplicated or omitted")
	}
}

func TestProductionAssetAdoptionDoesNotInvalidateAuthoredRevision(t *testing.T) {
	node := map[string]any{"title": "许慎言", "metadata": map[string]any{"content": "正文", "shortDrama": map[string]any{"assetAdopted": true, "assetSubjectValidated": "proof", "assetVersion": 1}}}
	hash := productionArtifactHash(node)
	productionWorkflow(node)["assetAdopted"] = false
	if !productionArtifactMatches(node, hash) {
		t.Fatal("adopting another document invalidated an unchanged revision")
	}
	node["metadata"].(map[string]any)["content"] = "正文已修改"
	if productionArtifactMatches(node, hash) {
		t.Fatal("content edit bypassed receipt validation")
	}
}

func TestProductionAssetRequestsAreDurableBoundedAndPayloadScoped(t *testing.T) {
	plan := &productionPlan{}
	selection := ProductionAssetModelSelection{RequestID: "request-1", Regenerate: true}
	productionRecordAssetRequest(plan, selection, []string{"b", "a"}, false)
	if seen, err := productionAssetRequestSeen(plan, selection, []string{"a", "b"}, false); !seen || err != nil {
		t.Fatal(seen, err)
	}
	if _, err := productionAssetRequestSeen(plan, selection, []string{"a"}, false); err == nil {
		t.Fatal("same token accepted a different scope")
	}
	for n := 0; n < 40; n++ {
		selection.RequestID = strings.Repeat("x", n+1)
		productionRecordAssetRequest(plan, selection, []string{"a"}, false)
	}
	if len(plan.AssetRequests) != 32 || len(plan.AssetRequestOrder) != 32 {
		t.Fatal("request ledger grew without bound")
	}
}

func TestProductionPlanningAliasesKeepRelationsAndUsageCanonical(t *testing.T) {
	bowl := planningTestAsset("prop", "饮水碗")
	bowl.Aliases = []string{"裴归舟饮水碗"}
	alias := planningTestAsset("prop", "裴归舟饮水碗")
	alias.PlannedRange = "第三单元"
	sound := planningTestAsset("sound", "饮水声")
	sound.SubjectKeys = []string{alias.Key}
	card := planningTestCard(1, alias.Key)
	card.NewAssets = []productionPlanningAsset{alias, sound}
	units := []model.ProductionFlowUnit{
		{Stage: "registry", Status: "accepted", ResultJSON: productionFlowJSON(map[string]any{"assets": []productionPlanningAsset{bowl}})},
		{Stage: "cards", Status: "accepted", ResultJSON: productionFlowJSON(map[string]any{"episodes": []productionPlanningCard{card}})},
	}
	plan, redirects, err := productionPlanningInventoryResolved(units, "source")
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Assets) != 2 || redirects[alias.Key] != bowl.Key || len(plan.Assets[0].Episodes) != 1 || len(plan.Assets[0].Usage) != 2 || plan.Assets[1].SubjectKeys[0] != bowl.Key {
		t.Fatal("duplicate identity, lost usage or unredirected source", plan)
	}
	if strings.Contains(plan.Assets[0].Purpose, "；") {
		t.Fatal("purpose was concatenated across occurrences")
	}
	other := planningTestAsset("prop", "另一只饮水碗")
	other.ParentKey = "different-room"
	other.Aliases = []string{bowl.Name}
	if _, merged := newProductionPlanningAssetIndex([]productionPlanningAsset{bowl}).match(other); merged {
		t.Fatal("different parent objects were merged")
	}
}

func TestProductionPlanningLinksRejectUnknownCyclesAndMisclassifiedStates(t *testing.T) {
	valid := []productionPlanAsset{{Key: "room", Kind: "environment", SubjectKeys: []string{"prop"}}, {Key: "prop", Kind: "prop", ParentKey: "room", SubjectKeys: []string{"room"}}}
	if err := productionValidatePlanningLinks(valid); err != nil {
		t.Fatal("bidirectional associations are allowed", err)
	}
	for _, assets := range [][]productionPlanAsset{
		{{Key: "room", ParentKey: "missing"}},
		{{Key: "a", ParentKey: "b"}, {Key: "b", ParentKey: "a"}},
		{{Key: "a", DependsOn: []string{"b"}}, {Key: "b", DependsOn: []string{"a"}}},
		{{Key: "a", Kind: "prop"}, {Key: "b", Kind: "character", BaseKey: "a", StateName: "成年"}},
		{{Key: "a", Quantity: -1}},
	} {
		if err := productionValidatePlanningLinks(assets); err == nil {
			t.Fatal("invalid link accepted", assets)
		}
	}
}

func TestProductionAssetSpecificationRejectsZeroAndNegativeDimensions(t *testing.T) {
	for _, kind := range []string{"character", "environment", "prop"} {
		field, find := "appearance", "173cm"
		if kind == "environment" {
			field, find = "layout", "8m"
		}
		if kind == "prop" {
			find = "12×8×6cm"
		}
		replacements := []string{"0cm", "-2cm"}
		if kind == "prop" {
			replacements = append(replacements, "0×8×6cm", "12×-8×6cm")
		}
		for _, replacement := range replacements {
			body := strings.Replace(productionAssetSpecificationFixture(kind), find, replacement, 1)
			if err := productionValidateAssetSpecification(kind, field, body); err == nil {
				t.Fatal("non-positive physical dimension accepted", kind, replacement)
			}
		}
	}
}

func TestProductionPlanningRejectsSameKeyDifferentPhysicalObject(t *testing.T) {
	a := planningTestAsset("prop", "饮水碗")
	b := a
	b.ParentKey = "another-room"
	units := []model.ProductionFlowUnit{
		{Stage: "registry", Status: "accepted", ResultJSON: productionFlowJSON(map[string]any{"assets": []productionPlanningAsset{a}})},
		{Stage: "registry", Status: "accepted", ResultJSON: productionFlowJSON(map[string]any{"assets": []productionPlanningAsset{b}})},
	}
	if _, err := productionPlanningInventory(units, "source"); err == nil || !strings.Contains(err.Error(), "同名资产") {
		t.Fatal("distinct physical objects silently merged", err)
	}
}

func TestProductionAssetLayoutKeepsAdoptedRevisionOnly(t *testing.T) {
	makeNode := func(id string, version int, adopted bool) map[string]any {
		return map[string]any{"id": id, "type": "text", "metadata": map[string]any{"shortDrama": map[string]any{
			"pipelineId": "p", "step": "character", "assetIdentity": map[string]any{"id": "person"}, "assetVersion": version, "assetAdopted": adopted,
		}}}
	}
	old, current := makeNode("old", 1, false), makeNode("current", 2, true)
	for _, nodes := range [][]map[string]any{{old, current}, {current, old}} {
		visible := productionCurrentAssetMembers(nodes)
		if len(visible) != 1 || visible[0]["id"] != "current" {
			t.Fatal("historical revision still occupies a grid slot", visible)
		}
	}
}

func TestProductionAssetRegenerationPreservesThreeRevisionsAndAdoptsOnlyLatest(t *testing.T) {
	s, runID := readyForAssetTasks(t)
	for version := 1; version <= 3; version++ {
		selection := ProductionAssetModelSelection{Regenerate: version > 1, RequestID: fmt.Sprintf("revision-%d", version)}
		if err := s.GenerateProductionPlanAssetKinds("user", runID, []string{"character"}, selection); err != nil {
			t.Fatal(err)
		}
		if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
			t.Fatal(err)
		}
		submitOrderedPlan(t, s, runID, "character", "character", "测试character")
		_, doc, rows := orderedPlanState(t, s, runID)
		adopted, documents := 0, 0
		for _, node := range creationMaps(doc["nodes"]) {
			data := productionWorkflow(node)
			if node["type"] != "text" || data["assetKey"] != "character" {
				continue
			}
			documents++
			if data["assetAdopted"] == true {
				adopted++
				if numberValue(data["assetVersion"], 0) != float64(version) {
					t.Fatal("revision number skipped or repeated", data)
				}
			}
		}
		if adopted != 1 || documents != version {
			t.Fatal("history lost or multiple adopted dossiers", adopted, documents)
		}
		for _, receipt := range rows {
			if !productionArtifactMatches(productionNode(doc, receipt.NodeID), receipt.ContentHash) {
				t.Fatal("adopting a revision broke an unchanged receipt", receipt.Key)
			}
		}
		productionCall(t, s, runID, "production_check", map[string]any{}, false)
		if err := s.completeCloudAgentPiRun("user", runID); err != nil {
			t.Fatal(err)
		}
	}
}
