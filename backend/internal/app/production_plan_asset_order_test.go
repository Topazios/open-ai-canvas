package app

import (
	"reflect"
	"testing"
)

func TestProductionPlanAssetLayoutUsesImportanceAndAdjacentVersions(t *testing.T) {
	m := productionManifest{FrameID: "root", Plan: &productionPlan{
		Groups: map[string]string{"character": "characters"},
		Assets: []productionPlanAsset{
			{Key: "support", Kind: "character", Priority: 2, Identity: &productionAssetIdentity{Code: "CHR-D001-001"}},
			{Key: "hero", Kind: "character", Priority: 1, Identity: &productionAssetIdentity{Code: "CHR-D001-099"}},
		},
	}}
	frame := map[string]any{"id": "characters", "position": map[string]any{"x": 0, "y": 0}}
	node := func(id, key string, version int) map[string]any {
		return map[string]any{"id": id, "parentId": "characters", "metadata": map[string]any{"shortDrama": map[string]any{"assetKey": key, "assetVersion": version}}}
	}
	support, hero2, unknown, hero1 := node("s", "support", 1), node("h2", "hero", 2), node("u", "unknown", 1), node("h1", "hero", 1)
	nodes := []map[string]any{frame, support, hero2, unknown, hero1}
	productionLayoutPlanGroup(m, frame, nodes)
	for index, item := range []map[string]any{hero1, hero2, support, unknown} {
		position := item["position"].(map[string]any)
		if numberValue(position["x"], 0) != 24+float64(index%3)*424 || numberValue(position["y"], 0) != 100+float64(index/3)*productionPlanRowPitch {
			t.Fatalf("wrong importance/version position: %v", item)
		}
	}
	order := frame["metadata"].(map[string]any)["frame"].(map[string]any)["assetOrder"]
	if !reflect.DeepEqual(order, []string{"hero", "support"}) || m.Plan.Assets[0].Key != "support" {
		t.Fatal("catalog presentation checkpoint missing or manifest mutated", order)
	}
}
