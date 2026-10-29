package app

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestProductionPlanInventoryDocumentPreservesAllRegisteredFields(t *testing.T) {
	plan := productionPlan{Version: 3, StoryHash: "source-version", Assets: []productionPlanAsset{
		{Key: "lead", Kind: "character", Name: "人物甲", Purpose: "主角功能", Episodes: []int{3, 1}, Identity: &productionAssetIdentity{Code: "CHR-D002-001"}},
		{Key: "room", Kind: "environment", Name: "房间甲", Purpose: "主要空间", PlannedRange: "第一篇章"},
		{Key: "item", Kind: "prop", Name: "道具甲", Purpose: "触发行动", Episodes: []int{2}, PlannedRange: "第二阶段"},
		{Key: "voice", Kind: "sound", Name: "人物甲声音", Purpose: "声线复用", PlannedRange: "全剧", DependsOn: []string{"lead"}},
	}}
	content, err := productionRenderPlanInventory(plan)
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"已登记 4 项", "人物资产 1 项", "场景资产 1 项", "道具资产 1 项", "声音资产 1 项", "CHR-D002-001（人物甲）", "第1、3集", "第二阶段 | 第2集", "未细化到单集", "主角功能", "声线复用", "变体编码", "总纲中的所有资产"} {
		if !strings.Contains(content, text) {
			t.Errorf("registered content missing %q", text)
		}
	}
	if strings.Contains(content, "第1、2、3集") || strings.Contains(content, "| lead |") || plan.Assets[0].Episodes[0] != 3 {
		t.Fatal("rendering invented episodes, exposed dependency keys or mutated the registry")
	}
}

func TestProductionPlanInventoryDocumentSortsCategoriesAndStoryPriority(t *testing.T) {
	plan := productionPlan{Assets: []productionPlanAsset{
		{Key: "prop-2", Kind: "prop", Name: "线索证物", Priority: 2},
		{Key: "env-1", Kind: "environment", Name: "核心场景", Priority: 1},
		{Key: "char-2", Kind: "character", Name: "重要配角", Priority: 2},
		{Key: "char-1", Kind: "character", Name: "主角", Priority: 1},
		{Key: "prop-1", Kind: "prop", Name: "主线钥匙", Priority: 1},
	}}
	content, err := productionRenderPlanInventory(plan)
	if err != nil {
		t.Fatal(err)
	}
	ordered := []string{"主角", "重要配角", "核心场景", "主线钥匙", "线索证物"}
	last := -1
	for _, name := range ordered {
		position := strings.Index(content, name)
		if position <= last {
			t.Fatalf("inventory did not preserve category and priority order for %q: %s", name, content)
		}
		last = position
	}
	for _, rank := range []string{"| 主角 | 人物资产 | 1 |", "| 重要配角 | 人物资产 | 2 |", "| 主线钥匙 | 道具资产 | 1 |", "| 线索证物 | 道具资产 | 2 |"} {
		if !strings.Contains(content, rank) {
			t.Errorf("inventory omitted priority label %q", rank)
		}
	}
}

func TestProductionPlanInventoryDocumentDoesNotTruncateLargeRegistry(t *testing.T) {
	plan := productionPlan{Version: 2, Absent: map[string]string{"environment": "无独立场景", "prop": "无道具", "special": "无特殊资产", "sound": "无独立声音"}}
	for i := 1; i <= 140; i++ {
		plan.Assets = append(plan.Assets, productionPlanAsset{Key: fmt.Sprintf("lead-%d", i), Kind: "character", Name: fmt.Sprintf("角色%d", i), Purpose: strings.Repeat("独立剧情功能", 50), PlannedRange: "全剧"})
	}
	content, err := productionRenderPlanInventory(plan)
	if err != nil || utf8.RuneCountInString(content) <= productionPlanDocumentMaxRunes {
		t.Fatal("large registry should render completely without a model output cap", err)
	}
	if strings.Count(content, "| 人物资产 |") != 140 || !strings.Contains(content, "角色140") || !strings.Contains(content, "特殊资产：无特殊资产") {
		t.Fatal("inventory silently lost rows or absence declarations")
	}
}

func TestProductionPlanInventoryDocumentIsSavedWithCompleteProjection(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	m, doc, rows := orderedPlanState(t, s, runID)
	for _, row := range rows {
		if row.Key != "inventory" {
			continue
		}
		content := stringValue(productionNode(doc, row.NodeID)["metadata"].(map[string]any)["content"])
		var characterCode string
		for _, asset := range m.Plan.Assets {
			if asset.Kind == "character" && asset.Name == "测试character" && asset.Identity != nil {
				characterCode = asset.Identity.Code
				break
			}
		}
		if characterCode == "" || !strings.Contains(content, "已登记 5 项") || !strings.Contains(content, "第1集") || !strings.Contains(content, characterCode+"（测试character）") || !productionPlanArtifactValid(m, doc, rows, "inventory") {
			t.Fatal("saved inventory lost registered fields or its version receipt")
		}
		return
	}
	t.Fatal("inventory artifact missing")
}
