package app

import (
	"strings"
	"testing"
)

func productionEpisodeArchitectureFixture(count int) string {
	rows := []string{
		"集号 | 剧情任务 | 开场承接/起始状态 | 目标与主要阻力 | 关键选择/行动 | 因果结果/代价 | 信息/关系/情绪变化 | 人物与资产状态变化 | 结束状态/本集收束 | 与下一集的承接 | 节奏与内容覆盖",
		"--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---",
	}
	for episode := 1; episode <= count; episode++ {
		rows = append(rows, strings.Join([]string{
			"EP-" + map[int]string{1: "001", 2: "002", 3: "003"}[episode],
			"完成本集剧情任务", "承接前集状态", "角色目标与具体阻力", "作出关键选择并采取行动",
			"行动产生结果与相应代价", "信息和关系发生有依据的变化", "状态变化依据已写明",
			"本集行动获得阶段性收束", "下一集承接当前未决行动", "内容覆盖符合已定单集时长",
		}, " | "))
	}
	return strings.Join(rows, "\n")
}

func productionEpisodeArchitectureManifest(count int) (productionManifest, map[string]any) {
	frame := map[string]any{
		"id":       "plan-frame",
		"metadata": map[string]any{"shortDrama": map[string]any{"parameters": map[string]any{"episodeCount": float64(count)}}},
	}
	doc := map[string]any{"nodes": []any{frame}}
	return productionManifest{FrameID: "plan-frame", Plan: &productionPlan{StoryStructureVersion: 1}}, doc
}

func TestProductionEpisodeArchitectureCoversConfiguredEpisodes(t *testing.T) {
	m, doc := productionEpisodeArchitectureManifest(3)
	valid := productionEpisodeArchitectureFixture(3)
	content, err := productionRenderPlanDocumentForSchema("story", "", map[string]string{
		"facts":               "项目参数依据。",
		"premise":             "故事命题。",
		"motivation":          "人物目标与代价。",
		"world":               "世界设定。",
		"worldRules":          "世界规则。",
		"conflict":            "核心冲突。",
		"plot":                "完整故事转折。",
		"arcs":                "篇章分配。",
		"characterArcs":       "人物弧光。",
		"relationships":       "关系变化。",
		"ending":              "符合用户要求的结局。",
		"foreshadowing":       "伏笔与回收。",
		"continuity":          "连续性规则。",
		"uncertainties":       "待验证事项。",
		"episodeArchitecture": valid,
	}, 2)
	if err != nil {
		t.Fatal(err)
	}
	if issues := productionPlanEpisodeArchitectureIssues(m, doc, content, 2); len(issues) > 0 {
		t.Fatalf("complete episode skeleton rejected: %v", issues)
	}

	missingEpisode := strings.Replace(valid, "EP-002 |", "EP-003 |", 1)
	issues := productionPlanEpisodeArchitectureIssues(m, doc, strings.Replace(content, valid, missingEpisode, 1), 2)
	if !strings.Contains(strings.Join(issues, " "), "缺少第2集") || !strings.Contains(strings.Join(issues, " "), "重复") {
		t.Fatalf("missing and duplicated episode rows were not diagnosed: %v", issues)
	}

	blankField := strings.Replace(valid, "作出关键选择并采取行动", "", 1)
	issues = productionPlanEpisodeArchitectureIssues(m, doc, strings.Replace(content, valid, blankField, 1), 2)
	if !strings.Contains(strings.Join(issues, " "), "第4项内容为空") {
		t.Fatalf("blank required field was not diagnosed: %v", issues)
	}

	if got := productionPlanDocumentMissingForSchema("story", "", content, 1); len(got) != 0 {
		t.Fatalf("new schema content must remain readable by legacy structural checks: %v", got)
	}
	if productionPlanDocumentSchemaVersion(3) != 1 || productionPlanDocumentSchemaVersion(4) != 2 {
		t.Fatal("schema version compatibility changed")
	}
}

func TestProductionEpisodeArchitectureRejectsMissingDocumentField(t *testing.T) {
	fields := map[string]string{}
	for _, section := range productionPlanDocumentSectionsForSchema("story", "", 2) {
		fields[section.Key] = "具体且可执行的规划。"
	}
	delete(fields, "episodeArchitecture")
	if _, err := productionRenderPlanDocumentForSchema("story", "", fields, 2); err == nil || !strings.Contains(err.Error(), "episodeArchitecture") {
		t.Fatalf("new plan accepted a missing episode architecture field: %v", err)
	}
}

func TestProductionEpisodeArchitectureDiagnosesSplitFieldsWithoutDroppingContent(t *testing.T) {
	m, doc := productionEpisodeArchitectureManifest(3)
	valid := productionEpisodeArchitectureFixture(3)
	invalid := strings.Replace(valid, "行动产生结果与相应代价", "结果：完成调查 | 代价：失去线索", 1)
	issues := productionPlanEpisodeArchitectureIssues(m, doc, "## 逐集剧情与状态规划\n"+invalid, 2)
	message := strings.Join(issues, "；")
	for _, expected := range []string{"第1集应有11列", "当前为12列", "结果与代价必须同列", "保留全部剧情和未报错行"} {
		if !strings.Contains(message, expected) {
			t.Fatalf("missing actionable correction %q: %s", expected, message)
		}
	}
	if strings.Contains(message, "第2集应有") || strings.Contains(message, "第3集应有") {
		t.Fatal("valid episodes must not be marked for rewriting", message)
	}
	corrected := strings.Replace(invalid, "结果：完成调查 | 代价：失去线索", "结果：完成调查；代价：失去线索", 1)
	if issues := productionPlanEpisodeArchitectureIssues(m, doc, "## 逐集剧情与状态规划\n"+corrected, 2); len(issues) != 0 {
		t.Fatal("lossless column correction was rejected", issues)
	}
	description := productionPlanFieldDescriptionForSchema("story", "", productionDocumentSection{"episodeArchitecture", "逐集剧情与状态规划"}, 2)
	if !strings.Contains(description, productionEpisodeArchitectureContract()) {
		t.Fatal("generation schema and validation disagree about columns")
	}
}

func TestProductionEpisodeArchitectureDocumentBudgetScalesWithConfiguredEpisodes(t *testing.T) {
	one, oneDoc := productionEpisodeArchitectureManifest(1)
	many, manyDoc := productionEpisodeArchitectureManifest(40)
	oneLimit := productionPlanDocumentRuneLimit(one, oneDoc, "story")
	manyLimit := productionPlanDocumentRuneLimit(many, manyDoc, "story")
	wantDelta := 39 * (productionEpisodeArchitectureColumnCount - 1) * productionEpisodeArchitectureFieldRuneBudget
	if manyLimit-oneLimit != wantDelta {
		t.Fatalf("episode document limit did not scale with the configured structure: got delta %d, want %d", manyLimit-oneLimit, wantDelta)
	}
	if productionPlanDocumentRuneLimit(many, manyDoc, "visual") != productionPlanDocumentMaxRunes {
		t.Fatal("non-episode documents should retain their existing limit")
	}
}
