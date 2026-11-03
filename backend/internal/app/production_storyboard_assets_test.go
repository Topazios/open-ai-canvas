package app

import "testing"

func storyboardAssetTestNode(id, pipeline, code, name, kind string, episodes []any) map[string]any {
	data := map[string]any{
		"pipelineId": pipeline,
		"planAsset":  map[string]any{"name": name, "kind": kind, "episodes": episodes},
	}
	if code != "" {
		data["assetIdentity"] = map[string]any{"code": code, "kind": kind}
	}
	return map[string]any{"id": id, "metadata": map[string]any{"shortDrama": data}}
}

func storyboardAssetTestDoc() (productionManifest, map[string]any) {
	body := map[string]any{"id": "body", "metadata": map[string]any{"shortDrama": map[string]any{"pipelineId": "p1", "step": "story.body"}}}
	doc := map[string]any{"nodes": []any{
		body,
		storyboardAssetTestNode("a1", "p1", "CHR-001", "伟哥", "character", []any{float64(1), float64(2)}),
		storyboardAssetTestNode("a2", "p1", "SCN-001", "炒饭摊", "environment", []any{float64(1)}),
		storyboardAssetTestNode("a3", "p1", "SCN-002", "照相馆", "environment", []any{float64(2)}),
		storyboardAssetTestNode("a4", "p1", "", "未登记场景", "environment", nil),
		storyboardAssetTestNode("a5", "p1", "PRP-001", "旧账本", "prop", nil),
		storyboardAssetTestNode("a6", "other", "SCN-009", "别的项目", "environment", nil),
	}}
	m := productionManifest{Sources: []productionSource{{NodeID: "body", Step: "story.body", Episode: 1}}}
	return m, doc
}

func TestStoryboardAssetCatalogFiltersEpisodeAndPlaceholders(t *testing.T) {
	m, doc := storyboardAssetTestDoc()
	assets := storyboardAssetCatalog(m, doc)
	codes := []string{}
	for _, item := range assets {
		codes = append(codes, item["code"].(string))
	}
	want := []string{"SCN-001", "CHR-001", "PRP-001"}
	if len(codes) != len(want) {
		t.Fatalf("catalog codes = %v, want %v", codes, want)
	}
	for i := range want {
		if codes[i] != want[i] {
			t.Fatalf("catalog codes = %v, want %v", codes, want)
		}
	}
}

func TestStoryboardAttachAssetsInjectsCatalog(t *testing.T) {
	m, doc := storyboardAssetTestDoc()
	context := map[string]any{}
	storyboardAttachAssets(context, m, doc)
	if _, ok := context["availableAssets"].([]map[string]any); !ok || context["assetInstruction"] == "" {
		t.Fatalf("context missing asset catalog: %#v", context)
	}
	empty := map[string]any{}
	storyboardAttachAssets(empty, productionManifest{}, doc)
	if len(empty) != 0 {
		t.Fatalf("manifest without body source must not add fields: %#v", empty)
	}
}

func TestStoryboardSceneAssetCode(t *testing.T) {
	same := []productionShot{{AssetIDs: []string{"CHR-001"}}, {AssetIDs: []string{"SCN-001", "CHR-001"}}}
	if got := storyboardSceneAssetCode(same); got != "SCN-001" {
		t.Fatalf("scene code = %q", got)
	}
	mixed := []productionShot{{AssetIDs: []string{"SCN-001"}}, {AssetIDs: []string{"SCN-002"}}}
	if got := storyboardSceneAssetCode(mixed); got != "" {
		t.Fatalf("conflicting scene codes must not backfill, got %q", got)
	}
	if storyboardHasSceneCode([]string{"CHR-001"}) || !storyboardHasSceneCode([]string{"SCN-001"}) {
		t.Fatal("storyboardHasSceneCode mismatch")
	}
}