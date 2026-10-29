package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestProductionInventoryBatchReportsEveryInspectableDefect(t *testing.T) {
	plan, doc, rows := inventoryReviewFixture(t)
	plan.InventoryReview = plan.InventoryReview[:len(plan.InventoryReview)-1]
	for i := range plan.InventoryReview {
		if plan.InventoryReview[i].Section != "plot" {
			continue
		}
		for j := range plan.InventoryReview[i].Requirements {
			plan.InventoryReview[i].Requirements[j].Quote = "并非当前总纲的引文"
		}
		plan.InventoryReview[i].Requirements[1].AssetKey = "unregistered"
		plan.InventoryReview[i].Requirements[2].Disposition = "invented"
	}
	plan.Assets[0].SubjectKeys = []string{"unknown", "hero"}
	before := productionHash([]any{plan, doc, rows})
	err := productionValidateInventoryReview(plan, doc, "root", rows, true)
	issues := cloudAgentValidationIssues(err)
	counts := map[string]int{}
	for _, issue := range issues {
		counts[issue.Issue]++
	}
	for issue, want := range map[string]int{"invalid_source_quote": 3, "unregistered_requirement": 1, "invalid_disposition": 1, "unknown_subject": 2, "missing_source_sections": 1, "missing_asset_source": 3} {
		if counts[issue] != want {
			t.Fatalf("%s count=%d want=%d; issues=%+v", issue, counts[issue], want, issues)
		}
	}
	if productionHash([]any{plan, doc, rows}) != before {
		t.Fatal("diagnostic collection mutated source or proposed registry")
	}
	partial := cloudAgentValidationIssues(productionValidateInventoryReview(plan, doc, "root", rows, false))
	for _, issue := range partial {
		if issue.Issue == "missing_source_sections" || issue.Issue == "missing_asset_source" {
			t.Fatal("partial checkpoint was required to cover all sources", partial)
		}
	}
	corrected, correctedDoc, correctedRows := inventoryReviewFixture(t)
	if err := productionValidateInventoryReview(corrected, correctedDoc, "root", correctedRows, true); err != nil {
		t.Fatal("one corrected proposal did not recover", err)
	}
}

func TestProductionInventoryBatchKeepsSourceGateAndAvoidsFalseQuoteMismatch(t *testing.T) {
	plan, doc, rows := inventoryReviewFixture(t)
	plan.InventoryReview[0].Section = "unknown-source"
	plan.InventoryReview[0].NoAssetsReason = ""
	plan.InventoryReview[0].Requirements = []productionInventoryRequirement{{Subject: "对象", Quote: "无法检查所属来源", Reason: "待核对", AssetKey: "unknown", Disposition: "asset"}}
	issues := cloudAgentValidationIssues(productionValidateInventoryReview(plan, doc, "root", rows, false))
	if len(issues) != 2 || issues[0].Issue != "invalid_section" || issues[1].Issue != "unregistered_requirement" {
		t.Fatal("invalid source invented quote evidence or hid independent mapping error", issues)
	}
	productionNode(doc, "story-node")["metadata"].(map[string]any)["content"] = "不同版本的故事"
	issues = cloudAgentValidationIssues(productionValidateInventoryReview(plan, doc, "root", rows, true))
	if len(issues) != 1 || issues[0].Issue != "source_changed" {
		t.Fatal("changed source was treated as a repairable quote mismatch", issues)
	}
}

func TestProductionInventoryQuoteIgnoresFormattingButPreservesSourceWords(t *testing.T) {
	source := "小林走进雨夜的车站，发现一把红伞。"
	for _, quote := range []string{"小林 走进雨夜的车站，发现一把红伞。", "小林走进雨夜的车站，\n发现一把红伞。"} {
		if !productionInventoryQuoteMatches(source, quote) {
			t.Fatalf("format-only source quote rejected: %q", quote)
		}
	}
	for _, quote := range []string{"小林走进雨夜的车站发现一把红伞", "小林走进车站，发现一把红伞。", "红伞发现小林走进车站", "小王走进雨夜的车站，发现一把红伞。", "他不去。"} {
		if productionInventoryQuoteMatches(source, quote) {
			t.Fatalf("changed source wording accepted: %q", quote)
		}
	}
	if productionInventoryQuoteMatches("他不，去。", "他不去。") {
		t.Fatal("semantic punctuation was discarded during verbatim quote matching")
	}
}

func TestProductionInventoryAppendIsExactlyIdempotent(t *testing.T) {
	base := productionInventoryRequirement{Subject: "主角", Quote: "主角进门。", AssetKey: "hero", Disposition: "asset", Reason: "承担动作。"}
	added := productionInventoryRequirement{Subject: "住户", Quote: "住户开门。", AssetKey: "resident", Disposition: "asset", Reason: "承担动作。"}
	plan := productionPlan{InventoryReview: []productionInventorySectionReview{{Section: "plot", Requirements: []productionInventoryRequirement{base}}}}
	batch := []productionInventorySectionReview{{Section: "plot", Append: true, Requirements: []productionInventoryRequirement{base, added, added}}}

	merged, err := productionPreviewInventoryReview(plan, batch)
	if err != nil || len(merged) != 1 || len(merged[0].Requirements) != 2 {
		t.Fatalf("append did not deduplicate exact evidence tuples: requirements=%+v err=%v", merged, err)
	}
	plan.InventoryReview = merged
	replayed, err := productionPreviewInventoryReview(plan, batch)
	if err != nil || len(replayed[0].Requirements) != 2 {
		t.Fatalf("replayed append changed the durable evidence set: requirements=%+v err=%v", replayed, err)
	}

	changedReason := added
	changedReason.Reason = "作为独立表演主体。"
	replayed, err = productionPreviewInventoryReview(plan, []productionInventorySectionReview{{Section: "plot", Append: true, Requirements: []productionInventoryRequirement{changedReason}}})
	if err != nil || len(replayed[0].Requirements) != 3 {
		t.Fatalf("five-field identity collapsed distinct evidence: requirements=%+v err=%v", replayed, err)
	}
}

func TestProductionInventoryBatchPreviewReportsDuplicateAndOtherSectionErrors(t *testing.T) {
	plan, doc, rows := inventoryReviewFixture(t)
	before := productionHash(plan)
	batch := []productionInventorySectionReview{{Section: "plot", NoAssetsReason: "无新增"}, {Section: "plot", NoAssetsReason: "冲突不能采用"}, {Section: "world", Requirements: []productionInventoryRequirement{{Subject: "对象", Quote: "错误引文", Disposition: "asset", AssetKey: "unknown", Reason: "用途"}}}}
	preview, duplicate := productionPreviewInventoryReview(plan, batch)
	if duplicate == nil || productionHash(plan) != before {
		t.Fatal("conflicting review was accepted or mutated checkpoint")
	}
	plan.InventoryReview = preview
	err := cloudAgentValidationErrors(duplicate, productionValidateInventoryReview(plan, doc, "root", rows, false))
	issues := cloudAgentValidationIssues(err)
	if len(issues) != 3 || issues[0].Issue != "duplicate_section" || issues[1].Issue != "invalid_source_quote" || issues[2].Issue != "unregistered_requirement" {
		t.Fatal("duplicate section hid safe checks from other sections", issues)
	}
}

func TestProductionInventoryBatchReportsAllInvalidDependencyEdges(t *testing.T) {
	plan := productionPlan{Assets: []productionPlanAsset{{Key: "a", Kind: "character", Purpose: "用途", PlannedRange: "全程", DependsOn: []string{"b", "missing-a"}}, {Key: "b", Kind: "character", Purpose: "用途", PlannedRange: "全程", DependsOn: []string{"a", "missing-b"}}, {Key: "c", Kind: "character", Purpose: "用途", PlannedRange: "全程", DependsOn: []string{"c"}}}, Absent: map[string]string{"environment": "无场景", "prop": "无道具", "sound": "无声音", "special": "无特殊资产"}}
	issues := cloudAgentValidationIssues(productionValidatePlanInventory(plan))
	if len(issues) != 5 {
		t.Fatalf("not all broken edges were reported: %+v", issues)
	}
	paths := map[string]bool{}
	for _, issue := range issues {
		paths[issue.Field] = true
	}
	if len(paths) != 5 {
		t.Fatal("distinct dependency repairs lost their exact path", issues)
	}
	plan.Assets[0].DependsOn, plan.Assets[1].DependsOn, plan.Assets[2].DependsOn = []string{"b"}, nil, nil
	if err := productionValidatePlanInventory(plan); err != nil {
		t.Fatal("batch correction failed", err)
	}
}

func TestCloudAgentBatchValidationReceiptBoundsBytesWithoutHidingCounts(t *testing.T) {
	for _, count := range []int{30, 10000} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			failures := make([]error, count)
			for i := range failures {
				failures[i] = cloudAgentFieldError(fmt.Sprintf("inventoryReview[0].requirements[%d].quote", i), "invalid_source_quote", "请按本节原文逐字补全证据并保留主体与动作")
			}
			err := cloudAgentValidationErrors(failures...)
			if len(cloudAgentValidationIssues(err)) != count || cloudAgentSafeToolError(err) == "工具执行失败，请检查输入或稍后重试" {
				t.Fatal("long batch collapsed to a generic error or lost internal issues")
			}
			detail := map[string]any{}
			cloudAgentValidationReceipt(detail, err)
			items := detail["validationIssues"].([]cloudAgentValidationIssue)
			encoded, _ := json.Marshal(items)
			if len(encoded) > cloudAgentValidationReceiptMaxBytes || detail["validationIssueCount"] != count || detail["validationIssuesOmitted"] != count-len(items) {
				t.Fatalf("invalid byte budget or report counts: %d bytes, %v", len(encoded), detail)
			}
			if count == 30 && len(items) != count {
				t.Fatal("normal multi-problem report was unnecessarily truncated")
			}
			if count == 10000 && (detail["validationReportComplete"] != false || !strings.Contains(stringValue(detail["guidance"]), "不得进入下一步骤")) {
				t.Fatal("oversized report silently claimed full feedback")
			}
		})
	}
	upstream := providerHTTPError{StatusCode: 429}
	err := cloudAgentValidationErrors(cloudAgentFieldError("x", "invalid", "修正参数"), upstream)
	var preserved providerHTTPError
	if !errors.As(err, &preserved) || len(cloudAgentValidationIssues(err)) != 0 {
		t.Fatal("real upstream failure was converted into model argument repair", err)
	}
}

func TestCloudAgentBatchValidationReceiptKeepsWarningsAndModelFeedback(t *testing.T) {
	state := cloudAgentRuntime{}
	call := productionRuntimeCall("production_plan_inventory")
	err := cloudAgentValidationErrors(cloudAgentFieldError("inventoryReview[0].requirements[0].quote", "invalid_source_quote", "第一处引文需逐字核对"), cloudAgentFieldError("inventoryReview[1].requirements[1].quote", "invalid_source_quote", "第二处引文需逐字核对"))
	cloudAgentToolResult("run", &state, call, nil, err)
	if len(state.Canonical.Messages) != 1 {
		t.Fatal("missing next-model tool receipt")
	}
	content := stringValue(state.Canonical.Messages[0]["content"])
	var detail map[string]any
	if json.Unmarshal([]byte(content), &detail) != nil || detail["severity"] != "warning" || detail["validationIssueCount"] != float64(2) || !strings.Contains(content, "第二处引文") || !strings.Contains(content, "全部校验通过前禁止进入下一步骤") {
		t.Fatal("next model did not receive the complete warning batch", content)
	}
}

func TestProductionReferenceAndContinuityItemsKeepStableRepairIdentity(t *testing.T) {
	manifest := productionManifest{Plan: &productionPlan{Assets: []productionPlanAsset{{Key: "hero", Kind: "character", Identity: &productionAssetIdentity{Code: "CHR-D001-001", Kind: "character"}}}}}
	err := productionValidatePlanReferences(manifest, map[string]any{}, nil, "引用 @SCN-D001-001，随后又引用 @PRP-D001-002；合法引用 @CHR-D001-001")
	issues := cloudAgentValidationIssues(err)
	if len(issues) != 2 || issues[0].Field == issues[1].Field {
		t.Fatal("unknown reference codes were not independently repairable", issues)
	}
	remaining := productionValidatePlanReferences(manifest, map[string]any{}, nil, "仅剩 @PRP-D001-002")
	if len(cloudAgentValidationIssues(remaining)) != 1 || productionHash(productionValidationProblems(issues, "")) == productionHash(productionValidationProblems(cloudAgentValidationIssues(remaining), "")) {
		t.Fatal("correcting one reference did not register progress")
	}
	first := productionRelationshipIssueIdentity("REL-001 的结构化关系事实不一致", 0)
	second := productionRelationshipIssueIdentity("REL-002 的结构化关系事实不一致", 1)
	if first == second || productionEpisodeArchitectureIssueField("逐集规划第2集第3项内容为空或仍是占位语") == productionEpisodeArchitectureIssueField("逐集规划第4集第3项内容为空或仍是占位语") {
		t.Fatal("distinct rows collapsed to the same repair identity")
	}
}
