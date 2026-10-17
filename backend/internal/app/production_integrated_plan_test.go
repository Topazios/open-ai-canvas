package app

import (
	"strings"
	"testing"
)

func TestProductionIntegratedPlanCompletesWithoutSpecial(t *testing.T) {
	s, _, run := planFixture(t, 3)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := submitOrderedPlan(t, s, run.ID, "story", "", "故事总纲")
	input := productionPlan{StoryHash: stringValue(story["hash"]), Complete: true,
		Assets: []productionPlanAsset{{Key: "hero", Kind: "character", Name: "林岚", Purpose: "主角", PlannedRange: "全剧"}},
		Absent: map[string]string{"environment": "无独立场景", "prop": "无独立道具", "sound": "无独立复用音效"}}
	invalid := input
	invalid.Assets = []productionPlanAsset{{Key: "effect", Kind: "special", Name: "效果", Purpose: "变化", PlannedRange: "全剧"}}
	productionCall(t, s, run.ID, "production_plan_inventory", invalid, true)
	productionCall(t, s, run.ID, "production_plan_inventory", input, false)
	for _, section := range unifiedPlanSections[1:3] {
		submitOrderedPlan(t, s, run.ID, section.Key, "", section.Title)
	}
	submitOrderedPlan(t, s, run.ID, "hero", "character", "林岚")
	submitOrderedPlan(t, s, run.ID, "generation", "", "生成规范")
	check := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if check["valid"] != true {
		t.Fatal(check)
	}
	m, doc, rows := orderedPlanState(t, s, run.ID)
	if m.Plan.Version != 3 || len(m.Plan.Assets) != 1 {
		t.Fatal(m.Plan)
	}
	for _, a := range rows {
		if productionWorkflow(productionNode(doc, a.NodeID))["planVersion"] != float64(3) {
			t.Fatal("version lost", a.Key)
		}
	}
	policy := productionScopedPolicy("", m)
	if strings.Contains(policy, "五类") || strings.Contains(policy, "PRP/SPC") {
		t.Fatal("legacy inventory policy leaked")
	}
	for _, tool := range productionRuntimeTools(m, map[string]any{}) {
		fn := tool["function"].(map[string]any)
		if fn["name"] == "production_plan_inventory" {
			if strings.Contains(productionJSON(fn["parameters"]), `"special"`) {
				t.Fatal("special still offered")
			}
		}
	}
}

func TestProductionIntegratedEffectsPreservesHistoricalReferencesAndHeadings(t *testing.T) {
	content, err := productionRenderPlanDocument("visual", "", orderedPlanDocument("visual", ""))
	if err != nil {
		t.Fatal(err)
	}
	old := strings.Replace(content, "## 状态变化与效果表现规范", "## 特殊资产形态与特效规范", 1)
	if missing := productionPlanDocumentMissing("visual", "", old); len(missing) != 0 {
		t.Fatal(missing)
	}
	item := productionPlanAsset{Key: "transition", Kind: "special", GroupKind: "environment", Identity: &productionAssetIdentity{ID: "legacy", Kind: "special", Code: "SPC-0001"}}
	m := productionManifest{FrameID: "root", Plan: &productionPlan{Version: 2, Assets: []productionPlanAsset{item}, Groups: map[string]string{"environment": "scenes"}}}
	if productionPlanParent(m, item.Key) != "scenes" {
		t.Fatal("legacy state did not join scene group")
	}
	if err := productionValidatePlanReferences(m, nil, nil, "沿用 @SPC-0001 的状态"); err != nil {
		t.Fatal(err)
	}
	if err := productionValidatePlanReferences(m, nil, nil, "不得伪造 @SPC-0002"); err == nil {
		t.Fatal("unknown reference accepted")
	}
}

func TestProductionIntegratedExecutionRequirementsReachSubmit(t *testing.T) {
	for key, fields := range productionPlanExecutionRequirements {
		tools := productionRuntimeTools(productionManifest{Plan: &productionPlan{Version: 3}}, map[string]any{"nextAction": map[string]any{"key": key}})
		for _, tool := range tools {
			fn := tool["function"].(map[string]any)
			if fn["name"] != "production_submit" {
				continue
			}
			schema := fn["parameters"].(map[string]any)["properties"].(map[string]any)["document"].(map[string]any)["properties"].(map[string]any)
			for field, requirement := range fields {
				if !strings.Contains(schema[field].(map[string]any)["description"].(string), requirement) {
					t.Fatal(key, field)
				}
			}
		}
	}
}
