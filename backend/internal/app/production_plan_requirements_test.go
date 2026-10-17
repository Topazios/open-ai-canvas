package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProductionPlanRequirementsReachEachToolSchema(t *testing.T) {
	for _, test := range productionPlanDocumentCases {
		t.Run(test.key, func(t *testing.T) {
			work := map[string]any{"nextAction": map[string]any{"key": test.key, "kind": test.kind}}
			tools := productionRuntimeTools(productionManifest{Plan: &productionPlan{Version: 2}}, work)
			found := false
			for _, tool := range tools {
				fn := tool["function"].(map[string]any)
				if fn["name"] != "production_submit" {
					continue
				}
				found = true
				properties := fn["parameters"].(map[string]any)["properties"].(map[string]any)
				fields := properties["document"].(map[string]any)["properties"].(map[string]any)
				for _, section := range productionPlanDocumentSections(test.key, test.kind) {
					description := fields[section.Key].(map[string]any)["description"].(string)
					if description == section.Title || description != productionPlanFieldDescription(test.key, test.kind, section) {
						t.Fatalf("missing actionable requirement: %s.%s", test.key, section.Key)
					}
				}
			}
			if !found {
				t.Fatal("submit tool missing")
			}
		})
	}
	for key, fields := range productionPlanFieldRequirements {
		known := map[string]bool{}
		for _, section := range productionPlanDocumentSections(key, "") {
			known[section.Key] = true
		}
		for field := range fields {
			if !known[field] {
				t.Fatalf("orphan requirement %s.%s", key, field)
			}
		}
	}
}

func TestProductionPlanPlaceholderRepairKeepsHistoricalValidity(t *testing.T) {
	document := orderedPlanDocument("direction", "")
	for _, value := range []string{"待补充", "待确认。", "TBD", "同上"} {
		document["voiceDirection"] = value
		_, err := productionRenderPlanDocument("direction", "", document)
		requireProductionPlanDocumentError(t, err, "document.voiceDirection", "placeholder_content")
	}
	document["voiceDirection"] = "本项目无对白与旁白，以动作和环境声表达，不生成口型与角色配音。"
	content, err := productionRenderPlanDocument("direction", "", document)
	if err != nil {
		t.Fatal(err)
	}
	// Do not invalidate saved receipts or force regeneration when guidance improves.
	historical := strings.Replace(content, document["voiceDirection"], "待补充", 1)
	if missing := productionPlanDocumentMissing("direction", "", historical); len(missing) != 0 {
		t.Fatalf("guidance change invalidated historical structure: %v", missing)
	}
}

func TestProductionPlanParallelRequestIncludesSoundRequirements(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["direction"].TaskID != "" })
	cancel()
	<-done
	task, err := s.repo.TaskForUser("user", state.ProductionParallel["direction"].TaskID)
	if err != nil {
		t.Fatal(err)
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	canonical := stateCanonicalFromInput(input)
	if len(canonical.Tools) != 1 {
		t.Fatalf("unexpected tools: %d", len(canonical.Tools))
	}
	fn := canonical.Tools[0]["function"].(map[string]any)
	properties := fn["parameters"].(map[string]any)["properties"].(map[string]any)
	fields := properties["document"].(map[string]any)["properties"].(map[string]any)
	for _, field := range []string{"voiceDirection", "music", "ambience", "soundEffects", "sound"} {
		if description := fields[field].(map[string]any)["description"].(string); !strings.Contains(description, productionPlanFieldRequirements["direction"][field]) {
			t.Fatalf("parallel request lost sound requirement: %s", field)
		}
	}
}
