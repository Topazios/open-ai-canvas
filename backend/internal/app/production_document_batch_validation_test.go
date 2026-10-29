package app

import (
	"encoding/json"
	"reflect"
	"testing"
)

func productionDocumentIssueFields(err error) []string {
	fields := []string{}
	for _, issue := range cloudAgentValidationIssues(err) {
		fields = append(fields, issue.Field+":"+issue.Issue)
	}
	return fields
}

func TestProductionDocumentBatchValidationReportsAllChaptersWithoutChangingDraft(t *testing.T) {
	document := orderedPlanDocument("visual", "")
	document["facts"] = ""
	document["style"] = "## 章节内重复标题\n完整原稿。"
	document["palette"] = "待完善"
	document["lighting"] = "```text\n未闭合的原稿"
	document["composition"] = "### 只有标题"
	before := productionHash(document)
	content, err := productionRenderPlanDocument("visual", "", document)
	want := []string{"document.facts:missing_sections", "document.style:invalid_heading", "document.palette:placeholder_content", "document.lighting:unclosed_fence", "document.composition:missing_sections"}
	if content != "" || !reflect.DeepEqual(productionDocumentIssueFields(err), want) {
		t.Fatalf("incomplete chapter diagnostics: %v, content=%q", productionDocumentIssueFields(err), content)
	}
	if productionHash(document) != before {
		t.Fatal("validation changed rejected prose")
	}
}

func TestProductionDocumentBatchValidationIncludesUnknownAndKnownDefects(t *testing.T) {
	document := orderedPlanDocument("direction", "")
	document["_note"] = "需人工合并的原稿。"
	document["pacing"] = "待确认"
	_, err := productionRenderPlanDocument("direction", "", document)
	want := []string{"document:unknown_fields", "document.pacing:placeholder_content"}
	if !reflect.DeepEqual(productionDocumentIssueFields(err), want) || document["_note"] == "" {
		t.Fatalf("unknown content hid other diagnostics: %v", err)
	}
}

func TestProductionDocumentBatchValidationCoversEveryRuleTemplate(t *testing.T) {
	for _, test := range productionPlanDocumentCases {
		t.Run(test.key, func(t *testing.T) {
			document := productionPlanDocumentFixture(test.fields)
			sections := productionPlanDocumentSections(test.key, test.kind)
			document[sections[0].Key] = "待补充"
			document[sections[1].Key] = "## 多余模板标题\n保留原稿。"
			_, err := productionRenderPlanDocument(test.key, test.kind, document)
			want := []string{"document." + sections[0].Key + ":placeholder_content", "document." + sections[1].Key + ":invalid_heading"}
			if !reflect.DeepEqual(productionDocumentIssueFields(err), want) {
				t.Fatalf("rule template omitted diagnostics: %v", productionDocumentIssueFields(err))
			}
		})
	}
}

func TestProductionDocumentBatchValidationAggregatesChapterTypes(t *testing.T) {
	err := productionDocumentArgumentsError(`{"document":{"factIds":[],"style":[],"facts":null,"palette":42,"prompt":"保留原稿"}}`)
	want := []string{"document:misplaced_arguments", "document.facts:field_type", "document.palette:field_type", "document.style:field_type"}
	if !reflect.DeepEqual(productionDocumentIssueFields(err), want) {
		t.Fatalf("incomplete type diagnostics: %v", productionDocumentIssueFields(err))
	}
	if issues := cloudAgentValidationIssues(productionDocumentArgumentsError(`{"document":[]}`)); len(issues) != 1 || issues[0].Field != "document" {
		t.Fatal("invalid document root was treated as chapter errors")
	}
}

func TestProductionDocumentBatchValidationPartsStayAtomic(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	m, doc, rows := orderedPlanState(t, s, runID)
	work := productionParallelWork{Key: "visual", Name: "视觉与美术规范", Dependencies: productionParallelDependencyHash(m, rows, "visual")}
	if err := productionSplitDocumentParts(m, doc, rows, &work); err != nil {
		t.Fatal(err)
	}
	fields := map[string]string{}
	for _, field := range work.DocumentParts.Pending[0] {
		fields[field] = "有效制作规范。"
	}
	fields["facts"] = ""
	fields["style"] = "## 多余标题\n需要保留的原稿。"
	fields["palette"] = "待定"
	encoded, _ := json.Marshal(map[string]any{"key": work.Key, "name": work.Name, "document": fields, "factIds": []string{"unsupported"}, "expectedHash": ""})
	call := productionRuntimeCall("production_submit")
	call.Function.Arguments = string(encoded)
	before := productionHash(work.DocumentParts)
	staged, _, err := productionStageDocumentParts(m, doc, rows, &work, call)
	want := []string{"document.facts:part_fields", "document.style:invalid_heading", "document.palette:placeholder_content", "factIds:part_facts"}
	if staged || !reflect.DeepEqual(productionDocumentIssueFields(err), want) || productionHash(work.DocumentParts) != before {
		t.Fatalf("partial errors mutated checkpoint or hid defects: %v", productionDocumentIssueFields(err))
	}
}

func TestProductionDocumentBatchRepairRetainsAllRejectedChapters(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	document := orderedPlanDocument("visual", "")
	document["style"] = "## 多余标题\n保留美术原稿。"
	document["palette"] = "待确认"
	document["lighting"] = "```text\n保留照明原稿。"
	before := productionHash(mustPlanArtifacts(t, s, runID))
	settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "document": document, "factIds": []string{}, "expectedHash": ""})
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if work.DocumentParts == nil || !reflect.DeepEqual(work.DocumentParts.Pending, [][]string{{"style", "palette", "lighting"}}) || len(work.DocumentParts.Fields) != len(document)-3 {
		t.Fatalf("repair did not isolate all affected chapters: %+v", work.DocumentParts)
	}
	for _, field := range []string{"style", "palette", "lighting"} {
		if work.DocumentParts.RepairFields[field] != document[field] {
			t.Fatalf("rejected %s prose was lost", field)
		}
	}
	if productionHash(mustPlanArtifacts(t, s, runID)) != before {
		t.Fatal("rejected draft changed artifacts")
	}
	work = enqueueDocumentPart(t, s, runID, "visual")
	finishDocumentPart(t, s, db, runID, work)
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "visual") {
		t.Fatal("combined chapter repair failed full validation")
	}
}

func TestProductionDocumentBatchRepairReopensEveryEarlierField(t *testing.T) {
	work := productionParallelWork{DocumentParts: &productionDocumentParts{
		Fields:  map[string]string{"style": "原稿风格", "palette": "原稿配色", "sound": "保留的声音"},
		Pending: [][]string{{}},
	}}
	failure := cloudAgentValidationErrors(
		cloudAgentFieldError("document.style", "asset_reference", "修正风格引用"),
		cloudAgentFieldError("document.palette", "relationship_conflict", "修正配色冲突"),
		cloudAgentFieldError("document.style", "other_conflict", "风格中的另一问题"),
	)
	productionReopenDocumentField(&work, failure)
	if !reflect.DeepEqual(work.DocumentParts.Pending, [][]string{{"style", "palette"}}) || !reflect.DeepEqual(work.DocumentParts.Fields, map[string]string{"sound": "保留的声音"}) || !reflect.DeepEqual(work.DocumentParts.RepairFields, map[string]string{"style": "原稿风格", "palette": "原稿配色"}) {
		t.Fatalf("not all affected earlier chapters reopened: %+v", work.DocumentParts)
	}
}

func TestProductionDocumentBatchRawMixedDefectsReachFullAndPartsReceipts(t *testing.T) {
	for _, partial := range []bool{false, true} {
		name := "full"
		if partial {
			name = "parts"
		}
		t.Run(name, func(t *testing.T) {
			s, _, runID := parallelPlanFixture(t)
			m, doc, rows := orderedPlanState(t, s, runID)
			work := productionParallelWork{Key: "visual", Name: "视觉与美术规范", Dependencies: productionParallelDependencyHash(m, rows, "visual")}
			fields := map[string]any{}
			for key, value := range orderedPlanDocument("visual", "") {
				fields[key] = value
			}
			fields["facts"] = []string{"原始类型和正文必须保留"}
			fields["style"] = "## 重复模板标题\n原稿必须保留。"
			fields["palette"] = "待确认"
			delete(fields, "lighting")
			args := map[string]any{"key": work.Key, "name": work.Name, "document": fields, "expectedHash": "", "factIds": []string{}}
			before := productionHash(mustPlanArtifacts(t, s, runID))
			missingIssue := "missing_sections"
			var got []string
			if partial {
				if err := productionSplitDocumentParts(m, doc, rows, &work); err != nil {
					t.Fatal(err)
				}
				for key := range fields {
					if !cloudAgentContainsString(work.DocumentParts.Pending[0], key) {
						delete(fields, key)
					}
				}
				encoded, _ := json.Marshal(args)
				call := productionRuntimeCall("production_submit")
				call.Function.Arguments = string(encoded)
				checkpoint := productionHash(work.DocumentParts)
				_, _, err := productionStageDocumentParts(m, doc, rows, &work, call)
				got = productionDocumentIssueFields(err)
				missingIssue = "part_fields"
				if productionHash(work.DocumentParts) != checkpoint {
					t.Fatal("mixed invalid raw fields changed checkpoint")
				}
			} else {
				result := productionCall(t, s, runID, "production_submit", args, true)
				encoded, _ := json.Marshal(result["validationIssues"])
				var issues []cloudAgentValidationIssue
				if json.Unmarshal(encoded, &issues) != nil {
					t.Fatal("invalid validation receipt")
				}
				for _, issue := range issues {
					got = append(got, issue.Field+":"+issue.Issue)
				}
			}
			want := []string{"document.facts:field_type", "document.style:invalid_heading", "document.palette:placeholder_content", "document.lighting:" + missingIssue}
			if !reflect.DeepEqual(got, want) || productionHash(mustPlanArtifacts(t, s, runID)) != before || !reflect.DeepEqual(fields["facts"], []string{"原始类型和正文必须保留"}) {
				t.Fatalf("mixed raw diagnostics lost defects or changed draft: %v", got)
			}
		})
	}
}

func TestProductionDocumentBatchSameChapterHasDistinctRepairIssues(t *testing.T) {
	err := productionValidatePlanField("visual", "", productionDocumentSection{Key: "style", Title: "整体视觉风格与媒介质感"}, "## 多余标题\n```text\n保留原稿")
	want := []string{"document.style:invalid_heading", "document.style:unclosed_fence"}
	if !reflect.DeepEqual(productionDocumentIssueFields(err), want) {
		t.Fatalf("two independent repairs collapsed into one: %v", productionDocumentIssueFields(err))
	}
}

func TestProductionDocumentBatchRawVersionAndRootRemainBlocking(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	m, doc, rows := orderedPlanState(t, s, runID)
	work := productionParallelWork{Key: "visual", Name: "视觉与美术规范", Dependencies: productionParallelDependencyHash(m, rows, "visual")}
	if err := productionSplitDocumentParts(m, doc, rows, &work); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		`{"expectedHash":"wrong-version","document":{"facts":[]}}`,
		`{"expectedHash":null,"document":{"facts":[]}}`,
		`{"expectedHash":""}`,
		`{"expectedHash":"","document":[]}`,
	} {
		call := productionRuntimeCall("production_submit")
		call.Function.Arguments = raw
		before := productionHash(work.DocumentParts)
		staged, _, err := productionStageDocumentParts(m, doc, rows, &work, call)
		issues := cloudAgentValidationIssues(err)
		if staged || len(issues) != 1 || productionHash(work.DocumentParts) != before {
			t.Fatalf("blocking version/root error mutated or inspected chapters: %v", issues)
		}
	}
	result := productionCall(t, s, runID, "production_submit", map[string]any{"key": work.Key, "name": work.Name, "expectedHash": "wrong-version", "document": map[string]any{"facts": []string{"原稿"}, "style": "待完善"}}, true)
	encoded, _ := json.Marshal(result["validationIssues"])
	var issues []cloudAgentValidationIssue
	_ = json.Unmarshal(encoded, &issues)
	if len(issues) != 1 || issues[0].Field != "expectedHash" {
		t.Fatalf("full submission inspected stale version chapters: %v", issues)
	}
}
