package app

import (
	"strings"
	"testing"
)

func TestProductionStandardContextOmitsBulkTables(t *testing.T) {
	m := productionManifest{Plan: &productionPlan{Version: 5, StoryStructureVersion: 3, FlowVersion: 1, FlowStoryUnits: []string{"adopted"}}}
	fields := map[string]string{}
	for _, section := range productionPlanDocumentSectionsForSchema("story", "", 4) {
		fields[section.Key] = "必须保留的" + section.Key
	}
	fields["episodeArchitecture"] = strings.Repeat("逐集巨表", 20000)
	fields["coreAssets"] = strings.Repeat("资产巨表", 20000)
	content, err := productionRenderPlanDocumentForSchema("story", "", fields, 4)
	if err != nil {
		t.Fatal(err)
	}
	compact := productionStandardStoryContext(m, content)
	if len(compact) > 3000 || strings.Contains(compact, "巨表") || !strings.Contains(compact, fields["worldRules"]) || !strings.Contains(compact, fields["premise"]) || !strings.Contains(compact, fields["relationships"]) {
		t.Fatalf("standard source did not retain complete creative boundaries: %s", compact)
	}
}

func TestProductionStandardBatchesPersistAndProtectEditedCopy(t *testing.T) {
	s, db, runID := v5SubmittedStoryFixtureWithDB(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	if work.DocumentParts == nil || len(work.DocumentParts.Pending) != 3 || len(work.DocumentParts.Pending[0]) != 5 {
		t.Fatalf("standards must start with bounded business batches: %+v", work.DocumentParts)
	}
	for i := 0; i < 3; i++ {
		finishDocumentPart(t, s, db, runID, work)
		if i < 2 {
			work = enqueueDocumentPart(t, s, runID, "visual")
		}
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "visual") {
		t.Fatal("completed batches were not published")
	}
	oldID := ""
	for _, row := range rows {
		if row.Key == "visual" {
			oldID = row.NodeID
		}
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionNode(doc, oldID)["metadata"].(map[string]any)["content"] = "用户自行保存的内容"
	})
	for i := 0; i < 3; i++ {
		work = enqueueDocumentPart(t, s, runID, "visual")
		finishDocumentPart(t, s, db, runID, work)
	}
	m, doc, rows = orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "visual") {
		t.Fatal("edited receipt caused a repair loop")
	}
	old := productionNode(doc, oldID)
	if old["metadata"].(map[string]any)["content"] != "用户自行保存的内容" || productionWorkflow(old)["planSection"] != nil {
		t.Fatal("candidate replaced the edited text or left two active standards")
	}
}

func TestProductionStandardTimeoutShrinksOnlyPendingBatch(t *testing.T) {
	s, _, runID := v5SubmittedStoryFixtureWithDB(t)
	m, doc, rows := orderedPlanState(t, s, runID)
	work := productionParallelWork{Key: "visual", Dependencies: productionParallelDependencyHash(m, rows, "visual")}
	if err := productionSplitDocumentParts(m, doc, rows, &work); err != nil {
		t.Fatal(err)
	}
	work.DocumentParts.Fields["facts"] = "已完成内容"
	work.DocumentParts.Pending[0] = work.DocumentParts.Pending[0][1:]
	if err := productionSplitDocumentParts(m, doc, rows, &work); err != nil {
		t.Fatal(err)
	}
	if !work.DisableThinking || len(work.DocumentParts.Pending[0]) != 2 || work.DocumentParts.Fields["facts"] != "已完成内容" {
		t.Fatal("timeout retry repeated the original size or lost accepted chapters")
	}
}
