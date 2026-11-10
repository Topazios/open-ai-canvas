package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func planningTestAsset(kind, name string) productionPlanningAsset {
	return productionPlanningAsset{Key: productionPlanningAssetKey(kind, name), Kind: kind, Name: name, Aliases: []string{}, Purpose: "参与调查并推动人物的选择", CoreFacts: "照相馆的调查者", PlannedRange: "第一单元", Variants: "无独立变体"}
}

func planningTestCard(episode int, key string) productionPlanningCard {
	return productionPlanningCard{Episode: episode, Event: "调查者认出照片中的家人，决定追查冲洗记录", Outcome: "取得冲洗日期并留下联系方式", Threads: "照片的冲洗日期需要与旧账核对", AssetKeys: []string{key}, NewAssets: []productionPlanningAsset{}}
}

func planningTestUnit(start, end int, assets ...productionPlanningAsset) model.ProductionFlowUnit {
	return model.ProductionFlowUnit{ID: "cards", Key: "flow/story/cards/0001", Stage: "cards", InputJSON: productionFlowJSON(map[string]any{"start": start, "end": end, "registry": assets}), ResultJSON: "{}", IssuesJSON: "[]"}
}

func TestProductionFlowPlanningLongGraphUsesCompactBusinessBatches(t *testing.T) {
	existing := map[string]model.ProductionFlowUnit{}
	var final productionFlowGraph
	for pass := 0; pass < 10; pass++ {
		g := productionFlowGraph{UserID: "user", RunID: "run", Root: "story", Source: "source", Existing: existing}
		done := productionFlowStoryGraph(&g, map[string]any{"parameters": map[string]any{"episodeCount": 120, "minutesPerEpisode": 2}}, 120)
		if done {
			final = g
			break
		}
		for _, u := range g.Units {
			if u.Status == "accepted" {
				continue
			}
			result, issues := productionFlowValidate(u, productionFlowJSON(flowReply(u)))
			if len(issues) > 0 {
				t.Fatalf("%s: %+v", u.Stage, issues)
			}
			u.ResultJSON, u.Status = result, "accepted"
			existing[u.ID] = u
		}
	}
	counts := map[string]int{}
	for _, u := range final.Units {
		counts[u.Stage]++
		if strings.Contains(u.ResultJSON, "storyText") || strings.Contains(u.ResultJSON, "continuityFacts") {
			t.Fatal("outline still expands detailed episode prose or evidence ledgers")
		}
		if u.Stage == "cards" && productionFlowInput(u)["parameters"] == nil {
			t.Fatal("episode cards lost the configured runtime constraints")
		}
	}
	if len(final.Units) != 33 || counts["registry"] != 6 || counts["cards"] != 15 || counts["review"] != 9 || len(productionPlanningCards(final.Units)) != 120 {
		t.Fatalf("unexpected planning requests: %d, %+v", len(final.Units), counts)
	}
	plan, err := productionPlanningInventory(final.Units, "source")
	if err != nil || len(plan.Assets) != 1 || len(plan.Assets[0].Episodes) != 120 {
		t.Fatalf("local inventory lost usage: %+v, %v", plan, err)
	}
	manifest := productionManifest{FrameID: "frame", Plan: &productionPlan{Version: 5, StoryStructureVersion: 3}}
	doc := map[string]any{"nodes": []any{map[string]any{"id": "frame", "metadata": map[string]any{"shortDrama": map[string]any{"parameters": map[string]any{"episodeCount": 120, "minutesPerEpisode": 2}}}}}}
	fields, err := productionFlowStoryDocument(final, manifest, doc)
	if err != nil || !strings.Contains(fields["coreAssets"], "简介与别名") || !strings.Contains(fields["coreAssets"], plan.Assets[0].CoreFacts) || strings.Contains(fields["coreAssets"], "仅列资产索引") {
		t.Fatal("published outline discarded registered descriptions", fields["coreAssets"], err)
	}
}

func TestProductionFlowPlanningAssetTablesListEveryRecordAndVariant(t *testing.T) {
	plan := productionPlan{FlowStoryUnits: []string{"adopted"}, Absent: map[string]string{}}
	for _, kind := range productionCurrentPlanKinds {
		for i := 1; i <= 150; i++ {
			plan.Assets = append(plan.Assets, productionPlanAsset{Key: fmt.Sprintf("%s-%03d", kind, i), Kind: kind, Name: fmt.Sprintf("%s名称%03d", kind, i), CoreFacts: fmt.Sprintf("%s简介%03d，背景与身份明确", kind, i), Purpose: fmt.Sprintf("%s用途%03d", kind, i), Aliases: []string{fmt.Sprintf("%s别名%03d", kind, i)}, Variants: "青年（前期）、老年（后期）；破损前|后\n保持身份连续", PlannedRange: "第1至120集", Episodes: []int{1, 120}, Priority: i})
		}
	}
	for _, catalog := range []bool{false, true} {
		content := strings.Join(productionPlanningAssetTables(plan, catalog), "\n")
		for _, item := range plan.Assets {
			for _, value := range []string{item.Name, item.CoreFacts, item.Purpose, item.Aliases[0], "青年（前期）、老年（后期）", item.PlannedRange} {
				if !strings.Contains(content, value) {
					t.Fatal("asset omitted or abbreviated from list", catalog, item.Key, value)
				}
			}
		}
		for _, kind := range productionCurrentPlanKinds {
			if strings.Count(content, "| 1 | "+map[bool]string{true: kind + "-001 ", false: ""}[catalog]+kind+"名称001 |") != 1 {
				t.Fatal("category numbering did not restart", kind, catalog)
			}
		}
		if !catalog && strings.Contains(content, "character-001 ") {
			t.Fatal("outline displays internal keys as formal codes")
		}
		rows := 0
		for _, line := range strings.Split(content, "\n") {
			if strings.HasPrefix(line, "| ") && !strings.HasPrefix(line, "| 序号") {
				rows++
				if got := strings.Count(line, "|"); got != 7 {
					t.Fatal("asset text broke the six-column table", line, got)
				}
			}
		}
		if rows != len(plan.Assets) {
			t.Fatal("list truncation or duplicate rows", rows, len(plan.Assets))
		}
	}
	empty := strings.Join(productionPlanningAssetTables(productionPlan{Absent: map[string]string{"sound": "无独立声音需求"}}, false), "\n")
	if !strings.Contains(empty, "无独立声音需求") {
		t.Fatal("empty category lost its reason")
	}
}

func TestProductionFlowPlanningCardRepairPreservesSiblingsAndAllowsSemanticChange(t *testing.T) {
	a := planningTestAsset("character", "林岚")
	u := planningTestUnit(1, 2, a)
	first, second := planningTestCard(1, a.Key), planningTestCard(2, a.Key)
	second.Outcome = ""
	result, issues := productionFlowValidate(u, productionFlowJSON(map[string]any{"episodes": []productionPlanningCard{first, second}}))
	if len(issues) == 0 {
		t.Fatal("incomplete episode adopted")
	}
	u.ResultJSON = result
	first.Event, second.Outcome = "不应覆盖合格兄弟集", "核对出真实地址"
	result, issues = productionFlowValidate(u, productionFlowJSON(map[string]any{"episodes": []productionPlanningCard{first, second}}))
	var cards []productionPlanningCard
	_ = decodeFlowValue(productionFlowValue(model.ProductionFlowUnit{ResultJSON: result})["episodes"], &cards)
	if len(issues) != 0 || len(cards) != 2 || cards[0].Event == first.Event {
		t.Fatalf("schema repair rewrote accepted sibling: %s, %+v", result, issues)
	}
	u.ResultJSON, u.IssuesJSON = result, productionFlowJSON([]productionFlowIssue{{Layer: "semantic", Target: u.Key}})
	first.Event = "调查者先取得家人同意，再查阅旧账"
	result, issues = productionFlowValidate(u, productionFlowJSON(map[string]any{"episodes": []productionPlanningCard{first}}))
	_ = decodeFlowValue(productionFlowValue(model.ProductionFlowUnit{ResultJSON: result})["episodes"], &cards)
	if len(issues) != 0 || cards[0].Event != first.Event || cards[1].Outcome != second.Outcome {
		t.Fatalf("semantic fix did not replace target while retaining other episode: %s, %+v", result, issues)
	}
}

func TestProductionFlowPlanningTruncationAdoptsOnlyCompleteCards(t *testing.T) {
	a := planningTestAsset("character", "林岚")
	u := planningTestUnit(1, 3, a)
	raw := `{"episodes":[` + productionFlowJSON(planningTestCard(1, a.Key)) + `,{"episode":2,"task":"未闭合`
	result, issues := productionFlowValidate(u, raw)
	var cards []productionPlanningCard
	_ = decodeFlowValue(productionFlowValue(model.ProductionFlowUnit{ResultJSON: result})["episodes"], &cards)
	if len(issues) == 0 || len(cards) != 1 || cards[0].Episode != 1 {
		t.Fatalf("closed card lost or truncated card fabricated: %s, %+v", result, issues)
	}
}

func TestProductionFlowPlanningNoCoreAssetsCanRegisterEpisodeNeed(t *testing.T) {
	u := planningTestUnit(1, 1)
	schema := productionPlanningSchema(u)
	encoded := productionFlowJSON(schema)
	if strings.Contains(encoded, `"enum":[]`) || strings.Contains(encoded, `"enum":null`) {
		t.Fatal("empty core registry produced an invalid tool enum")
	}
	c := planningTestCard(1, "")
	c.AssetKeys = []string{}
	c.NewAssets = []productionPlanningAsset{planningTestAsset("character", "林岚")}
	result, issues := productionFlowValidate(u, productionFlowJSON(map[string]any{"episodes": []productionPlanningCard{c}}))
	if len(issues) > 0 || !strings.Contains(result, productionPlanningAssetKey("character", "林岚")) {
		t.Fatal("necessary new asset could not establish valid episode references", issues)
	}
}

func TestProductionFlowPlanningSplitAggregatesNewAssetsOnce(t *testing.T) {
	a := planningTestAsset("character", "林岚")
	u := planningTestUnit(1, 3, a)
	u.ResultJSON = productionFlowJSON(map[string]any{"episodes": []productionPlanningCard{planningTestCard(1, a.Key)}})
	if !productionFlowRestructure(&u) {
		t.Fatal("missing episode range was not split")
	}
	var split productionFlowSplit
	_ = json.Unmarshal([]byte(u.SplitJSON), &split)
	children := []model.ProductionFlowUnit{}
	for _, input := range split.Inputs {
		child := model.ProductionFlowUnit{Stage: "cards", InputJSON: productionFlowJSON(input), ResultJSON: "{}"}
		card := planningTestCard(int(numberValue(input["start"], 0)), a.Key)
		card.NewAssets = []productionPlanningAsset{planningTestAsset("prop", "旧账本")}
		result, issues := productionFlowValidate(child, productionFlowJSON(map[string]any{"episodes": []productionPlanningCard{card}}))
		if len(issues) > 0 {
			t.Fatal(issues)
		}
		child.ResultJSON, child.Status = result, "accepted"
		children = append(children, child)
	}
	result, issues := productionFlowAggregate(u, children)
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	u.ResultJSON, u.Status = result, "accepted"
	registry := model.ProductionFlowUnit{Stage: "registry", Status: "accepted", ResultJSON: productionFlowJSON(map[string]any{"assets": []productionPlanningAsset{a}})}
	plan, err := productionPlanningInventory(append([]model.ProductionFlowUnit{registry, u}, children...), "source")
	if err != nil || len(plan.Assets) != 2 || len(plan.Assets[1].Episodes) != 2 || plan.Assets[1].Priority != 1 {
		t.Fatalf("split parents/children double counted or new identity duplicated: %+v, %v", plan, err)
	}
}

func TestProductionFlowPlanningSourceReviewOwnershipIsServerDerived(t *testing.T) {
	sources := []productionFlowSource{{ID: "a"}, {ID: "b"}}
	candidates := []productionFlowCandidate{{ID: "ca", SourceRef: "a"}, {ID: "cb", SourceRef: "b"}}
	raw := json.RawMessage(`[{"sourceRef":"a","candidates":["cb"],"reason":"逐份已核对"},{"sourceRef":"b","candidates":["ca"],"reason":"逐份已核对"}]`)
	if issues := productionFlowValidateSourceReviews(raw, sources); len(issues) > 0 {
		t.Fatal(issues)
	}
	var rows []productionFlowSourceReview
	_ = json.Unmarshal(productionFlowSourceReviewIDs(raw, candidates), &rows)
	if len(rows[0].Candidates) != 1 || rows[0].Candidates[0] != "ca" || rows[1].Candidates[0] != "cb" {
		t.Fatalf("model-provided duplicate refs changed occurrence ownership: %+v", rows)
	}
}

func TestProductionFlowPlanningInventoryUsesReadableFixedTemplate(t *testing.T) {
	a := planningTestAsset("character", "林岚")
	plan := productionPlan{Version: 5, Complete: true, FlowStoryUnits: []string{"adopted"}, Assets: []productionPlanAsset{{Key: a.Key, Kind: a.Kind, Name: a.Name, Purpose: a.Purpose, CoreFacts: a.CoreFacts, Variants: a.Variants, PlannedRange: a.PlannedRange, Priority: 1, Episodes: []int{1, 2}}}, Absent: map[string]string{}}
	text, err := productionRenderPlanInventory(plan)
	if err != nil || !strings.Contains(text, "身份约束与别名") || !strings.Contains(text, a.CoreFacts) || strings.Contains(text, "| 设计前置 |") {
		t.Fatalf("planning inventory did not use compact template: %s, %v", text, err)
	}
	if productionPlanSchemaVersion(plan) != 3 || productionPlanSchemaVersion(productionPlan{Version: 5}) != 2 {
		t.Fatal("planning and imported prose templates selected incorrectly")
	}
}

func TestProductionFlowPlanningUnitsCoverSupportingAssetsWithoutPerEpisodeExtraction(t *testing.T) {
	existing := map[string]model.ProductionFlowUnit{}
	var final productionFlowGraph
	for pass := 0; pass < 12; pass++ {
		g := productionFlowGraph{UserID: "user", RunID: "run", Root: "story", Source: "source", Existing: existing}
		if productionFlowStoryGraph(&g, map[string]any{}, 4) {
			final = g
			break
		}
		for _, u := range g.Units {
			if u.Status == "accepted" {
				continue
			}
			reply := flowReply(u)
			input := productionFlowInput(u)
			if input["planningTemplate"] != productionPlanningTemplate {
				t.Fatal("assignment has no immutable template version")
			}
			if u.Stage == "arcs" {
				reply = map[string]any{"arcs": []productionFlowArc{
					{Title: "追账", Start: 1, End: 2, Entry: "发现账目矛盾", Goal: "取得账房的协助", Events: "核对船工与账房记录", Exit: "获得副本", Threads: "账本副本交往闸口"},
					{Title: "守闸", Start: 3, End: 4, Entry: "副本送到闸口", Goal: "让看守核对出货", Events: "让船工与看守配合核验", Exit: "确认真实交货", Threads: "前单元账目被证实"},
				}}
			}
			if u.Stage == "registry" && input["scope"] == "unit" {
				rows := []productionPlanningAsset{planningTestAsset("character", "船工")}
				var arc productionFlowArc
				_ = decodeFlowValue(input["arc"], &arc)
				if arc.Start == 1 {
					rows = append(rows, planningTestAsset("character", "账房"), planningTestAsset("environment", "账房工作间"), planningTestAsset("prop", "出货账本副本"), planningTestAsset("sound", "翻查账页声"))
				} else {
					rows = append(rows, planningTestAsset("character", "闸口看守"), planningTestAsset("environment", "闸口值守间"))
				}
				reply = map[string]any{"assets": rows, "absentReason": ""}
			}
			if u.Stage == "cards" {
				encoded := productionFlowJSON(input["registry"])
				if !strings.Contains(encoded, "船工") || !strings.Contains(encoded, "林岚") {
					t.Fatal("episode input lost core or supporting identities", encoded)
				}
				if input["start"].(float64) == 1 && strings.Contains(encoded, "闸口看守") {
					t.Fatal("episode input loads unrelated unit rosters")
				}
			}
			result, issues := productionFlowValidate(u, productionFlowJSON(reply))
			if len(issues) > 0 {
				t.Fatalf("%s: %+v", u.Key, issues)
			}
			u.ResultJSON, u.Status = result, "accepted"
			existing[u.ID] = u
		}
	}
	if len(final.Units) == 0 {
		t.Fatal("planning never completed")
	}
	plan, err := productionPlanningInventory(final.Units, "source")
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, a := range plan.Assets {
		counts[a.Name]++
		if a.Name == "船工" && len(a.Episodes) != 4 {
			t.Fatal("cross-unit identity lost usage", a)
		}
	}
	for _, name := range []string{"林岚", "船工", "账房", "闸口看守", "出货账本副本", "翻查账页声"} {
		if counts[name] != 1 {
			t.Fatal("supporting asset omitted or duplicated", name, counts)
		}
	}
	for _, u := range final.Units {
		if u.Stage == "extract" || u.Stage == "identity" {
			t.Fatal("planned inventory fell back to whole-outline extraction")
		}
		if u.Stage == "review" && strings.Contains(u.Key, "/unit/") {
			input := productionFlowInput(u)
			if !strings.Contains(productionFlowJSON(input["sources"]), "registry/unit/") || !strings.Contains(stringValue(input["scope"]), "newAssets") {
				t.Fatal("semantic review has no registry or concrete omission repair path")
			}
		}
	}
	rows := productionFlowStages(final, map[string]any{"parameters": map[string]any{"episodeCount": 4}}, true, false)
	if rows[3].Total != 7 || rows[3].Completed != 7 || rows[3].Percent != 100 {
		t.Fatal("unit registry work omitted from progress denominator", rows[3])
	}
}

func TestProductionFlowPlanningRegistryReusesExactAliasAndMergesUsage(t *testing.T) {
	core := planningTestAsset("character", "周砚")
	core.Aliases = []string{"照相馆老板"}
	alias := planningTestAsset("character", "照相馆老板")
	alias.PlannedRange = "第二单元"
	u := model.ProductionFlowUnit{Stage: "registry", InputJSON: productionFlowJSON(map[string]any{"scope": "unit", "registry": []productionPlanningAsset{core}})}
	result, issues := productionFlowValidate(u, productionFlowJSON(map[string]any{"assets": []productionPlanningAsset{alias}, "absentReason": ""}))
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	u.Status, u.ResultJSON = "accepted", result
	seed := model.ProductionFlowUnit{Stage: "registry", Status: "accepted", ResultJSON: productionFlowJSON(map[string]any{"assets": []productionPlanningAsset{core}})}
	assets, _ := productionPlanningRegistry([]model.ProductionFlowUnit{seed, u})
	if len(assets) != 1 || assets[0].Key != core.Key || len(assets[0].Usage) != 2 || assets[0].Usage[1].Range != "第二单元" {
		t.Fatal("alias created a second identity or lost unit scope", assets)
	}
	other := planningTestAsset("character", "同名岗位另一人")
	other.Aliases = core.Aliases
	if _, ok := newProductionPlanningAssetIndex([]productionPlanningAsset{core, other}).match(alias); ok {
		t.Fatal("ambiguous job alias merged distinct characters")
	}
}

func TestProductionFlowPlanningCompactContractHasNoRepeatedStorySections(t *testing.T) {
	plan := productionPlan{Version: 5, StoryStructureVersion: 3, FlowStoryUnits: []string{"adopted"}}
	if productionPlanSchemaVersion(plan) != 4 {
		t.Fatal("compact template not selected")
	}
	sections := productionPlanDocumentSectionsForSchema("story", "", 4)
	if len(sections) != 8 || len(productionPlanningCardFields) != 3 {
		t.Fatal("old repeated narrative layers remain", sections, productionPlanningCardFields)
	}
	for _, s := range sections {
		if cloudAgentContainsString([]string{"plot", "ending", "motivation", "characterArcs", "world", "continuity", "uncertainties"}, s.Key) {
			t.Fatal("redundant full-story section remains", s)
		}
	}
	for _, stage := range []string{"foundation", "characters"} {
		u := model.ProductionFlowUnit{Stage: stage, InputJSON: "{}"}
		p := productionFlowSchema(u)["properties"].(map[string]any)
		if len(p) != 2 {
			t.Fatal("global job still requests repeated full-story fields", p)
		}
		for key, value := range p {
			if value.(map[string]any)["description"] == nil {
				t.Fatal("global field lacks a non-overlapping responsibility", key)
			}
		}
	}
}

func TestProductionFlowPlanningMissingSupportingRoleCanBlockAndRepair(t *testing.T) {
	a := planningTestAsset("character", "调查者")
	u := planningTestUnit(1, 1, a)
	c := planningTestCard(1, a.Key)
	c.Event = "账房向调查者交出自己保留的出货记录。"
	u.ResultJSON, u.Status = productionFlowJSON(map[string]any{"episodes": []productionPlanningCard{c}}), "accepted"
	review := model.ProductionFlowUnit{Stage: "review", InputJSON: productionFlowJSON(map[string]any{"sources": map[string]any{u.Key: productionFlowValue(u)}})}
	issue := productionFlowIssue{Basis: "rule_violation", Rule: "asset_coverage", Target: u.Key, Message: "行动角色账房未登记", Action: "第1集newAssets补账房，保留事件与其他资产引用", Severity: "blocking", Evidence: []productionFlowEvidence{{Ref: u.Key, Quote: c.Event}}}
	result, failures := productionFlowValidate(review, productionFlowJSON(map[string]any{"issues": []productionFlowIssue{issue}}))
	if len(failures) > 0 || !strings.Contains(result, `"severity":"blocking"`) {
		t.Fatal("evidenced omission was downgraded to optional advice", result, failures)
	}
	u.IssuesJSON = string(productionFlowObject(result)["issues"])
	c.NewAssets = []productionPlanningAsset{planningTestAsset("character", "账房")}
	result, failures = productionFlowValidate(u, productionFlowJSON(map[string]any{"episodes": []productionPlanningCard{c}}))
	if len(failures) > 0 || !strings.Contains(result, productionPlanningAssetKey("character", "账房")) {
		t.Fatal("saved episode could not receive supporting role repair", result, failures)
	}
}
