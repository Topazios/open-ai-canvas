package app

import (
	"fmt"
	"strings"
	"testing"
)

func TestProductionAssetsWaitForEveryStandard(t *testing.T) {
	for _, version := range []int{2, 3} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			s, _, run := planFixture(t, version)
			productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
			story := submitOrderedPlan(t, s, run.ID, "story", "", "总纲")
			absent := map[string]string{"environment": "无", "prop": "无", "sound": "无"}
			if version == 2 {
				absent["special"] = "无"
			}
			productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{StoryHash: stringValue(story["hash"]), Complete: true, Assets: []productionPlanAsset{{Key: "hero", Kind: "character", Name: "主角", Purpose: "主角", PlannedRange: "全剧"}}, Absent: absent}, false)
			for _, key := range []string{"visual", "direction", "generation"} {
				m, doc, rows := orderedPlanState(t, s, run.ID)
				if productionPlanPrerequisites(m, doc, rows, "hero") == nil {
					t.Fatalf("asset admitted before %s", key)
				}
				for _, ready := range productionParallelReady(m, doc, rows) {
					if productionPlanItem(m, ready.Key) != nil {
						t.Fatalf("asset queued before %s", key)
					}
				}
				execution, state := productionRuntimeState(t, s, run.ID)
				before := len(state.TaskIDs)
				work := productionParallelWork{Key: "hero", Name: "主角", Dependencies: productionParallelDependencyHash(m, rows, "hero")}
				if err := s.enqueueProductionParallel(execution, &state, m, doc, rows, work); err == nil {
					t.Fatalf("direct enqueue bypassed %s", key)
				}
				productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "hero", "name": "主角", "document": orderedPlanDocument("hero", "character")}, true)
				_, after := productionRuntimeState(t, s, run.ID)
				if len(after.TaskIDs) != before || len(mustPlanArtifacts(t, s, run.ID)) != len(rows) {
					t.Fatal("blocked admission created task or artifact")
				}
				groups := productionPlanGroupProgress(m, doc, rows, &state)
				if len(groups) != 1 || groups[0].Status != "waiting_standards" {
					t.Fatalf("empty group claimed to be running: %+v", groups)
				}
				submitOrderedPlan(t, s, run.ID, key, "", key)
			}
			m, doc, rows := orderedPlanState(t, s, run.ID)
			ready := productionParallelReady(m, doc, rows)
			if len(ready) != 0 {
				t.Fatalf("standards completion automatically released assets: %+v", ready)
			}
			_, beforeStart := productionRuntimeState(t, s, run.ID)
			if groups := productionPlanGroupProgress(m, doc, rows, &beforeStart); groups[0].Status != "waiting_manual" {
				t.Fatalf("missing manual boundary: %+v", groups)
			}
			startPlanAssetsForTest(t, s, run.ID)
			m, doc, rows = orderedPlanState(t, s, run.ID)
			ready = productionParallelReady(m, doc, rows)
			if len(ready) != 1 || ready[0].Key != "hero" {
				t.Fatalf("standards did not release assets: %+v", ready)
			}
			for _, missing := range []string{"story", "inventory", "visual", "direction", "generation"} {
				without := rows[:0:0]
				for _, row := range rows {
					if row.Key != missing {
						without = append(without, row)
					}
				}
				if productionPlanPrerequisites(m, doc, without, "hero") == nil {
					t.Fatalf("missing %s did not block asset creation", missing)
				}
			}
			// Generation rules are complete without reading an unmade dossier.
			for dependency := range productionPlanDependencies(m, rows, "generation") {
				if productionPlanItem(m, dependency) != nil {
					t.Fatal("standards and assets form a cycle")
				}
			}
			hero := submitOrderedPlan(t, s, run.ID, "hero", "character", "主角")
			m, doc, rows = orderedPlanState(t, s, run.ID)
			_, state := productionRuntimeState(t, s, run.ID)
			if groups := productionPlanGroupProgress(m, doc, rows, &state); groups[0].Status != "complete" || groups[0].Completed != 1 {
				t.Fatalf("group completion not scoped: %+v", groups)
			}
			generationHash := ""
			for _, row := range rows {
				if row.Key == "generation" {
					generationHash = row.ContentHash
				}
			}
			document := orderedPlanDocument("generation", "")
			document["identityRules"] += "修订身份核验规则。"
			productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "generation", "name": "generation", "document": document, "expectedHash": generationHash}, false)
			m, doc, rows = orderedPlanState(t, s, run.ID)
			if productionPlanArtifactValid(m, doc, rows, "hero") {
				t.Fatal("asset did not record generation standard version")
			}
			for _, row := range rows {
				if row.Key == "hero" && row.ContentHash != stringValue(hero["hash"]) {
					t.Fatal("rule change overwrote existing asset")
				}
			}
			if strings.Contains(unifiedPlanPolicy, "生成规范最后") {
				t.Fatal("prompt still instructs reverse dependency order")
			}
		})
	}
}

func TestProductionAssetGroupOnlyRunsItsOwnWork(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	startPlanAssetsForTest(t, s, runID)
	m, doc, rows := orderedPlanState(t, s, runID)
	_, state := productionRuntimeState(t, s, runID)
	state.ProductionParallel = map[string]productionParallelWork{"character": {Key: "character", TaskID: "queued-task"}, "prop": {Key: "prop", Error: "invalid document"}}
	for _, group := range productionPlanGroupProgress(m, doc, rows, &state) {
		want := "waiting"
		switch group.Kind {
		case "character":
			want = "running"
		case "prop":
			want = "error"
		}
		if group.Status != want {
			t.Fatalf("%s group status=%s, want %s", group.Kind, group.Status, want)
		}
	}
}
