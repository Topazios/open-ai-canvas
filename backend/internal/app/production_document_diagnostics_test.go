package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestProductionDocumentDiagnosticsLocateEnvelopeAndValueErrors(t *testing.T) {
	for _, test := range []struct {
		name, raw, field, issue string
		contains                []string
	}{
		{"nestedMetadata", `{"key":"generation","name":"生成规范","document":{"prompt":"保留原稿","factIds":[],"expectedHash":""}}`, "document", "misplaced_arguments", []string{"factIds", "expectedHash", "根层级", "保留全部正文章节"}},
		{"nestedIdentity", `{"document":{"facts":"保留正文","key":"direction","name":"导演规范"}}`, "document", "misplaced_arguments", []string{"key", "name", "根层级"}},
		{"arrayChapter", `{"document":{"prompt":[]}}`, "document.prompt", "field_type", []string{"prompt", "字符串"}},
		{"objectChapter", `{"document":{"facts":{}}}`, "document.facts", "field_type", []string{"facts", "字符串"}},
		{"nullChapter", `{"document":{"facts":null}}`, "document.facts", "field_type", []string{"null", "字符串"}},
		{"numberChapter", `{"document":{"facts":42}}`, "document.facts", "field_type", []string{"字符串"}},
		{"nullDocument", `{"document":null}`, "document", "field_type", []string{"JSON 对象"}},
		{"arrayDocument", `{"document":[]}`, "document", "field_type", []string{"JSON 对象"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := productionDocumentArgumentsError(test.raw)
			requireProductionPlanDocumentError(t, err, test.field, test.issue)
			for _, want := range test.contains {
				if !strings.Contains(cloudAgentSafeToolError(err), want) {
					t.Fatalf("missing actionable diagnostic %q: %v", want, err)
				}
			}
		})
	}
	for _, raw := range []string{`{}`, `{"document":{}}`, `{"key":"generation","factIds":[],"expectedHash":"","document":{"prompt":"原稿正文","design":"旧模板合法字段"}}`} {
		if err := productionDocumentArgumentsError(raw); err != nil {
			t.Fatalf("valid string fields rejected: %v", err)
		}
	}
}

func TestProductionDocumentDiagnosticsRejectUnknownKeysWithoutDroppingProse(t *testing.T) {
	for _, test := range productionPlanDocumentCases {
		t.Run(test.key, func(t *testing.T) {
			document := productionPlanDocumentFixture(test.fields)
			document["key"] = "direction"
			document["_note"] = "必须保留的制作要求"
			before, _ := json.Marshal(document)
			_, err := productionRenderPlanDocument(test.key, test.kind, document)
			requireProductionPlanDocumentError(t, err, "document", "unknown_fields")
			if !strings.Contains(err.Error(), `"key"`) || !strings.Contains(err.Error(), `"_note"`) || !strings.Contains(err.Error(), "根层级") {
				t.Fatalf("unknown field names or repair location omitted: %v", err)
			}
			after, _ := json.Marshal(document)
			if string(after) != string(before) {
				t.Fatal("diagnostics changed the submitted prose")
			}
		})
	}
}

func TestProductionDocumentDiagnosticsPartRejectsMisplacedMetadataWithoutCheckpointMutation(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	m, doc, rows := orderedPlanState(t, s, runID)
	work := productionParallelWork{Key: "visual", Name: "视觉与美术规范", Dependencies: productionParallelDependencyHash(m, rows, "visual")}
	if err := productionSplitDocumentParts(m, doc, rows, &work); err != nil {
		t.Fatal(err)
	}
	for _, variant := range []string{"nestedMetadata", "unknownChapter"} {
		t.Run(variant, func(t *testing.T) {
			fields := map[string]any{}
			for _, field := range work.DocumentParts.Pending[0] {
				fields[field] = "有效且应保留的制作要求"
			}
			issue := "misplaced_arguments"
			if variant == "nestedMetadata" {
				fields["factIds"], fields["expectedHash"] = []string{}, ""
			} else {
				fields["_note"] = "不能静默丢弃的正文"
				issue = "part_fields"
			}
			args := map[string]any{"key": work.Key, "name": work.Name, "document": fields, "factIds": []string{}, "expectedHash": ""}
			encoded, _ := json.Marshal(args)
			call := productionRuntimeCall("production_submit")
			call.Function.Arguments = string(encoded)
			before := productionHash(work.DocumentParts)
			_, _, err := productionStageDocumentParts(m, doc, rows, &work, call)
			requireProductionPlanDocumentError(t, err, "document", issue)
			if productionHash(work.DocumentParts) != before {
				t.Fatal("rejected arguments changed checkpoint")
			}
		})
	}
}

func TestProductionDocumentDiagnosticsHeadingAndFenceAreDistinct(t *testing.T) {
	section := productionDocumentSection{"facts", "生成依据与交付约束"}
	for _, test := range []struct{ body, contains, issue string }{
		{"已定依据\n## 生成依据与交付约束\n实际内容", "## 生成依据与交付约束", "invalid_heading"},
		{"```text\n实际内容", "未闭合", "unclosed_fence"},
	} {
		err := productionValidatePlanField("generation", "", section, test.body)
		requireProductionPlanDocumentError(t, err, "document.facts", test.issue)
		if !strings.Contains(err.Error(), test.contains) {
			t.Fatalf("missing exact structural defect: %v", err)
		}
	}
	valid := "### 依据\n实际内容\n```text\n## 代码示例\n```"
	if err := productionValidatePlanField("generation", "", section, valid); err != nil {
		t.Fatal(err)
	}
	if got := productionDocumentDiagnosticKeys([]string{"z", "a"}); !reflect.DeepEqual(got, `"a", "z"`) {
		t.Fatal("diagnostic key order is unstable", got)
	}
}

func TestProductionDocumentDiagnosticsRetainRawDraftAcrossRetryAndRestart(t *testing.T) {
	for _, partial := range []bool{false, true} {
		name := "full"
		if partial {
			name = "partial"
		}
		t.Run(name, func(t *testing.T) {
			s, db, runID := parallelPlanFixture(t)
			work := enqueueDocumentPart(t, s, runID, "visual")
			if partial {
				productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ForceThinkingOff = true })
				work.DisableThinking = true
				failDocumentPart(t, s, db, runID, work)
				work = enqueueDocumentPart(t, s, runID, "visual")
			}
			document := map[string]any{}
			for key, value := range orderedPlanDocument("visual", "") {
				if !partial || cloudAgentContainsString(work.DocumentParts.Pending[0], key) {
					document[key] = value
				}
			}
			document["facts"] = "必须保留的原稿事实与制作约束。"
			document["factIds"], document["expectedHash"] = []string{}, ""
			before := productionHash(mustPlanArtifacts(t, s, runID))
			checkpoint := productionHash(work.DocumentParts)
			settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "document": document})
			_, state := productionRuntimeState(t, s, runID)
			work = state.ProductionParallel["visual"]
			if string(work.RepairDocumentRaw["factIds"]) != "[]" || string(work.RepairDocumentRaw["expectedHash"]) != `""` || !strings.Contains(string(work.RepairDocumentRaw["facts"]), "必须保留的原稿事实") {
				t.Fatalf("rejected draft was dropped or its types were changed: %+v", work.RepairDocumentRaw)
			}
			if productionHash(work.DocumentParts) != checkpoint || productionHash(mustPlanArtifacts(t, s, runID)) != before {
				t.Fatal("rejected raw JSON became an accepted checkpoint or artifact")
			}
			s = &Service{repo: s.repo, dataDir: s.dataDir, disablePiRuntime: true}
			work = enqueueDocumentPart(t, s, runID, "visual")
			task, _ := s.repo.Task(work.TaskID)
			if !strings.Contains(task.InputJSON, "必须保留的原稿事实") || !strings.Contains(task.InputJSON, "repairDocumentFields") || !strings.Contains(task.InputJSON, "根层级") {
				t.Fatal("retry omitted original raw content or field correction")
			}
			if partial {
				finishDocumentPart(t, s, db, runID, work)
				_, state = productionRuntimeState(t, s, runID)
				if len(state.ProductionParallel["visual"].RepairDocumentRaw) != 0 {
					t.Fatal("corrected batch retained stale raw repair context")
				}
				work = enqueueDocumentPart(t, s, runID, "visual")
				finishDocumentPart(t, s, db, runID, work)
			} else {
				settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "document": orderedPlanDocument("visual", ""), "factIds": []string{}, "expectedHash": ""})
			}
			m, doc, rows := orderedPlanState(t, s, runID)
			if !productionPlanArtifactValid(m, doc, rows, "visual") {
				t.Fatal("explicit corrected submission failed the ordinary full validator")
			}
		})
	}
}

func TestProductionDocumentDiagnosticsRetainInvalidChapterTypeAndSerialErrors(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	document := map[string]any{}
	for key, value := range orderedPlanDocument("visual", "") {
		document[key] = value
	}
	document["prompt"] = []string{"必须保留并由模型明确修正的原稿提示词"}
	args := map[string]any{"key": work.Key, "name": work.Name, "document": document, "factIds": []string{}, "expectedHash": ""}
	before := productionHash(mustPlanArtifacts(t, s, runID))
	result := productionCall(t, s, runID, "production_submit", args, true)
	if result["requiredAction"] != "fix_arguments" || !strings.Contains(stringValue(result["error"]), "prompt") || !strings.Contains(stringValue(result["error"]), "字符串") {
		t.Fatalf("serial submission lost field type diagnostic: %#v", result)
	}
	settleDocumentReply(t, s, db, runID, work, args)
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	var prompt []string
	if json.Unmarshal(work.RepairDocumentRaw["prompt"], &prompt) != nil || !reflect.DeepEqual(prompt, document["prompt"]) {
		t.Fatal("invalid chapter array was dropped or coerced")
	}
	if productionHash(mustPlanArtifacts(t, s, runID)) != before || work.DocumentParts != nil {
		t.Fatal("invalid chapter type was saved or accepted as a checkpoint")
	}
}

func TestProductionDocumentDiagnosticsRetainFullyNestedIdentityOnlyForAssignedWork(t *testing.T) {
	for _, consistent := range []bool{true, false} {
		name := "matching"
		if !consistent {
			name = "differentWork"
		}
		t.Run(name, func(t *testing.T) {
			s, db, runID := parallelPlanFixture(t)
			work := enqueueDocumentPart(t, s, runID, "visual")
			document := map[string]any{"key": work.Key, "name": work.Name, "factIds": []string{}, "expectedHash": "", "facts": "完全嵌套提交中必须保留的原稿"}
			if !consistent {
				document["key"] = "differentWork"
			}
			before := productionHash(mustPlanArtifacts(t, s, runID))
			settleDocumentReply(t, s, db, runID, work, map[string]any{"document": document})
			_, state := productionRuntimeState(t, s, runID)
			work = state.ProductionParallel["visual"]
			if (len(work.RepairDocumentRaw) > 0) != consistent || work.DocumentParts != nil || productionHash(mustPlanArtifacts(t, s, runID)) != before {
				t.Fatal("nested identity was accepted, incorrectly bound, or draft lost")
			}
			if consistent {
				s = &Service{repo: s.repo, dataDir: s.dataDir, disablePiRuntime: true}
				work = enqueueDocumentPart(t, s, runID, "visual")
				task, _ := s.repo.Task(work.TaskID)
				if !strings.Contains(task.InputJSON, "完全嵌套提交中必须保留的原稿") || !strings.Contains(task.InputJSON, "根层级") {
					t.Fatal("service boundary dropped fully nested original draft")
				}
			}
		})
	}
}

func TestProductionDocumentDiagnosticsKeepAssetDesignAsPrivateDraftUntilExplicitResubmission(t *testing.T) {
	for _, partial := range []bool{false, true} {
		name := "full"
		if partial {
			name = "partial"
		}
		t.Run(name, func(t *testing.T) {
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
				state.ForceThinkingOff = true
				state.ProductionParallel = map[string]productionParallelWork{"character": {Key: "character", Name: productionPlanItem(m, "character").Name, Dependencies: productionParallelDependencyHash(m, rows, "character")}}
			})
			work := enqueueDocumentPart(t, s, runID, "character")
			if partial {
				work.DisableThinking = true
				failDocumentPart(t, s, db, runID, work)
				work = enqueueDocumentPart(t, s, runID, "character")
			}
			design := &productionDesignFields{
				Variants: []productionDesignVariant{{Name: "受伤状态", Description: "右臂包扎，服装保留既定配色", Source: "design", Basis: "制作设计补充", Trigger: "右臂受伤后", PreviousState: "日常状态", Scope: "受伤后至康复前", Recovery: "治疗康复后恢复日常状态"}},
				Sounds:   []string{"原稿中的人物声音关联"}, Conflicts: []string{"原稿中的冲突说明"},
			}
			fields := map[string]any{}
			for key, value := range orderedPlanDocument("character", "character") {
				if !partial || cloudAgentContainsString(work.DocumentParts.Pending[0], key) {
					fields[key] = value
				}
			}
			fields["facts"] = []string{"需要明确修正类型的原稿事实"}
			before := productionHash(mustPlanArtifacts(t, s, runID))
			checkpoint := productionHash(work.DocumentParts)
			settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "document": fields, "factIds": []string{}, "expectedHash": "", "design": design})
			_, state := productionRuntimeState(t, s, runID)
			work = state.ProductionParallel["character"]
			if !reflect.DeepEqual(work.RepairDesign, design) || len(work.RepairDocumentRaw) == 0 || productionHash(work.DocumentParts) != checkpoint || productionHash(mustPlanArtifacts(t, s, runID)) != before {
				t.Fatal("asset design draft was dropped or accepted before correction")
			}
			s = &Service{repo: s.repo, dataDir: s.dataDir, disablePiRuntime: true}
			work = enqueueDocumentPart(t, s, runID, "character")
			task, _ := s.repo.Task(work.TaskID)
			for _, want := range []string{"repairDesign", "受伤状态", "原稿中的人物声音关联", "原稿中的冲突说明", "显式提交"} {
				if !strings.Contains(task.InputJSON, want) {
					t.Fatalf("retry omitted design context %s", want)
				}
			}
			if partial {
				finishDocumentPart(t, s, db, runID, work)
				_, state = productionRuntimeState(t, s, runID)
				if !reflect.DeepEqual(state.ProductionParallel["character"].RepairDesign, design) || state.ProductionParallel["character"].DocumentParts.RepairDesign != nil {
					t.Fatal("private design draft became an accepted design or was dropped after one batch")
				}
				work = enqueueDocumentPart(t, s, runID, "character")
			}
			corrected := map[string]string{}
			for key, value := range orderedPlanDocument("character", "character") {
				if !partial || cloudAgentContainsString(work.DocumentParts.Pending[0], key) {
					corrected[key] = value
				}
			}
			settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "document": corrected, "factIds": []string{}, "expectedHash": "", "design": design})
			m, doc, rows := orderedPlanState(t, s, runID)
			if !productionPlanArtifactValid(m, doc, rows, "character") {
				t.Fatal("explicit design resubmission bypassed or failed full validation")
			}
			for _, row := range rows {
				if row.Key != "character" {
					continue
				}
				profile := productionWorkflow(productionNode(doc, row.NodeID))["assetProfile"]
				encoded, _ := json.Marshal(profile)
				var saved productionDesignFields
				if json.Unmarshal(encoded, &saved) != nil || len(saved.Variants) != 1 || saved.Variants[0].Name != design.Variants[0].Name || !reflect.DeepEqual(saved.Conflicts, design.Conflicts) {
					t.Fatal("explicitly resubmitted structured design was lost")
				}
			}
		})
	}
}
