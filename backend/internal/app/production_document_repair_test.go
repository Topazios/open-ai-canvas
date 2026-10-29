package app

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func settleDocumentReply(t *testing.T, s *Service, db *gorm.DB, runID string, work productionParallelWork, args any) {
	t.Helper()
	call := productionRuntimeCall("production_submit")
	if raw, ok := args.(string); ok {
		call.Function.Arguments = raw
	} else {
		encoded, err := json.Marshal(args)
		if err != nil {
			t.Fatal(err)
		}
		call.Function.Arguments = string(encoded)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": productionRuntimeResult(t, call)}).Error; err != nil {
		t.Fatal(err)
	}
	task, err := s.repo.Task(work.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.settleProductionParallel("user", runID, work, task); err != nil {
		t.Fatal(err)
	}
}

func TestProductionDocumentRepairPinsSubmissionSchema(t *testing.T) {
	for _, hash := range []string{"", "current-target-version"} {
		for _, partial := range []bool{false, true} {
			next := map[string]any{"key": "visual", "name": "视觉与美术规范", "documentSchemaVersion": 2, "arguments": map[string]any{"expectedHash": hash}}
			if partial {
				next["documentFields"] = []string{}
			}
			tools := productionRuntimeTools(productionManifest{Plan: &productionPlan{Version: 4}}, map[string]any{"nextAction": next})
			for _, tool := range tools {
				fn := tool["function"].(map[string]any)
				if fn["name"] != "production_submit" {
					continue
				}
				parameters := fn["parameters"].(map[string]any)
				properties := parameters["properties"].(map[string]any)
				for field, value := range map[string]string{"key": "visual", "name": "视觉与美术规范", "expectedHash": hash} {
					if !reflect.DeepEqual(properties[field].(map[string]any)["enum"], []string{value}) {
						t.Fatalf("%s is not pinned to %q: %+v", field, value, properties[field])
					}
				}
				if !cloudAgentContainsString(parameters["required"].([]string), "expectedHash") || properties["factIds"].(map[string]any)["maxItems"] != 0 {
					t.Fatal("unconstrained version or evidence references")
				}
				if partial && len(properties["document"].(map[string]any)["properties"].(map[string]any)) != 0 {
					t.Fatal("metadata repair requested the whole document again")
				}
			}
		}
	}
}

func TestProductionDocumentRepairSeparatesJSONAndIdentityErrors(t *testing.T) {
	hash := ""
	work := productionParallelWork{Key: "visual", Name: "视觉与美术规范", TargetHash: &hash}
	for _, test := range []struct{ raw, contains string }{
		{`{"key":"visual","name":`, "JSON"},
		{`null`, "单个 JSON 对象"},
		{`{"key":"other","name":"视觉与美术规范"}`, "key"},
		{`{"key":"visual","name":"other"}`, "name"},
		{`{"key":"visual","name":"视觉与美术规范","expectedHash":"source-version"}`, "新建文稿"},
	} {
		call := productionRuntimeCall("production_submit")
		call.Function.Arguments = test.raw
		err := productionParallelCallError(work, call, "production_submit")
		if err == nil || !strings.Contains(cloudAgentSafeToolError(err), test.contains) {
			t.Fatalf("wrong failure classification for %s: %v", test.raw, err)
		}
		if strings.Contains(test.contains, "JSON") && strings.Contains(err.Error(), "key/name") {
			t.Fatal("malformed JSON was reported as an identity mismatch")
		}
	}
}

func TestProductionDocumentRepairVersionOnlyReusesAllChapters(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	before := productionHash(mustPlanArtifacts(t, s, runID))
	document := orderedPlanDocument("visual", "")
	settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "expectedHash": "source-version", "factIds": []string{}, "document": document})
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if work.DocumentParts == nil || len(work.DocumentParts.Pending) != 1 || len(work.DocumentParts.Pending[0]) != 0 || !reflect.DeepEqual(work.DocumentParts.Fields, document) || !strings.Contains(work.Correction, "新建文稿") {
		t.Fatalf("version-only repair did not retain complete chapters: %+v", work)
	}
	if productionHash(mustPlanArtifacts(t, s, runID)) != before {
		t.Fatal("rejected version changed canvas artifacts")
	}
	work = enqueueDocumentPart(t, s, runID, "visual")
	task, _ := s.repo.Task(work.TaskID)
	if strings.Contains(task.InputJSON, "acceptedDocumentFields") || strings.Contains(task.InputJSON, "requiredDocuments") || strings.Contains(task.InputJSON, "registeredAssets") {
		t.Fatal("metadata-only acknowledgement resent document bodies or the asset library")
	}
	finishDocumentPart(t, s, db, runID, work)
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "visual") {
		t.Fatal("metadata acknowledgement failed full validation")
	}
	for _, row := range rows {
		if row.Key == "visual" {
			content, _ := productionRenderPlanDocument("visual", "", document)
			meta := productionNode(doc, row.NodeID)["metadata"].(map[string]any)
			if meta["content"] != content {
				t.Fatal("metadata repair changed previously generated text")
			}
		}
	}
}

func TestProductionDocumentRepairRetainsGoodFieldsForTargetedRetry(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	document := orderedPlanDocument("visual", "")
	document["style"] = "## 不允许的标题\n完整的美术设计内容。"
	settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "document": document, "factIds": []string{}})
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if work.DocumentParts == nil || !reflect.DeepEqual(work.DocumentParts.Pending, [][]string{{"style"}}) || len(work.DocumentParts.Fields) != len(document)-1 || work.DocumentParts.RepairFields["style"] != document["style"] {
		t.Fatalf("unrelated valid fields were discarded: %+v", work)
	}
	work = enqueueDocumentPart(t, s, runID, "visual")
	finishDocumentPart(t, s, db, runID, work)
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "visual") {
		t.Fatal("single-field repair did not finish the original document")
	}
}

func TestProductionDocumentRepairPreservesUnknownContentAndStopsRepeatedErrors(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	before := productionHash(mustPlanArtifacts(t, s, runID))
	work := enqueueDocumentPart(t, s, runID, "visual")
	for attempt := 1; attempt <= cloudAgentToolAttemptLimit; attempt++ {
		document := orderedPlanDocument("visual", "")
		document["_note"] = "额外说明包含不能默默丢弃的制作要求。"
		settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "document": document, "factIds": []string{}})
		_, state := productionRuntimeState(t, s, runID)
		work = state.ProductionParallel["visual"]
		if work.RepairDocument["_note"] != document["_note"] || work.DocumentParts != nil || productionHash(mustPlanArtifacts(t, s, runID)) != before {
			t.Fatal("unknown prose silently disappeared or was saved")
		}
		if attempt < cloudAgentToolAttemptLimit && work.Error != "" {
			t.Fatalf("stopped before repair allowance: %+v", work)
		}
		if attempt == cloudAgentToolAttemptLimit && (!strings.Contains(work.Error, "当前制作项累计") || work.ValidationAttempts != attempt) {
			t.Fatalf("same invalid contract kept retrying: %+v", work)
		}
		if attempt < cloudAgentToolAttemptLimit {
			work = enqueueDocumentPart(t, s, runID, "visual")
			task, _ := s.repo.Task(work.TaskID)
			if !strings.Contains(task.InputJSON, document["_note"]) {
				t.Fatal("retry omitted original content requiring reconciliation")
			}
		}
	}
}

func TestProductionDocumentRepairRejectsChangedTargetAndKeepsDesign(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, runID, key, "", key)
	}
	startPlanAssetsForTest(t, s, runID)
	if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
		t.Fatal(err)
	}
	m, _, rows := orderedPlanState(t, s, runID)
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
		state.ProductionParallel = map[string]productionParallelWork{"character": {Key: "character", Name: productionPlanItem(m, "character").Name, Dependencies: productionParallelDependencyHash(m, rows, "character")}}
	})
	work := enqueueDocumentPart(t, s, runID, "character")
	design := &productionDesignFields{Sounds: []string{"固定声音设计"}}
	settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "document": orderedPlanDocument(work.Key, "character"), "factIds": []string{}, "expectedHash": "wrong-version", "design": design})
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["character"]
	if work.DocumentParts == nil || !reflect.DeepEqual(work.DocumentParts.RepairDesign, design) {
		t.Fatal("asset metadata repair lost structured design")
	}
	work = enqueueDocumentPart(t, s, runID, "character")
	finishDocumentPart(t, s, db, runID, work)
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "character") {
		t.Fatal("asset design repair failed")
	}
	run, state := productionRuntimeState(t, s, runID)
	old := "outdated-version"
	work = productionParallelWork{Key: "visual", Name: "视觉与美术规范", Dependencies: productionParallelDependencyHash(m, rows, "visual"), TargetHash: &old}
	tasksBefore := len(state.TaskIDs)
	err := s.enqueueProductionParallel(run, &state, m, doc, rows, work)
	if err == nil || !strings.Contains(err.Error(), "目标文稿版本已变化") || len(state.TaskIDs) != tasksBefore {
		t.Fatal("stale target admitted a new model request", err)
	}
}

func TestProductionDocumentRepairKeepsSafeDetailedDiagnostics(t *testing.T) {
	message := strings.Repeat("关系称谓与登记不一致；请保留主体、客体和方向。", 16)
	err := cloudAgentFieldError("document.relationships", "relationship_conflict", message)
	if cloudAgentSafeToolError(err) != message {
		t.Fatal("long structured diagnostic was replaced with a generic error")
	}
	for _, unsafe := range []string{"https://internal.invalid/secret", "authorization=secret", "\nstack trace", "api_key=secret"} {
		if got := cloudAgentSafeToolError(cloudAgentFieldError("document", "unsafe", message+unsafe)); strings.Contains(got, unsafe) || got == message+unsafe {
			t.Fatal("unsafe data was exposed", got)
		}
	}
	if _, err := productionRenderPlanDocument("visual", "", orderedPlanDocument("visual", "")); err != nil {
		t.Fatal(err)
	}
	var typed *cloudAgentFieldArgumentError
	if !errors.As(productionDocumentVersionArgumentError(""), &typed) || typed.Field != "expectedHash" {
		t.Fatal("version failure is no longer machine classified")
	}
}

func TestProductionDocumentRepairReopensEarlierInvalidAssetReference(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ForceThinkingOff = true })
	work := enqueueDocumentPart(t, s, runID, "visual")
	failDocumentPart(t, s, db, runID, work)
	work = enqueueDocumentPart(t, s, runID, "visual")
	document := map[string]string{}
	for _, field := range work.DocumentParts.Pending[0] {
		document[field] = "明确的制作规范。"
	}
	document["style"] = "沿用未登记的资产 @CHR-9999。"
	settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "document": document, "factIds": []string{}})
	work = enqueueDocumentPart(t, s, runID, "visual")
	finishDocumentPart(t, s, db, runID, work)
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if work.DocumentParts == nil || !reflect.DeepEqual(work.DocumentParts.Pending, [][]string{{"style"}}) || work.DocumentParts.RepairFields["style"] != document["style"] || len(mustPlanArtifacts(t, s, runID)) != 2 {
		t.Fatalf("earlier invalid reference was lost or the final check was bypassed: %+v", work)
	}
	work = enqueueDocumentPart(t, s, runID, "visual")
	finishDocumentPart(t, s, db, runID, work)
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "visual") {
		t.Fatal("reference repair did not pass the full final validator")
	}
}

func TestProductionDocumentRepairLocatesRelationshipConflictInActualField(t *testing.T) {
	s, db, run := planFixture(t, 3)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	document := orderedPlanDocument("story", "")
	document["relationships"] = "REL-001 | 主体：角色甲 | 客体：角色乙 | 类型：siblings | 方向：older_sister_younger_brother | 规范称呼：姐姐与弟弟 | 来源：制作设计 | 适用范围：全剧"
	story := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "总纲", "document": document}, false)
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{StoryHash: stringValue(story["hash"]), Complete: true,
		Assets: []productionPlanAsset{
			{Key: "first", Kind: "character", Name: "角色甲", Purpose: "主要角色", PlannedRange: "全剧"},
			{Key: "second", Kind: "character", Name: "角色乙", Purpose: "主要角色", PlannedRange: "全剧"},
		}, Absent: map[string]string{"environment": "无独立场景", "prop": "无独立道具", "sound": "无独立声音"}}, false)
	work := enqueueDocumentPart(t, s, run.ID, "direction")
	document = orderedPlanDocument("direction", "")
	document["performance"] = "REL-001 | 主体：角色甲 | 客体：角色乙 | 类型：rivals | 方向：bidirectional | 规范称呼：对手 | 来源：制作设计 | 适用范围：全剧"
	settleDocumentReply(t, s, db, run.ID, work, map[string]any{"key": work.Key, "name": work.Name, "document": document, "factIds": []string{}})
	_, state := productionRuntimeState(t, s, run.ID)
	work = state.ProductionParallel["direction"]
	if work.DocumentParts == nil || !reflect.DeepEqual(work.DocumentParts.Pending, [][]string{{"performance"}}) || work.DocumentParts.RepairFields["performance"] != document["performance"] {
		t.Fatalf("conflict pointed to a nonexistent relationships field: %+v", work)
	}
	work = enqueueDocumentPart(t, s, run.ID, "direction")
	finishDocumentPart(t, s, db, run.ID, work)
	m, doc, rows := orderedPlanState(t, s, run.ID)
	if !productionPlanArtifactValid(m, doc, rows, "direction") {
		t.Fatal("relationship repair failed full validation")
	}
}
