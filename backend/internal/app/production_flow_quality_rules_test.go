package app

import (
	"fmt"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestProductionFlowReviewSingleRecordEvidence(t *testing.T) {
	ref := "flow/story/episode/0001"
	u := model.ProductionFlowUnit{Stage: "review", InputJSON: productionFlowJSON(map[string]any{"sources": map[string]any{ref: map[string]any{"storyText": "照片已经用完。她又使用了同一照片。"}}}), ResultJSON: "{}"}
	issue := productionFlowIssue{Target: ref, Rule: "once", Message: "同集内重复使用", Action: "保留一次机会并调整后续行动", Severity: "blocking", Basis: "contradiction", Evidence: []productionFlowEvidence{{Ref: ref, Quote: "照片已经用完。"}, {Ref: ref, Quote: "她又使用了同一照片。"}}}
	for _, single := range []bool{false, true} {
		if single {
			issue.Basis = "rule_violation"
			issue.Evidence = issue.Evidence[1:]
		}
		result, failures := productionFlowValidate(u, productionFlowJSON(map[string]any{"issues": []productionFlowIssue{issue}}))
		if len(failures) != 0 || !strings.Contains(result, `"severity":"blocking"`) {
			t.Fatal("valid same-record evidence downgraded", result, failures)
		}
	}
	issue.Basis = "contradiction"
	result, _ := productionFlowValidate(u, productionFlowJSON(map[string]any{"issues": []productionFlowIssue{issue}}))
	if !strings.Contains(result, `"severity":"advisory"`) {
		t.Fatal("one quote alone proved a two-sided contradiction")
	}
	quote := "纸条写着\"明天\"。\n她记下日期。"
	input := map[string]any{"sources": map[string]any{ref: map[string]any{"continuityFacts": []map[string]string{{"subject": "纸条", "before": "未读", "after": "已读", "quote": quote}}}}}
	u.InputJSON = productionFlowJSON(input)
	issue.Basis = "rule_violation"
	issue.Evidence = []productionFlowEvidence{{Ref: ref, Quote: quote}}
	result, failures := productionFlowValidate(u, productionFlowJSON(map[string]any{"issues": []productionFlowIssue{issue}}))
	if len(failures) != 0 || !strings.Contains(result, `"severity":"blocking"`) {
		t.Fatal("nested index escaped a valid original quote", result, failures)
	}
}

func TestProductionFlowCoverageCannotDeclareKnownCategoryAbsent(t *testing.T) {
	input := map[string]any{"covered": []productionFlowCandidate{{ID: "actor", Kind: "character"}}}
	rows := []productionFlowCoverage{}
	for _, kind := range productionCurrentPlanKinds {
		rows = append(rows, productionFlowCoverage{Kind: kind, Disposition: "none", Reason: "核对后没有需求", Candidates: []string{}})
	}
	if issues := productionFlowValidateCoverage([]byte(productionFlowJSON(rows)), input, nil); len(issues) != 1 {
		t.Fatal("contradictory no-assets declaration accepted", issues)
	}
	rows[0].Disposition, rows[0].Candidates = "covered", []string{"actor"}
	if issues := productionFlowValidateCoverage([]byte(productionFlowJSON(rows)), input, nil); len(issues) != 0 {
		t.Fatal(issues)
	}
	rows[0].Candidates = []string{"invented"}
	if issues := productionFlowValidateCoverage([]byte(productionFlowJSON(rows)), input, nil); len(issues) == 0 {
		t.Fatal("invented coverage accepted")
	}
}

func TestProductionFlowCandidateRelationshipsResolveToStableIDs(t *testing.T) {
	src := productionFlowSource{ID: "source", Text: "林岚打开相机，相机响了一声。"}
	u := model.ProductionFlowUnit{Stage: "extract", SourceHash: "version", InputJSON: productionFlowJSON(map[string]any{"sources": []productionFlowSource{src}}), ResultJSON: "{}"}
	candidates := []productionFlowCandidate{
		{LocalRef: "actor", Label: "林岚", Kind: "character", SourceRef: src.ID, Quote: "林岚打开相机", Action: "打开相机", Context: "主角", Basis: "explicit", Reason: "行动人物"},
		{LocalRef: "camera", Label: "相机", Kind: "prop", SourceRef: src.ID, Quote: "林岚打开相机", Action: "被打开", Context: "林岚使用的相机", Basis: "explicit", Reason: "使用物件", SubjectRefs: []string{"actor"}},
		{LocalRef: "sound", Label: "相机声", Kind: "sound", SourceRef: src.ID, Quote: "相机响了一声", Action: "发声", Context: "相机开机", Basis: "explicit", Reason: "独立音效", SubjectRefs: []string{"camera"}, DependsOnRefs: []string{"camera"}},
	}
	result, issues := productionFlowValidate(u, productionFlowJSON(map[string]any{"candidates": candidates, "noAssetsReason": ""}))
	if len(issues) != 0 {
		t.Fatal(issues)
	}
	var adopted []productionFlowCandidate
	_ = decodeFlowValue(productionFlowValue(model.ProductionFlowUnit{ResultJSON: result})["candidates"], &adopted)
	ids := map[string]string{}
	for _, c := range adopted {
		ids[c.LocalRef] = c.ID
	}
	for _, c := range adopted {
		if c.LocalRef == "sound" && (len(c.SubjectRefs) != 1 || c.SubjectRefs[0] != ids["camera"] || c.DependsOnRefs[0] != ids["camera"]) {
			t.Fatal("relationship lost stable candidate reference", c)
		}
	}
	u.ResultJSON = result
	candidates[2].SubjectRefs = []string{"unknown"}
	_, issues = productionFlowValidate(u, productionFlowJSON(map[string]any{"candidates": candidates, "noAssetsReason": ""}))
	if len(issues) == 0 {
		t.Fatal("unknown relationship accepted")
	}
}

func TestProductionFlowIdentityAuditRequiresEvidenceAndPreservesDistinctPeople(t *testing.T) {
	entities := []productionFlowEntity{{ID: "a", Name: "主角父亲", Kind: "character", Members: []string{"c1"}}, {ID: "b", Name: "主角的父亲", Kind: "character", Members: []string{"c2"}}, {ID: "c", Name: "账房", Kind: "character", Members: []string{"c3"}}}
	evidence := map[string][]productionFlowCandidate{"a": {{Quote: "林岚的父亲递来相机。"}}, "b": {{Quote: "林岚的父亲收回相机。"}}, "c": {{Quote: "另一个账房走来。"}}}
	input := map[string]any{"entities": entities, "evidence": evidence}
	groups := []productionFlowIdentityGroup{{Canonical: "a", Members: []string{"a", "b"}, Reason: "同一父亲连续交接", Purpose: "父亲与女儿交接相机", Evidence: []productionFlowEvidence{{Ref: "a", Quote: "林岚的父亲递来相机。"}, {Ref: "b", Quote: "林岚的父亲收回相机。"}}}, {Canonical: "c", Members: []string{"c"}, Reason: "不同角色", Purpose: "负责账务"}}
	if issues := productionFlowValidateIdentity([]byte(productionFlowJSON(groups)), input); len(issues) != 0 {
		t.Fatal(issues)
	}
	u := model.ProductionFlowUnit{Stage: "identity", Status: "accepted", ResultJSON: productionFlowJSON(map[string]any{"groups": groups})}
	merged := productionFlowApplyIdentity(entities, []model.ProductionFlowUnit{u})
	if len(merged) != 2 || len(merged[0].Members) != 2 || merged[0].Purpose != "父亲与女儿交接相机" {
		t.Fatal("canonical membership or summary lost", merged)
	}
	if len(productionFlowApplyIdentity(entities, nil)) != 3 {
		t.Fatal("names alone caused an automatic merge")
	}
	groups[0].Evidence = groups[0].Evidence[:1]
	if issues := productionFlowValidateIdentity([]byte(productionFlowJSON(groups)), input); len(issues) == 0 {
		t.Fatal("unproven identity merge accepted")
	}
}

func TestProductionFlowIdentityInputDoesNotGrowWithAllPriorMembers(t *testing.T) {
	index := productionFlowIdentityIndex{byLabel: map[string][]int{}}
	for n := 0; n < 2000; n++ {
		index.append(productionFlowEntity{ID: fmt.Sprint(n), Name: fmt.Sprintf("主体%d", n), Kind: "prop", Members: []string{strings.Repeat("old-id", 100)}})
	}
	selected := index.selectFor([]productionFlowCandidate{{Label: "主体10"}})
	if len(selected) > 64 {
		t.Fatal("all prior identities leaked into batch", len(selected))
	}
	found := false
	for _, e := range selected {
		found = found || e.ID == "10"
		if len(e.Members) != 0 {
			t.Fatal("history members leaked")
		}
	}
	if !found {
		t.Fatal("relevant old identity missing")
	}
	candidates := make([]productionFlowCandidate, 240)
	for n := range candidates {
		candidates[n] = productionFlowCandidate{Label: "账房", Quote: "账房核对账页。", Context: "同一仓栈"}
	}
	calls := 0
	for start := 0; start < len(candidates); {
		start = productionFlowResolveEnd(candidates, start)
		calls++
	}
	if calls >= 10 {
		t.Fatal("small candidates still use fixed 24-item serial batches", calls)
	}
}

func TestProductionFlowPublishedRelationshipsFollowCanonicalIdentity(t *testing.T) {
	s, db, id := flowFixture(t)
	publishFlowTestRoot(t, s, db, id, "story")
	m, doc, artifacts := orderedPlanState(t, s, id)
	sourceHash := productionFlowSourceHash(m, "inventory", artifacts)
	sections, bodies := productionInventoryReviewSources(*m.Plan, productionInventoryStory(doc, artifacts))
	src := productionFlowSources(sourceHash, sections, bodies)[0]
	candidates := []productionFlowCandidate{
		{ID: "ca", Label: "林岚", Kind: "character", SourceRef: src.ID, Quote: src.Text, Action: "检查相机", State: "持有相机"},
		{ID: "cb", Label: "故事主角", Kind: "character", SourceRef: src.ID, Quote: src.Text, Action: "核对照片", State: "认出家人"},
		{ID: "cs", Label: "相机音效", Kind: "sound", SourceRef: src.ID, Quote: src.Text, Action: "相机动作音效", SubjectRefs: []string{"cb"}, DependsOnRefs: []string{"cb"}},
	}
	entities := []productionFlowEntity{
		{ID: "a", Name: "林岚", Kind: "character", Members: []string{"ca"}, Reason: "主角", Importance: "primary"},
		{ID: "b", Name: "故事主角", Kind: "character", Members: []string{"cb"}, Reason: "别称", Importance: "primary"},
		{ID: "s", Name: "相机音效", Kind: "sound", Members: []string{"cs"}, Reason: "动作音效", Importance: "supporting"},
	}
	groups := []productionFlowIdentityGroup{{Canonical: "a", Members: []string{"a", "b"}, Reason: "同一主角", Purpose: "追查相机并寻找家人"}}
	g := productionFlowGraph{Source: sourceHash, Units: []model.ProductionFlowUnit{
		{Stage: "extract", Status: "accepted", ResultJSON: productionFlowJSON(map[string]any{"candidates": candidates})},
		{Stage: "resolve", Status: "accepted", ResultJSON: productionFlowJSON(map[string]any{"entities": entities})},
		{Stage: "identity", Status: "accepted", ResultJSON: productionFlowJSON(map[string]any{"groups": groups})},
	}}
	plan, err := productionFlowInventoryPlan(g, m, doc, artifacts)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Assets) != 2 {
		t.Fatal("identity audit did not collapse duplicate before publication", plan.Assets)
	}
	for _, a := range plan.Assets {
		if a.Kind == "sound" && (len(a.SubjectKeys) != 1 || a.SubjectKeys[0] != "entity-a" || len(a.DependsOn) != 1 || a.DependsOn[0] != "entity-a") {
			t.Fatal("published association still points at removed duplicate", a)
		}
		if a.Kind == "character" && a.Purpose != "追查相机并寻找家人" {
			t.Fatal("main index contains concatenated plot instead of compact purpose", a)
		}
	}
	if !strings.Contains(productionFlowJSON(plan.InventoryReview), "持有相机") {
		t.Fatal("state evidence was lost while compacting main index")
	}
}

func TestProductionFlowIdentityAliasGroupsAreReviewedTogether(t *testing.T) {
	items := []productionFlowEntity{{ID: "a", Name: "Alpha", Aliases: []string{"Zeta"}}, {ID: "b", Name: "Beta"}, {ID: "c", Name: "Zeta"}}
	productionFlowOrderIdentityMatches(items, nil)
	if items[0].ID != "a" || items[1].ID != "c" {
		t.Fatal("cross-name aliases were not grouped for evidence review", items)
	}
}

func TestProductionFlowSplitOmissionCoverageAndRelationshipsSurviveAggregation(t *testing.T) {
	src := productionFlowSource{ID: "source", Text: "林岚打开相机。\n\n林岚放下照片。"}
	actor := productionFlowCandidate{ID: "actor", Kind: "character"}
	parent := model.ProductionFlowUnit{ID: "parent", Key: "flow/inventory/omissions/source", Stage: "omissions", SourceHash: "version", InputJSON: productionFlowJSON(map[string]any{"sources": []productionFlowSource{src}, "covered": []productionFlowCandidate{actor}, "coveragePolicy": "categories-v1"}), ResultJSON: "{}"}
	if !productionFlowRestructure(&parent) {
		t.Fatal("omissions could not split")
	}
	g := productionFlowGraph{Root: "inventory", Source: "version", Existing: map[string]model.ProductionFlowUnit{}}
	g.splitChildren(parent)
	for i := range g.Units {
		u := &g.Units[i]
		var sources []productionFlowSource
		_ = decodeFlowValue(productionFlowInput(*u)["sources"], &sources)
		c := productionFlowCandidate{LocalRef: "object", Label: "线索物件", Kind: "prop", SourceRef: src.ID, Quote: sources[0].Text, Action: "使用物件", Context: fmt.Sprintf("物件%d", i), Reason: "动作所需", Basis: "explicit", SubjectRefs: []string{"actor"}}
		rows := []productionFlowCoverage{{Kind: "character", Disposition: "covered", Candidates: []string{"actor"}, Reason: "人物已提取"}, {Kind: "environment", Disposition: "none", Candidates: []string{}, Reason: "该片段没有新空间"}, {Kind: "prop", Disposition: "added", Candidates: []string{"object"}, Reason: "补充所用物件"}, {Kind: "special", Disposition: "none", Candidates: []string{}, Reason: "无独立效果"}, {Kind: "sound", Disposition: "none", Candidates: []string{}, Reason: "本测试采用静音动作"}}
		result, issues := productionFlowValidate(*u, productionFlowJSON(map[string]any{"candidates": []productionFlowCandidate{c}, "noAssetsReason": "", "soundReview": "本测试采用静音动作", "coverageReview": rows}))
		if len(issues) != 0 {
			t.Fatal(issues)
		}
		u.Status, u.ResultJSON = "accepted", result
	}
	result, issues := productionFlowAggregate(parent, g.Units)
	if len(issues) != 0 {
		t.Fatal("split coverage IDs did not map back to original scope", result, issues)
	}
	parent.Status, parent.ResultJSON = "accepted", result
	g.Units = append(g.Units, parent)
	candidates := productionFlowCandidates(g.Units)
	if len(candidates) != 2 {
		t.Fatal("child candidates were counted again after parent adoption", len(candidates))
	}
	for _, c := range candidates {
		if len(c.SubjectRefs) != 1 || c.SubjectRefs[0] != "actor" {
			t.Fatal("covered subject was lost", c)
		}
	}
}

func TestProductionFlowIdentityRestructureKeepsOriginalAssignmentCoverage(t *testing.T) {
	u := model.ProductionFlowUnit{ID: "parent", Key: "flow/inventory/identity/character/0000", Stage: "identity", InputJSON: productionFlowJSON(map[string]any{"entities": []productionFlowEntity{{ID: "a", Name: "甲"}, {ID: "b", Name: "乙"}}, "evidence": map[string][]productionFlowCandidate{}}), ResultJSON: "{}"}
	if !productionFlowRestructure(&u) {
		t.Fatal("oversized identity review has no bounded recovery")
	}
	g := productionFlowGraph{Root: "inventory", Existing: map[string]model.ProductionFlowUnit{}}
	g.splitChildren(u)
	for i := range g.Units {
		child := &g.Units[i]
		result, issues := productionFlowValidate(*child, productionFlowJSON(flowReply(*child)))
		if len(issues) != 0 {
			t.Fatal(issues)
		}
		child.Status, child.ResultJSON = "accepted", result
	}
	result, issues := productionFlowAggregate(u, g.Units)
	if len(issues) != 0 || strings.Count(result, `"canonical"`) != 2 {
		t.Fatal("identity recovery dropped original scope", result, issues)
	}
}
