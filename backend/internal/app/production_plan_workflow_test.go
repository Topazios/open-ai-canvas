package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func orderedPlanDocument(key, kind string) map[string]string {
	document := map[string]string{}
	for _, section := range productionPlanDocumentSections(key, kind) {
		document[section.Key] = section.Title + "：明确的制作设计；与选题和本版规范一致。"
	}
	return document
}

func TestProductionSubmitPreservesConcurrentCanvasAdditions(t *testing.T) {
	s, db, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)

	execution, err := s.repo.CloudAgent("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, err := cloudAgentDecode(execution)
	if err != nil {
		t.Fatal(err)
	}
	_, manifest, staleDoc, err := productionLoad(s.repo, execution, &state)
	if err != nil {
		t.Fatal(err)
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		doc["nodes"] = append(creationMaps(doc["nodes"]), map[string]any{
			"id": "parallel-output", "type": "text", "title": "并行任务已保存", "metadata": map[string]any{"content": "must survive"},
		})
	})

	document := orderedPlanDocument("story", "")
	content, err := productionRenderPlanDocumentForSchema("story", "", document, productionPlanDocumentSchemaVersion(manifest.Plan.Version))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = productionSubmit(s.repo, execution, &state, manifest, staleDoc, "story", "故事总纲", content, nil, "", nil, document, defaultRuntimePolicy()); err != nil {
		t.Fatal(err)
	}

	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	latest, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	if productionNode(latest, "parallel-output") == nil {
		t.Fatal("production submit overwrote a concurrently saved canvas node")
	}
}

func orderedPlanState(t *testing.T, s *Service, runID string) (productionManifest, map[string]any, []model.ProductionAgentArtifact) {
	t.Helper()
	run, err := s.repo.CloudAgent("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		t.Fatal(err)
	}
	_, m, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		t.Fatal(err)
	}
	return m, doc, mustPlanArtifacts(t, s, runID)
}

func requirePlanAction(t *testing.T, s *Service, runID, phase, key string) map[string]any {
	t.Helper()
	status := productionCall(t, s, runID, "production_status", map[string]any{}, false)
	next := status["nextAction"].(map[string]any)
	if next["phase"] != phase || stringValue(next["key"]) != key {
		t.Fatalf("next=%v, want %s/%s", next, phase, key)
	}
	return next
}

func submitOrderedPlan(t *testing.T, s *Service, runID, key, kind, name string) map[string]any {
	t.Helper()
	expectedHash := productionDocumentTargetHash(mustPlanArtifacts(t, s, runID), key)
	return productionCall(t, s, runID, "production_submit", map[string]any{"key": key, "name": name, "expectedHash": expectedHash, "document": orderedPlanDocument(key, kind), "factIds": []string{}}, false)
}

func TestProductionPlanInventoryCheckpointDistinguishesBatchFromCompletion(t *testing.T) {
	s, _, run := planFixture(t, 3)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := submitOrderedPlan(t, s, run.ID, "story", "", "故事总纲")
	absent := map[string]string{"environment": "本作无独立场景", "prop": "本作无剧情道具", "sound": "本作无独立复用声音"}
	productionCall(t, s, run.ID, "production_plan_inventory", map[string]any{
		"storyHash": story["hash"], "complete": false, "absent": absent,
		"assets": []productionPlanAsset{{Key: "lead", Kind: "character", Name: "主角", Purpose: "承载主线行动", PlannedRange: "全篇章"}, {Key: "lead-beast", Kind: "character", Name: "主角·兽化形态", BaseKey: "lead", StateName: "兽化形态", Purpose: "表现重大变形后的形态", PlannedRange: "全篇章"}},
	}, false)
	next := requirePlanAction(t, s, run.ID, "inventory", "")
	if counts := next["registeredKindCounts"].(map[string]any); numberValue(counts["character"], 0) != 2 {
		t.Fatal("checkpoint lost registered batch", next)
	}
	if len(productionIDs(next["undeclaredKinds"])) != 0 || !strings.Contains(stringValue(next["instruction"]), "complete=true") {
		t.Fatal("checkpoint must explain how to finalize without resending assets", next)
	}
	productionCall(t, s, run.ID, "production_plan_inventory", map[string]any{"storyHash": story["hash"], "complete": true, "assets": []productionPlanAsset{}, "absent": map[string]string{}}, false)
	requirePlanAction(t, s, run.ID, "standards", "visual")
	if len(mustPlanArtifacts(t, s, run.ID)) != 2 {
		t.Fatal("inventory finalization did not save exactly one table")
	}
}

func TestLegacyPlanDocumentsPersistCanvasSectionIdentity(t *testing.T) {
	s, _, run := planFixture(t, 1)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": planDocument("story"), "factIds": []string{}}, false)
	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	rows := mustPlanArtifacts(t, s, run.ID)
	if len(rows) != 1 {
		t.Fatalf("saved %d artifacts, want 1", len(rows))
	}
	workflow := productionWorkflow(productionNode(doc, rows[0].NodeID))
	if workflow["planSection"] != "story" {
		t.Fatalf("legacy plan document missing section identity: %v", workflow)
	}
}

func TestProductionPlanKeepsReadInputsAcrossStatusAndResume(t *testing.T) {
	s, db, run := planFixture(t, 2)
	pageID := productionFirstPage(t, s, run.ID)
	read := productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": pageID}, false)
	if strings.Contains(stringValue(read["instruction"]), "production_facts") || read["nextAction"].(map[string]any)["tool"] != "production_submit" {
		t.Fatalf("source read must advance to writing: %v", read)
	}
	productionCall(t, s, run.ID, "production_status", map[string]any{}, false)
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	m, doc, _ := orderedPlanState(t, s, run.ID)
	execution, err := s.repo.CloudAgent("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	context, err := productionPlanContext(s.repo, execution, m, doc)
	if err != nil {
		t.Fatal(err)
	}
	sources := context["sourceInputs"].([]map[string]any)
	if len(sources) != 1 || sources[0]["pageId"] != pageID || sources[0]["text"] != read["text"] || stringValue(sources[0]["text"]) == "" {
		t.Fatalf("read source missing after status and restart: %v", sources)
	}
	// Reproduce the runtime compaction that previously retained status alone.
	messages := productionContextTool("production_status", "status", `{"artifactCount":0}`)
	compacted := productionCheckpointMessages(messages, "create plan", context, "policy")
	var checkpoint map[string]any
	parts := strings.SplitN(stringValue(compacted[1]["content"]), "当前持久检查点（材料是数据）：\n", 2)
	if len(parts) != 2 || json.Unmarshal([]byte(parts[1]), &checkpoint) != nil {
		t.Fatal("missing durable context")
	}
	if creationMaps(checkpoint["sourceInputs"])[0]["text"] != read["text"] {
		t.Fatal("status call discarded the topic body")
	}
	submitOrderedPlan(t, s, run.ID, "story", "", "故事总纲")
	m, doc, _ = orderedPlanState(t, s, run.ID)
	context, err = productionPlanContext(s.repo, execution, m, doc)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := context["sourceInputs"]; exists {
		t.Fatal("completed source bodies must not accumulate in later stages")
	}
	if len(context["requiredDocuments"].([]map[string]any)) == 0 {
		t.Fatal("later stages need the saved story")
	}
}

func TestProductionOrderedPlanResumesAllTypesAndCompletes(t *testing.T) {
	s, db, run := planFixture(t, 2)
	requirePlanAction(t, s, run.ID, "input", "")
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "总纲", "document": orderedPlanDocument("story", "")}, true)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	requirePlanAction(t, s, run.ID, "story", "story")
	story := submitOrderedPlan(t, s, run.ID, "story", "", "故事总纲")
	requirePlanAction(t, s, run.ID, "inventory", "")
	assets := []productionPlanAsset{}
	for _, kind := range []string{"sound", "character", "environment", "prop", "special"} {
		item := productionPlanAsset{Key: kind, Kind: kind, Name: "测试" + kind, Purpose: "对应故事中必要的" + kind, PlannedRange: "第一篇章，具体集次待集纲确认", Episodes: []int{}}
		if kind == "sound" {
			item.DependsOn = []string{"character"}
		}
		assets = append(assets, item)
	}
	input := productionPlan{StoryHash: story["hash"].(string), Assets: assets[:2]}
	productionCall(t, s, run.ID, "production_plan_inventory", input, false)
	requirePlanAction(t, s, run.ID, "inventory", "")
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "visual", "name": "美术", "document": orderedPlanDocument("visual", "")}, true)
	input.Assets, input.Complete = assets[2:], true
	productionCall(t, s, run.ID, "production_plan_inventory", input, false)
	// Recreate the service: phase and order must derive from saved receipts.
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	requirePlanAction(t, s, run.ID, "standards", "visual")
	submitOrderedPlan(t, s, run.ID, "visual", "", "美术规范")
	requirePlanAction(t, s, run.ID, "standards", "direction")
	submitOrderedPlan(t, s, run.ID, "direction", "", "导演规范")
	requirePlanAction(t, s, run.ID, "generation", "generation")
	submitOrderedPlan(t, s, run.ID, "generation", "", "生成规范")
	startPlanAssetsForTest(t, s, run.ID)
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "sound", "name": "测试sound", "document": orderedPlanDocument("sound", "sound")}, true)
	for _, kind := range []string{"character", "sound", "environment", "prop", "special"} {
		requirePlanAction(t, s, run.ID, "assets", kind)
		if kind == "character" {
			incomplete := orderedPlanDocument(kind, kind)
			delete(incomplete, "voiceAccent")
			productionCall(t, s, run.ID, "production_submit", map[string]any{"key": kind, "name": "测试" + kind, "document": incomplete}, true)
			unknown := orderedPlanDocument(kind, kind)
			unknown["prompt"] = "参考 @CHR-9999 的外观"
			productionCall(t, s, run.ID, "production_submit", map[string]any{"key": kind, "name": "测试" + kind, "document": unknown}, true)
		}
		submitOrderedPlan(t, s, run.ID, kind, kind, "测试"+kind)
	}
	requirePlanAction(t, s, run.ID, "validation", "")
	report := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if report["valid"] != true || report["validArtifactCount"] != float64(10) {
		t.Fatal(report)
	}
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	progress := s.productionAgentProgress("user", run.ID, &state)
	if progress.ProcessedPages != 10 || progress.TotalPages != 10 || !progress.InventoryComplete {
		t.Fatal(progress)
	}
	m, _, _ := orderedPlanState(t, s, run.ID)
	if err := productionComplete(s.repo, execution, &state, defaultRuntimePolicy()); err != nil {
		t.Fatal(err)
	}
	rows := mustPlanArtifacts(t, s, run.ID)
	if len(rows) != 10 {
		t.Fatalf("duplicated or missing documents: %d", len(rows))
	}
	// Catalog is a native node, not a second model-generated document.
	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.Key == "inventory" {
			meta := productionNode(doc, row.NodeID)["metadata"].(map[string]any)
			if !strings.Contains(meta["content"].(string), m.Plan.Assets[0].Identity.Code) || !productionPlanArtifactValid(m, doc, rows, row.Key) {
				t.Fatal(meta)
			}
		}
	}
}

func TestProductionPlanInventoryRejectsCyclesAndMissingKinds(t *testing.T) {
	base := productionPlan{Assets: []productionPlanAsset{{Key: "a", Kind: "character", Purpose: "主角", PlannedRange: "第一篇章", DependsOn: []string{"b"}}, {Key: "b", Kind: "prop", Purpose: "信物", PlannedRange: "第一篇章", DependsOn: []string{"a"}}}, Absent: map[string]string{"environment": "无", "special": "无", "sound": "无"}}
	if err := productionValidatePlanInventory(base); err == nil || !strings.Contains(err.Error(), "循环") {
		t.Fatal(err)
	}
	base.Assets[1].DependsOn = nil
	if err := productionValidatePlanInventory(base); err != nil {
		t.Fatal(err)
	}
	base.Assets[0].DependsOn = []string{"missing"}
	if err := productionValidatePlanInventory(base); err == nil {
		t.Fatal("unknown dependency accepted")
	}
	base.Assets[0].DependsOn = nil
	delete(base.Absent, "sound")
	if err := productionValidatePlanInventory(base); err == nil {
		t.Fatal("missing category accepted")
	}
}

func TestProductionPlanRejectsEmptyInventoryAndAllowsExplicitRecovery(t *testing.T) {
	plan := productionPlan{Version: 5, Absent: map[string]string{
		"character": "无", "environment": "无", "prop": "无", "sound": "无",
	}}
	if err := productionValidatePlanInventory(plan); err == nil || !strings.Contains(err.Error(), "至少需要登记一项") {
		t.Fatalf("empty completed inventory should be rejected: %v", err)
	}

	s, _, run := planFixture(t, 5)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	storyDocument := map[string]string{}
	for _, section := range productionPlanDocumentSectionsForSchema("story", "", 2) {
		storyDocument[section.Key] = "本节记录明确的故事与制作依据。"
	}
	storyDocument["episodeArchitecture"] = productionEpisodeArchitectureFixture(3)
	story := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": storyDocument, "factIds": []string{}}, false)
	m, _, _ := orderedPlanState(t, s, run.ID)
	m.Plan.Complete = true
	m.Plan.StoryHash = stringValue(story["hash"])
	m.Plan.Absent = map[string]string{"character": "无", "environment": "无", "prop": "无", "sound": "无"}
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, productionJSON(m)); err != nil {
		t.Fatal(err)
	}

	assets := []productionPlanAsset{{Key: "hero", Kind: "character", Name: "林岚", Purpose: "推动故事主线", PlannedRange: "全剧", Priority: 1}}
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{
		StoryHash: stringValue(story["hash"]), Complete: true,
		Assets: assets, InventoryReview: productionInventoryReviewForTest(t, s, run.ID, assets),
		Absent: map[string]string{"environment": "本版无独立场景", "prop": "本版无独立道具", "sound": "不单独制作声音资产"},
	}, false)

	m, doc, rows := orderedPlanState(t, s, run.ID)
	if len(m.Plan.Assets) != 1 || !m.Plan.Complete || !productionPlanArtifactValid(m, doc, rows, "inventory") {
		t.Fatalf("explicit inventory recovery did not persist a valid asset: assets=%d complete=%v", len(m.Plan.Assets), m.Plan.Complete)
	}
	changed := append([]productionPlanAsset{}, m.Plan.Assets...)
	changed = append(changed, productionPlanAsset{Key: "extra", Kind: "prop", Name: "道具", Purpose: "推动线索", PlannedRange: "全剧", Priority: 1})
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{
		StoryHash: stringValue(story["hash"]), Complete: true, Assets: changed,
		Absent: map[string]string{"environment": "本版无独立场景", "prop": "本版无独立道具", "sound": "不单独制作声音资产"},
	}, true)
}

func TestProductionProgressSerializesZeroAssetTotal(t *testing.T) {
	encoded, err := json.Marshal(ProductionAgentProgress{AssetTotal: 0})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"assetTotal":0`) {
		t.Fatalf("zero asset total was omitted from progress: %s", encoded)
	}
}

func TestProductionPlanPropSceneAssociationDoesNotBlockGeneration(t *testing.T) {
	m := productionManifest{Plan: &productionPlan{Assets: []productionPlanAsset{
		{Key: "scene", Kind: "environment"},
		{Key: "hero", Kind: "character"},
		{Key: "prop", Kind: "prop", DependsOn: []string{"scene", "hero"}},
		{Key: "hero-form", Kind: "character", BaseKey: "hero", DependsOn: []string{"hero"}},
	}}}
	got := productionPlanAssetDependencies(m, *productionPlanItem(m, "prop"))
	if len(got) != 1 || got[0] != "hero" {
		t.Fatalf("prop scene association should be ignored while real dependencies remain: %v", got)
	}
	if _, exists := productionPlanDependencies(m, nil, "prop")["scene"]; exists {
		t.Fatal("scene should not be an artifact prerequisite for a prop")
	}
	if _, exists := productionPlanDependencies(m, nil, "scene")["prop"]; exists {
		t.Fatal("prop should not be an artifact prerequisite for a scene")
	}
	variantDeps := productionPlanAssetDependencies(m, *productionPlanItem(m, "hero-form"))
	if len(variantDeps) != 1 || variantDeps[0] != "hero" {
		t.Fatalf("base-form dependency should remain intact: %v", variantDeps)
	}
	legacy := productionPlan{Version: 5, Assets: []productionPlanAsset{
		{Key: "scene", Kind: "environment", Purpose: "地点", PlannedRange: "全篇", DependsOn: []string{"prop"}},
		{Key: "prop", Kind: "prop", Purpose: "剧情物件", PlannedRange: "全篇", DependsOn: []string{"scene"}},
	}, Absent: map[string]string{"character": "无", "special": "无", "sound": "无"}}
	if err := productionValidatePlanInventory(legacy); err != nil {
		t.Fatalf("legacy prop-scene association must not invalidate the inventory: %v", err)
	}
}

func TestProductionPlanChangingStoryInvalidatesDownstreamButKeepsNodes(t *testing.T) {
	s, _, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := submitOrderedPlan(t, s, run.ID, "story", "", "总纲")
	input := productionPlan{StoryHash: story["hash"].(string), Complete: true, Assets: []productionPlanAsset{{Key: "hero", Kind: "character", Name: "林岚", Purpose: "主角", PlannedRange: "第一篇章"}}, Absent: map[string]string{"environment": "无", "prop": "无", "special": "无", "sound": "无"}}
	productionCall(t, s, run.ID, "production_plan_inventory", input, false)
	submitOrderedPlan(t, s, run.ID, "visual", "", "美术规范")
	submitOrderedPlan(t, s, run.ID, "direction", "", "导演规范")
	submitOrderedPlan(t, s, run.ID, "generation", "", "生成规范")
	startPlanAssetsForTest(t, s, run.ID)
	submitOrderedPlan(t, s, run.ID, "hero", "character", "林岚")
	document := orderedPlanDocument("story", "")
	document["ending"] = "本季救回家人，保留相机来历的开放悬念。"
	updated := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "总纲", "document": document, "expectedHash": story["hash"], "factIds": []string{}}, false)
	m, doc, artifacts := orderedPlanState(t, s, run.ID)
	if productionPlanArtifactValid(m, doc, artifacts, "hero") || len(artifacts) != 6 {
		t.Fatal("downstream remained valid or existing nodes lost")
	}
	requirePlanAction(t, s, run.ID, "inventory", "")
	input.StoryHash = updated["hash"].(string)
	productionCall(t, s, run.ID, "production_plan_inventory", input, false)
	requirePlanAction(t, s, run.ID, "standards", "visual")
}

func TestProductionPlanStatusPaginationAndRepairProbeAreReadOnly(t *testing.T) {
	s, _, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	call, err := s.productionRepairCall("user", run.ID, "diagnostic")
	if err != nil || call.Function.Name != "production_status" {
		t.Fatal(call, err)
	}
	if len(mustPlanArtifacts(t, s, run.ID)) != 0 {
		t.Fatal("repair probe wrote missing document")
	}
	submitOrderedPlan(t, s, run.ID, "story", "", "总纲")
	// The source page list is shorter than the artifact list on later pages.
	if err := s.repo.CreateProductionAgentArtifact(&model.ProductionAgentArtifact{UserID: "user", RunID: run.ID, Key: "other", NodeID: "missing", ContentHash: "x", FactIDsJSON: "[]"}); err != nil {
		t.Fatal(err)
	}
	status := productionCall(t, s, run.ID, "production_status", map[string]any{"offset": 2}, false)
	if len(status["pages"].([]any)) != 0 {
		t.Fatal(status)
	}
	encoded, _ := json.Marshal(status)
	if !strings.Contains(string(encoded), "blockedReason") {
		t.Fatal(status)
	}
}

func TestProductionPlanLargeCatalogUnicodeAndCommonTitleDoNotBlock(t *testing.T) {
	s, _, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	document := orderedPlanDocument("story", "")
	document["plot"] = strings.Repeat("剧情", 5200)
	arguments := map[string]any{"key": "story", "name": "总纲", "document": document, "factIds": []string{}}
	raw, _ := json.Marshal(arguments)
	if len(raw) <= 32000 {
		t.Fatal("fixture must exceed the old byte limit")
	}
	story := productionCall(t, s, run.ID, "production_submit", arguments, false)
	input := productionPlan{StoryHash: story["hash"].(string), Complete: true, Absent: map[string]string{"environment": "无", "prop": "无", "special": "无", "sound": "无"}}
	input.Assets = []productionPlanAsset{{Key: "$reserved", Kind: "character", Name: "测试", Purpose: "主角", PlannedRange: "第一篇章"}}
	productionCall(t, s, run.ID, "production_plan_inventory", input, true)
	input.Assets = nil
	for i := 0; i < 50; i++ {
		name := fmt.Sprintf("人物%d", i)
		if i == 0 {
			name = "视觉与美术规范"
		}
		input.Assets = append(input.Assets, productionPlanAsset{Key: fmt.Sprintf("hero%d", i), Kind: "character", Name: name, Purpose: strings.Repeat("a", 2500), PlannedRange: "第一篇章"})
	}
	productionCall(t, s, run.ID, "production_plan_inventory", input, false)
	_, doc, rows := orderedPlanState(t, s, run.ID)
	found := false
	for _, row := range rows {
		if row.Key == "inventory" {
			content := stringValue(productionNode(doc, row.NodeID)["metadata"].(map[string]any)["content"])
			if utf8.RuneCountInString(content) <= 120000 {
				t.Fatal("fixture did not exceed old catalog limit")
			}
			found = true
		}
	}
	if !found {
		t.Fatal("catalog was not persisted")
	}
	submitOrderedPlan(t, s, run.ID, "visual", "", "视觉与美术规范")
	submitOrderedPlan(t, s, run.ID, "direction", "", "导演规范")
	submitOrderedPlan(t, s, run.ID, "generation", "", "生成规范")
	startPlanAssetsForTest(t, s, run.ID)
	submitOrderedPlan(t, s, run.ID, "hero0", "character", "视觉与美术规范")
	if len(mustPlanArtifacts(t, s, run.ID)) != 6 {
		t.Fatal("asset/common title collision lost a node")
	}
}

func TestProductionPlanCannotRemoveVariantStillReferencedByNewDocument(t *testing.T) {
	s, _, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := submitOrderedPlan(t, s, run.ID, "story", "", "总纲")
	input := productionPlan{StoryHash: story["hash"].(string), Complete: true, Assets: []productionPlanAsset{{Key: "hero", Kind: "character", Name: "主角", Purpose: "主人公", PlannedRange: "第一篇章"}}, Absent: map[string]string{"environment": "无", "prop": "无", "special": "无", "sound": "无"}}
	productionCall(t, s, run.ID, "production_plan_inventory", input, false)
	submitOrderedPlan(t, s, run.ID, "visual", "", "美术")
	submitOrderedPlan(t, s, run.ID, "direction", "", "导演")
	submitOrderedPlan(t, s, run.ID, "generation", "", "生成规范")
	startPlanAssetsForTest(t, s, run.ID)
	arguments := map[string]any{"key": "hero", "name": "主角", "document": orderedPlanDocument("hero", "character"), "factIds": []string{}, "design": productionDesignFields{Variants: []productionDesignVariant{{Name: "兽化形态", Description: "变身为兽形"}}}}
	first := productionCall(t, s, run.ID, "production_submit", arguments, false)
	document := orderedPlanDocument("hero", "character")
	_, savedDoc, artifacts := orderedPlanState(t, s, run.ID)
	for _, artifact := range artifacts {
		if artifact.Key == "hero" {
			profile := productionWorkflow(productionNode(savedDoc, artifact.NodeID))["assetProfile"].(map[string]any)
			variant := creationMaps(profile["variants"])[0]
			document["prompt"] = "使用 @" + stringValue(variant["code"]) + " 的兽化形态。"
		}
	}
	arguments["document"], arguments["expectedHash"] = document, first["hash"]
	kept := productionCall(t, s, run.ID, "production_submit", arguments, false)
	arguments["expectedHash"] = kept["hash"]
	arguments["design"] = productionDesignFields{Variants: []productionDesignVariant{}}
	productionCall(t, s, run.ID, "production_submit", arguments, true)
	_, _, rows := orderedPlanState(t, s, run.ID)
	for _, row := range rows {
		if row.Key == "hero" && row.ContentHash != kept["hash"] {
			t.Fatal("invalid variant removal changed the saved node")
		}
	}
}

func TestProductionPlanInventoryStoresMajorFormAsSeparateAsset(t *testing.T) {
	s, _, run := planFixture(t, 3)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := submitOrderedPlan(t, s, run.ID, "story", "", "故事总纲")
	input := productionPlan{StoryHash: story["hash"].(string), Complete: true, Assets: []productionPlanAsset{
		{Key: "hero", Kind: "character", Name: "主角", Purpose: "人物主体", PlannedRange: "全篇"},
		{Key: "hero-beast", Kind: "character", Name: "主角·兽化形态", BaseKey: "hero", StateName: "兽化形态", Purpose: "重大变形后的独立形态", PlannedRange: "后篇"},
	}, Absent: map[string]string{"environment": "无", "prop": "无", "sound": "无"}}
	productionCall(t, s, run.ID, "production_plan_inventory", input, false)
	m, _, _ := orderedPlanState(t, s, run.ID)
	base, form := productionPlanItem(m, "hero"), productionPlanItem(m, "hero-beast")
	if base == nil || form == nil || form.BaseKey != base.Key || form.Identity == nil || base.Identity == nil || form.Identity.Code == base.Identity.Code {
		t.Fatalf("major form should have its own registered code: base=%+v form=%+v", base, form)
	}
}
