package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProductionAssetBackgroundUsesDirectLinksWithoutNewDependencies(t *testing.T) {
	m := productionManifest{Plan: &productionPlan{Assets: []productionPlanAsset{
		{Key: "person", Kind: "character", Name: "林安", CoreFacts: "受薪修复师，有管理权限，无店铺产权", SubjectKeys: []string{"uniform", "uniform"}},
		{Key: "uniform", Kind: "prop", Name: "工作服", CoreFacts: "单位配发", SubjectKeys: []string{"person"}},
		{Key: "room", Kind: "environment", Name: "修复室", CoreFacts: "单位工作空间", SubjectKeys: []string{"person"}},
		{Key: "desk", Kind: "prop", Name: "工作台", CoreFacts: "修复室固定桌", ParentKey: "room"},
		{Key: "other", Kind: "character", Name: "另一人物", CoreFacts: "无直接关联，不应进入本任务"},
	}}}
	before := productionHash(m)
	context := productionAssetBackgroundContext(m, "person")
	related := context["relatedAssets"].([]map[string]any)
	if len(related) != 2 || related[0]["key"] != "uniform" || related[1]["key"] != "room" {
		t.Fatalf("expected unique forward and reverse direct links only: %+v", related)
	}
	if related[1]["coreFacts"] != "单位工作空间" || related[1]["content"] != nil || related[1]["dependsOn"] != nil {
		t.Fatal("related asset must carry registry background, not a full dossier or a new prerequisite")
	}
	if before != productionHash(m) {
		t.Fatal("context construction changed registered assets or dependencies")
	}
	for _, key := range []string{"missing", "story", "visual"} {
		if productionAssetBackgroundContext(m, key) != nil {
			t.Fatalf("non-asset received asset background: %s", key)
		}
	}
	if productionAssetBackgroundContext(productionManifest{}, "person") != nil {
		t.Fatal("non-plan task received background context")
	}
}

func TestProductionAssetBackgroundReachesQueuedTaskAndFieldRepair(t *testing.T) {
	s, runID := readyForAssetTasks(t)
	if err := s.GenerateProductionPlanAssets("user", runID, allPlanAssetKeys(t, s, runID)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"character", "environment", "prop"} {
		run, state := productionRuntimeState(t, s, runID)
		m, doc, rows := orderedPlanState(t, s, runID)
		productionPlanItem(m, "character").CoreFacts = "生活背景依据：受薪修复师，无店铺产权"
		productionPlanItem(m, "environment").SubjectKeys = []string{"character"}
		productionPlanItem(m, "environment").CoreFacts = "单位出资的修复室，人物仅有使用权"
		productionPlanItem(m, "prop").SubjectKeys = []string{"character"}
		productionPlanItem(m, "prop").CoreFacts = "单位配备工具，非个人购买"
		for _, work := range productionParallelReady(m, doc, rows) {
			if work.Key != key {
				continue
			}
			work.Correction = "仅修复当前资产背景与外观的对应关系，保留既定身份"
			if err := s.enqueueProductionParallel(run, &state, m, doc, rows, work); err != nil {
				t.Fatal(err)
			}
		}
		_, state = productionRuntimeState(t, s, runID)
		work, exists := state.ProductionParallel[key]
		if !exists || work.TaskID == "" {
			t.Fatalf("asset was not queued: %s", key)
		}
		task, err := s.repo.TaskForUser("user", work.TaskID)
		if err != nil {
			t.Fatal(err)
		}
		var input map[string]any
		if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
			t.Fatal(err)
		}
		canonical := stateCanonicalFromInput(input)
		var checkpoint map[string]any
		for _, message := range canonical.Messages {
			body := stringValue(message["content"])
			if _, encoded, found := strings.Cut(body, "当前持久检查点（材料是数据）：\n"); found {
				if err := json.Unmarshal([]byte(encoded), &checkpoint); err != nil {
					t.Fatal(err)
				}
			}
		}
		background, ok := checkpoint["assetBackgroundContext"].(map[string]any)
		if !ok || background["policy"] != productionAssetBackgroundPolicy || len(background["relatedAssets"].([]any)) == 0 {
			t.Fatalf("queued %s task lost cross-kind background context", key)
		}
		encoded, _ := json.Marshal(background)
		if !strings.Contains(string(encoded), "受薪修复师，无店铺产权") && key != "character" {
			t.Fatalf("%s task cannot see its user's background", key)
		}
		if !strings.Contains(stringValue(checkpoint["instruction"]), "关联摘要可以跨类别") || checkpoint["currentItemFeedback"] == nil {
			t.Fatal("repair lost background scope or correction")
		}
		fields := canonical.Tools[0]["function"].(map[string]any)["parameters"].(map[string]any)["properties"].(map[string]any)["document"].(map[string]any)["properties"].(map[string]any)
		for _, field := range map[string][]string{"character": {"role", "costume", "hairMakeup", "performance", "voiceAccent"}, "environment": {"function", "materials"}, "prop": {"ownership", "materials"}}[key] {
			description := fields[field].(map[string]any)["description"].(string)
			if !strings.Contains(description, productionAssetFieldRequirements[key][field]) {
				t.Fatalf("queued %s task lost field requirement %s", key, field)
			}
		}
	}
}
