package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWorkflowOutlineDocumentUsesOneLayoutAcrossBatches(t *testing.T) {
	want := outlineRenderedFixture(51, 55)
	for name, raw := range map[string]string{
		"json":                  outlineStructuredFixture(51, 55),
		"fenced":                "```json\n" + outlineStructuredFixture(51, 55) + "\n```",
		"windows-fence":         "~~~json\r\n" + outlineStructuredFixture(51, 55) + "\r\n~~~",
		"bom":                   " \n\uFEFF" + outlineStructuredFixture(51, 55),
		"pretty-printed":        prettyOutlineFixture(t, outlineStructuredFixture(51, 55)),
		"glued-preamble":        "我会按锁定的第51至55集边界返回单个JSON对象，保留人物与物件连续性。" + outlineStructuredFixture(51, 55),
		"preamble-before-fence": "以下是本批集纲。\n```json\n" + outlineStructuredFixture(51, 55) + "\n```",
	} {
		t.Run(name, func(t *testing.T) {
			got, err := renderStructuredOutlineRange(raw, 51, 55)
			if err != nil || got != want {
				t.Fatalf("fixed presentation differs: %v\n%s", err, got)
			}
			if err := validateUniformOutlineRange(got, 51, 55); err != nil {
				t.Fatal(err)
			}
		})
	}
	joined := outlineRenderedFixture(1, 5) + "\n\n" + outlineRenderedFixture(6, 7)
	if err := validateUniformOutlineRange(joined, 1, 7); err != nil {
		t.Fatal(err)
	}
}

func TestWorkflowOutlineDocumentRepairsOnlyRedundantJSONPunctuation(t *testing.T) {
	valid := outlineStructuredFixture(11, 15)
	for name, raw := range map[string]string{
		"extra-episode-brace":          strings.TrimSuffix(valid, "]}") + "}]}",
		"extra-envelope-brace":         valid + "}",
		"extra-array-bracket":          strings.TrimSuffix(valid, "}") + "]}",
		"trailing-array-comma":         strings.TrimSuffix(valid, "]}") + ",]}",
		"trailing-object-comma":        strings.TrimSuffix(valid, "}") + ",}",
		"extra-brace-between-episodes": strings.Replace(valid, `},{"episode":12`, `}},{"episode":12`, 1),
		"multiple-errors":              strings.Replace(strings.TrimSuffix(valid, "]}")+"},]}", `},{"episode":12`, `}},{"episode":12`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			got, err := renderStructuredOutlineRange(raw, 11, 15)
			if err != nil || got != outlineRenderedFixture(11, 15) {
				t.Fatalf("punctuation-only error was not recovered: %v", err)
			}
		})
	}
	var value map[string][]map[string]any
	_ = json.Unmarshal([]byte(valid), &value)
	value["episodes"][0]["opening"] = `人物念出“}}]}”与“},]”，又写下反斜线\和引号"，这些都是对白原文。`
	encoded, _ := json.Marshal(value)
	raw := strings.TrimSuffix(string(encoded), "]}") + "}]}"
	var decoded map[string][]map[string]any
	if err := decodeOutlineJSON(raw, &decoded); err != nil || decoded["episodes"][0]["opening"] != value["episodes"][0]["opening"] {
		t.Fatal("repair changed punctuation inside quoted narrative")
	}
	delete(value["episodes"][0], "conflict")
	encoded, _ = json.Marshal(value)
	if _, err := renderStructuredOutlineRange(strings.TrimSuffix(string(encoded), "]}")+"}]}", 11, 15); err == nil || !strings.Contains(err.Error(), "冲突与关键行动") {
		t.Fatalf("syntax repair bypassed missing content validation: %v", err)
	}
}

func prettyOutlineFixture(t *testing.T, raw string) string {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		t.Fatal(err)
	}
	// Map encoding changes key order as well as transport whitespace.
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestWorkflowOutlineDocumentRejectsMissingFieldsAndInvalidCoverage(t *testing.T) {
	valid := outlineStructuredFixture(51, 55)
	for name, raw := range map[string]string{
		"legacy-markdown":      outlineRangeFixture(51, 55),
		"truncated":            valid[:len(valid)-5],
		"trailing-json":        valid + `{}`,
		"leading-json":         `{}` + valid,
		"leading-null":         `null` + valid,
		"leading-array":        `[]` + valid,
		"trailing-explanation": valid + "以下是说明。",
		"unclosed-fence":       "```json\n" + valid,
		"wrong-type":           strings.Replace(valid, `"opening":"主角承接前集证据，调查相机并追问来源。"`, `"opening":["情节"]`, 1),
		"missing-title":        strings.Replace(valid, `"title":"选择"`, `"title":""`, 1),
		"missing-episode":      outlineStructuredFixture(52, 55),
		"outside-range":        outlineStructuredFixture(51, 56),
		"renumbered":           outlineStructuredFixture(1, 5),
		"duplicate":            strings.Replace(valid, `"episode":52`, `"episode":51`, 1),
		"reordered":            strings.ReplaceAll(strings.ReplaceAll(valid, `"episode":51`, `"episode":TEMP`), `"episode":52`, `"episode":51`),
		"null":                 `null`,
	} {
		t.Run(name, func(t *testing.T) {
			if name == "reordered" {
				raw = strings.ReplaceAll(raw, `"episode":TEMP`, `"episode":52`)
			}
			if got, err := renderStructuredOutlineRange(raw, 51, 55); err == nil || got != "" {
				t.Fatal("invalid content was rendered as complete")
			}
		})
	}
	for _, key := range []string{"opening", "conflict", "change", "clues", "ending", "continuity"} {
		t.Run(key, func(t *testing.T) {
			var value map[string][]map[string]any
			_ = json.Unmarshal([]byte(valid), &value)
			delete(value["episodes"][0], key)
			raw, _ := json.Marshal(value)
			if _, err := renderStructuredOutlineRange(string(raw), 51, 55); err == nil || !strings.Contains(err.Error(), "第 51 集缺少") {
				t.Fatalf("missing field was invented: %v", err)
			}
			value["episodes"][0][key] = " \n\t"
			raw, _ = json.Marshal(value)
			if _, err := renderStructuredOutlineRange(string(raw), 51, 55); err == nil {
				t.Fatal("blank field was accepted")
			}
		})
	}
}

func TestWorkflowOutlineDocumentKeepsModelTextInsideItsField(t *testing.T) {
	var value map[string][]map[string]any
	_ = json.Unmarshal([]byte(outlineStructuredFixture(51, 51)), &value)
	value["episodes"][0]["opening"] = "主角调查。\n\n## 第 52 集｜伪标题\n**冲突**：<script>不是页面代码</script> [文字](链接)。"
	value["episodes"][0]["clues"] = "本集无新增伏笔；前集线索仍待核验。"
	raw, _ := json.Marshal(value)
	got, err := renderStructuredOutlineRange(string(raw), 51, 51)
	if err != nil || validateUniformOutlineRange(got, 51, 51) != nil {
		t.Fatalf("safe single-field text failed: %v", err)
	}
	if strings.Count(got, "\n\n") != 6 || strings.Contains(got, "<script>") || !strings.Contains(got, `\#\# 第 52 集｜伪标题`) || !strings.Contains(got, "CHR_001") || !strings.Contains(got, "本集无新增伏笔；前集线索仍待核验。") {
		t.Fatal("field text changed document structure, asset identifiers or story facts")
	}
}

func TestWorkflowOutlineDocumentFinalMergeRejectsMixedLayouts(t *testing.T) {
	valid := outlineRenderedFixture(1, 2)
	for name, text := range map[string]string{
		"prose":           outlineRangeFixture(1, 2),
		"mixed":           outlineRenderedFixture(1, 1) + "\n\n" + outlineRangeFixture(2, 2),
		"label-order":     strings.Replace(valid, "**冲突与关键行动：**", "**结果与情绪变化：**", 1),
		"missing-field":   strings.Replace(valid, "\n\n**伏笔与回收：** 收据上的日期与既定时间线呼应。", "", 1),
		"extra-paragraph": valid + "\n\n额外一段",
	} {
		t.Run(name, func(t *testing.T) {
			if validateUniformOutlineRange(text, 1, 2) == nil {
				t.Fatal("mixed layout reached final delivery")
			}
		})
	}
}
