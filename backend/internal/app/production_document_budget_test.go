package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"infinite-canvas/backend/internal/repository"
)

func TestProductionDocumentBudgetMatchesRenderedContent(t *testing.T) {
	for _, key := range []string{"story", "visual", "direction", "generation"} {
		for _, schema := range []int{1, 2} {
			sections := productionPlanDocumentSectionsForSchema(key, "", schema)
			fields := map[string]string{}
			for _, section := range sections {
				fields[section.Key] = "  有效规范包含中文、非 BMP 字符 \U0001F3AC 与多行说明。\n明确边界。\n "
			}
			content, err := productionRenderPlanDocumentForSchema(key, "", fields, schema)
			if err != nil {
				t.Fatal(err)
			}
			if actual := productionDocumentContentChars(fields) + productionDocumentHeadingChars(sections); actual != utf8.RuneCountInString(content) {
				t.Fatalf("%s/%d budget %d differs from renderer %d", key, schema, actual, utf8.RuneCountInString(content))
			}
		}
	}
}

func TestProductionDocumentBudgetReservesLaterChaptersAndRecoversLength(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ForceThinkingOff = true })
	work := enqueueDocumentPart(t, s, runID, "visual")
	failDocumentPart(t, s, db, runID, work)
	work = enqueueDocumentPart(t, s, runID, "visual")
	fields := map[string]string{}
	for _, field := range work.DocumentParts.Pending[0] {
		fields[field] = "明确设计与制作约束。"
	}
	fields["characterDesign"] = strings.Repeat("人物尺度材质", 2400)
	settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "expectedHash": "", "factIds": []string{}, "document": fields})
	before := productionHash(mustPlanArtifacts(t, s, runID))
	work = enqueueDocumentPart(t, s, runID, "visual")
	m, doc, _ := orderedPlanState(t, s, runID)
	budget := productionDocumentWorkBudget(m, doc, work)
	if budget.AcceptedContentChars != productionDocumentContentChars(fields) || budget.BatchMaxContentChars != budget.RemainingContentChars || budget.MaxChars != productionPlanDocumentMaxRunes {
		t.Fatalf("remaining batch got an incorrect budget: %+v", budget)
	}
	task, _ := s.repo.Task(work.TaskID)
	if !strings.Contains(task.InputJSON, "remainingContentChars") || !strings.Contains(task.InputJSON, "本字段建议约") {
		t.Fatal("budget was not delivered to the actual task and tool schema")
	}
	rejected := map[string]string{}
	for _, field := range work.DocumentParts.Pending[0] {
		rejected[field] = strings.Repeat("完整制作要求", 300)
	}
	settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "expectedHash": "", "factIds": []string{}, "document": rejected})
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if work.DocumentParts.RepairFields["characterDesign"] != fields["characterDesign"] || !reflect.DeepEqual(work.DocumentParts.Pending[0], []string{"characterDesign"}) || work.DocumentParts.Fields["style"] != fields["style"] || work.DocumentParts.RepairFields["propDesign"] != rejected["propDesign"] {
		t.Fatal("length recovery lost originals or rewrote unaffected chapters")
	}
	if !strings.Contains(work.Correction, "24000") || !strings.Contains(work.Correction, "至少") || productionHash(mustPlanArtifacts(t, s, runID)) != before {
		t.Fatal("length error lacked actionable counts or exposed a partial artifact")
	}
	// Private originals and budgets survive a service boundary. Repair the long
	// chapter first, then fill the remaining batch and run the full validator.
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	work = enqueueDocumentPart(t, s, runID, "visual")
	m, doc, _ = orderedPlanState(t, s, runID)
	budget = productionDocumentWorkBudget(m, doc, work)
	if budget.BatchMaxContentChars >= budget.RemainingContentChars || budget.BatchMaxContentChars <= 0 {
		t.Fatal("reopened field consumed the budget for later chapters")
	}
	finishDocumentPart(t, s, db, runID, work)
	work = enqueueDocumentPart(t, s, runID, "visual")
	if work.DocumentParts.RepairFields["propDesign"] != rejected["propDesign"] {
		t.Fatal("repairing an earlier chapter discarded a later batch's original")
	}
	finishDocumentPart(t, s, db, runID, work)
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "visual") {
		t.Fatal("recovered document failed ordinary full validation")
	}
}

func TestProductionDocumentBudgetWholeDocumentLengthRepair(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	fields := orderedPlanDocument("visual", "")
	fields["style"] = strings.Repeat("具体规范", 6500)
	settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "expectedHash": "", "factIds": []string{}, "document": fields})
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if work.DocumentParts == nil || !reflect.DeepEqual(work.DocumentParts.RepairFields, fields) || len(work.DocumentParts.Fields) != 0 {
		t.Fatal("oversized whole document was discarded or promoted as valid")
	}
	work = enqueueDocumentPart(t, s, runID, "visual")
	finishDocumentPart(t, s, db, runID, work)
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "visual") {
		t.Fatal("whole-document compaction could not finish")
	}
}

func TestProductionDocumentBudgetRetainsEpisodeArchitectureAllocation(t *testing.T) {
	m := productionManifest{FrameID: "frame", Plan: &productionPlan{Version: 4, StoryStructureVersion: 1}}
	doc := map[string]any{"nodes": []any{map[string]any{"id": "frame", "metadata": map[string]any{"shortDrama": map[string]any{"parameters": map[string]any{"episodeCount": 100.0}}}}}}
	budget := productionDocumentWorkBudget(m, doc, productionParallelWork{Key: "story"})
	if budget.SuggestedFieldChars["episodeArchitecture"] <= budget.SuggestedFieldChars["facts"]*10 {
		t.Fatal("per-episode rows lost their existing dynamic content allocation")
	}
	encoded, err := json.Marshal(budget)
	if err != nil || !strings.Contains(string(encoded), "batchMaxContentChars") {
		t.Fatal("budget is not serializable")
	}
}

func TestProductionDocumentBudgetMetadataRepairCanRecoverOversizedOriginal(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	fields := orderedPlanDocument("visual", "")
	fields["style"] = strings.Repeat("具体规范", 6500)
	settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "expectedHash": "wrong-source-version", "factIds": []string{}, "document": fields})
	work = enqueueDocumentPart(t, s, runID, "visual")
	if len(work.DocumentParts.Pending[0]) != 0 {
		t.Fatal("version repair should reuse valid original chapters")
	}
	finishDocumentPart(t, s, db, runID, work)
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if !reflect.DeepEqual(work.DocumentParts.Pending, [][]string{{"style"}}) || work.DocumentParts.RepairFields["style"] != fields["style"] {
		t.Fatal("oversized original got stuck in repeated metadata acknowledgements")
	}
	work = enqueueDocumentPart(t, s, runID, "visual")
	finishDocumentPart(t, s, db, runID, work)
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "visual") {
		t.Fatal("repaired version and length did not pass final validation")
	}
}
