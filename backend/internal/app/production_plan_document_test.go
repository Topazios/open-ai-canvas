package app

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

var productionPlanDocumentCases = []struct {
	key, kind, fields string
}{
	{"story", "", "facts premise motivation world worldRules conflict plot arcs characterArcs relationships ending foreshadowing continuity uncertainties"},
	{"visual", "", "facts style palette lighting composition characterDesign environmentDesign propDesign specialDesign referenceLayout sound prompt negativePrompt continuity uncertainties"},
	{"direction", "", "facts narrative pacing blocking camera editing performance voiceDirection music ambience soundEffects sound prompt negativePrompt continuity uncertainties"},
	{"generation", "", "facts workflow identityRules referenceRules promptStructure imageConstraints videoConstraints sound stateTransitions qualityChecks repairStrategy prompt negativePrompt continuity uncertainties"},
	{"inventory", "", "facts design continuity uncertainties"},
	{"registered-person", "character", "facts role personality motivation backstory relationships characterArc appearance costume hairMakeup performance variants sound voiceTimbre voiceRange voicePace voiceAccent voicePerformance voicePrompt prompt negativePrompt continuity uncertainties"},
	{"registered-place", "environment", "facts function eraLocation layout entrances spatialRelations materials lighting cameraPositions variants sound prompt negativePrompt continuity uncertainties"},
	{"registered-object", "prop", "facts function appearance materials ownership mechanism interaction variants sound prompt negativePrompt continuity uncertainties"},
	{"registered-effect", "special", "facts function form triggers abilities limits cost visualEffects variants sound prompt negativePrompt continuity uncertainties"},
	{"registered-audio", "sound", "facts soundType subjectReferences sound timbre rhythm emotion spatial cues mixing variants prompt negativePrompt continuity uncertainties"},
}

func productionPlanDocumentFixture(fields string) map[string]string {
	document := map[string]string{}
	for _, field := range strings.Fields(fields) {
		document[field] = "明确制作设计：" + field + "\n补充执行细节。"
	}
	return document
}

func requireProductionPlanDocumentError(t *testing.T, err error, field, issue string) {
	t.Helper()
	var argument *cloudAgentFieldArgumentError
	if !errors.As(err, &argument) || argument.Field != field || argument.Issue != issue {
		t.Fatalf("want repairable %s/%s error, got %v", field, issue, err)
	}
}

func TestProductionPlanDocumentSchemas(t *testing.T) {
	for _, test := range productionPlanDocumentCases {
		t.Run(test.key, func(t *testing.T) {
			sections := productionPlanDocumentSections(test.key, test.kind)
			keys, titles := []string{}, map[string]bool{}
			for _, section := range sections {
				keys = append(keys, section.Key)
				if strings.TrimSpace(section.Title) == "" || titles[section.Title] || strings.ContainsAny(section.Title, "\r\n") {
					t.Fatalf("empty, duplicate or multiline title: %#v", section)
				}
				titles[section.Title] = true
			}
			if !reflect.DeepEqual(keys, strings.Fields(test.fields)) {
				t.Fatalf("contract changed: got %v, want %s", keys, test.fields)
			}
			sections[0].Key = "changed-by-tool-builder"
			if productionPlanDocumentSections(test.key, test.kind)[0].Key != "facts" {
				t.Fatal("schema exposes shared mutable state")
			}
		})
	}
}

func TestProductionPlanDocumentRenderAndRequiredFields(t *testing.T) {
	for _, test := range productionPlanDocumentCases {
		t.Run(test.key, func(t *testing.T) {
			document := productionPlanDocumentFixture(test.fields)
			document["facts"] = "  选题依据；当前版本 v2。\r\n计划出场第1集。  "
			before := document["facts"]
			content, err := productionRenderPlanDocument(test.key, test.kind, document)
			if err != nil {
				t.Fatal(err)
			}
			if document["facts"] != before {
				t.Fatal("renderer mutated caller's document")
			}
			if missing := productionPlanDocumentMissing(test.key, test.kind, content); len(missing) != 0 {
				t.Fatalf("rendered document incomplete: %v", missing)
			}
			parts := []string{}
			for _, section := range productionPlanDocumentSections(test.key, test.kind) {
				parts = append(parts, "## "+section.Title+"\n"+strings.TrimSpace(document[section.Key]))
			}
			if content != strings.Join(parts, "\n\n") {
				t.Fatal("renderer lost text or changed canonical heading order")
			}
			reordered := map[string]string{}
			fields := strings.Fields(test.fields)
			for i := len(fields) - 1; i >= 0; i-- {
				reordered[fields[i]] = document[fields[i]]
			}
			again, err := productionRenderPlanDocument(test.key, test.kind, reordered)
			if err != nil || again != content {
				t.Fatal("map insertion order changes rendered content")
			}
			for _, section := range productionPlanDocumentSections(test.key, test.kind) {
				t.Run(section.Key, func(t *testing.T) {
					original := document[section.Key]
					defer func() { document[section.Key] = original }()
					delete(document, section.Key)
					if rendered, err := productionRenderPlanDocument(test.key, test.kind, document); rendered != "" || err == nil {
						t.Fatal("renderer accepted a missing required field")
					} else {
						requireProductionPlanDocumentError(t, err, "document", "missing_sections")
						if !strings.Contains(err.Error(), section.Key+"（"+section.Title+"）") {
							t.Fatal("repair error omits field key/title", err)
						}
					}
					document[section.Key] = " \t\r\n\u3000 "
					if _, err := productionRenderPlanDocument(test.key, test.kind, document); err == nil {
						t.Fatal("renderer accepted whitespace as content")
					}
					block := "## " + section.Title + "\n" + strings.TrimSpace(original)
					for _, replacement := range []string{"", "## " + section.Title + "\n \t\r\n", "## " + section.Title + "\n### 只有子标题"} {
						incomplete := strings.Replace(content, block, replacement, 1)
						if missing := productionPlanDocumentMissing(test.key, test.kind, incomplete); !reflect.DeepEqual(missing, []string{section.Key}) {
							t.Fatalf("want only %s missing, got %v", section.Key, missing)
						}
					}
				})
			}
		})
	}
}

func TestProductionPlanDocumentRejectsUnknownFieldsAndSchemas(t *testing.T) {
	for _, test := range productionPlanDocumentCases {
		t.Run(test.key, func(t *testing.T) {
			document := productionPlanDocumentFixture(test.fields)
			for _, extra := range []string{"undeclared", "Facts", "facts ", ""} {
				document[extra] = "must not silently disappear"
				content, err := productionRenderPlanDocument(test.key, test.kind, document)
				requireProductionPlanDocumentError(t, err, "document", "unknown_fields")
				if content != "" || document[extra] != "must not silently disappear" {
					t.Fatal("invalid render emitted content or mutated input")
				}
				delete(document, extra)
			}
		})
	}
	for _, test := range [][2]string{{"", "character"}, {" C001", "character"}, {"$summary", "character"}, {"C001", ""}, {"C001", "characters"}, {"C001", "unknown"}, {"story", "character"}, {"inventory", "prop"}, {"visual", "unknown"}} {
		if sections := productionPlanDocumentSections(test[0], test[1]); len(sections) != 0 {
			t.Fatalf("unknown schema accepted: %v", test)
		}
		content, err := productionRenderPlanDocument(test[0], test[1], nil)
		requireProductionPlanDocumentError(t, err, "document", "unknown_schema")
		if content != "" || !reflect.DeepEqual(productionPlanDocumentMissing(test[0], test[1], ""), []string{"$schema"}) {
			t.Fatalf("unknown schema passed validation: %v", test)
		}
	}
}

func TestProductionPlanDocumentLegacyCompatibilityAndRepair(t *testing.T) {
	for _, test := range productionPlanDocumentCases {
		if test.key == "inventory" {
			continue // System-maintained index has no legacy template.
		}
		t.Run(test.key, func(t *testing.T) {
			legacy := map[string]string{}
			for _, section := range productionDocumentSections("plan", test.key) {
				legacy[section.Key] = "原有制作内容，修订必须保留。"
			}
			legacy["extra"] = "旧格式允许未声明字段"
			content, err := productionRenderDocument("plan", test.key, legacy)
			if err != nil || len(productionDocumentMissing("plan", test.key, content)) != 0 {
				t.Fatalf("legacy contract changed: %v", err)
			}
			missing := productionPlanDocumentMissing(test.key, test.kind, content)
			if len(missing) == 0 {
				t.Fatal("generic legacy content passed the strict v2 contract")
			}
			// Repair callers retain the old node and expectedHash; these helpers
			// only describe/re-render the fields and do not migrate stored prose.
			repaired := productionPlanDocumentFixture(test.fields)
			repaired["facts"] = "原有制作内容，修订必须保留。"
			updated, err := productionRenderPlanDocument(test.key, test.kind, repaired)
			if err != nil || !strings.Contains(updated, repaired["facts"]) || len(productionPlanDocumentMissing(test.key, test.kind, updated)) != 0 {
				t.Fatalf("repaired v2 document failed: %v", err)
			}
		})
	}
}

func TestProductionPlanDocumentCannotUseAnotherAssetKind(t *testing.T) {
	character := productionPlanDocumentCases[5]
	document := productionPlanDocumentFixture(character.fields)
	content, err := productionRenderPlanDocument("custom-key", "character", document)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"environment", "prop", "special", "sound"} {
		if len(productionPlanDocumentMissing("custom-key", kind, content)) == 0 {
			t.Fatalf("character passed %s schema", kind)
		}
		_, err := productionRenderPlanDocument("custom-key", kind, document)
		requireProductionPlanDocumentError(t, err, "document", "unknown_fields")
	}
	delete(document, "voiceAccent")
	document["sound"] = "音色、音域、语速、口音、表演和配音提示词全部塞在这里。"
	if _, err := productionRenderPlanDocument("custom-key", "character", document); err == nil {
		t.Fatal("generic sound summary replaced a required voice subdivision")
	}
}

func TestProductionPlanDocumentHeadingAndFenceValidation(t *testing.T) {
	test := productionPlanDocumentCases[0]
	document := productionPlanDocumentFixture(test.fields)
	for _, value := range []string{"说明\n## 明确结局与人物最终归宿\n伪造完成", "说明\r\n  ## 明确结局与人物最终归宿", "# 新文稿", "```\n未闭合", "~~~text\n未闭合"} {
		document["facts"] = value
		_, err := productionRenderPlanDocument(test.key, test.kind, document)
		requireProductionPlanDocumentError(t, err, "document.facts", "invalid_section")
	}
	for _, value := range []string{"### 空子标题", "```\n```", "~~~\n~~~"} {
		document["facts"] = value
		_, err := productionRenderPlanDocument(test.key, test.kind, document)
		requireProductionPlanDocumentError(t, err, "document", "missing_sections")
	}
	document["facts"] = "正文\r\n### 细分依据\r\n保留细节\n````markdown\n## 示例标题\n```\n````\n~~~text\n## 另一示例\n~~~"
	content, err := productionRenderPlanDocument(test.key, test.kind, document)
	if err != nil || len(productionPlanDocumentMissing(test.key, test.kind, content)) != 0 {
		t.Fatalf("valid nested headings/fences failed: %v", err)
	}
	for _, suffix := range []string{"\n\n## 结局安排、本季收束与开放悬念\n重复结局", "\n\n## 结局安排、本季收束与开放悬念\n"} {
		if missing := productionPlanDocumentMissing(test.key, test.kind, content+suffix); !reflect.DeepEqual(missing, []string{"ending"}) {
			t.Fatalf("duplicate ending accepted: %v", missing)
		}
	}
	ending := "## 结局安排、本季收束与开放悬念\n" + document["ending"]
	fake := strings.Replace(content, ending, "```markdown\n"+ending+"\n```", 1)
	if missing := productionPlanDocumentMissing(test.key, test.kind, fake); !reflect.DeepEqual(missing, []string{"ending"}) {
		t.Fatalf("fenced heading counted as a required section: %v", missing)
	}
	if missing := productionPlanDocumentMissing(test.key, test.kind, "旧稿正文\n### 随意标题"); !reflect.DeepEqual(missing, strings.Fields(test.fields)) {
		t.Fatalf("missing fields not in deterministic contract order: %v", missing)
	}
	if missing := productionPlanDocumentMissing(test.key, test.kind, content+"\n```\nunclosed"); !reflect.DeepEqual(missing, []string{"uncertainties"}) {
		t.Fatalf("unclosed final field not reported for repair: %v", missing)
	}
}
