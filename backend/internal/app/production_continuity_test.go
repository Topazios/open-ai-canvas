package app

import (
	"fmt"
	"strings"
	"testing"
)

func relationshipLedgerRow(record productionRelationshipRecord) string {
	return fmt.Sprintf("%s | 主体：%s | 客体：%s | 类型：%s | 方向：%s | 规范称呼：%s | 来源：%s | 适用范围：%s", record.Code, record.Subject, record.Object, record.Relation, record.Direction, record.Canonical, record.Source, record.Scope)
}

func TestProductionStateTransitionValidation(t *testing.T) {
	valid := productionDesignVariant{Name: "兽化形态", Description: "变身为兽形", Source: "design", Basis: "故事中的变身事件", Trigger: "触发变身", PreviousState: "人形", Scope: "变身期间", Recovery: "解除变身"}
	if err := productionValidateVariant(valid); err != nil {
		t.Fatal(err)
	}
	missing := valid
	missing.Trigger = ""
	if productionValidateVariant(missing) == nil {
		t.Fatal("missing trigger accepted")
	}
	missing.Source = "approved"
	if productionValidateVariant(missing) == nil {
		t.Fatal("approval is not a provenance type")
	}
	legacy := productionDesignVariant{Name: "旧状态", Description: "旧描述"}
	if err := productionValidateVariant(legacy); err != nil {
		t.Fatal(err)
	}
}

func TestProductionStateTransitionValidationAggregatesEveryCheckedField(t *testing.T) {
	variant := productionDesignVariant{Name: "状态", Description: "描述", Source: "approval"}
	issues := cloudAgentValidationIssues(productionValidateVariant(variant))
	if len(issues) != 6 {
		t.Fatalf("expected invalid source and five missing transition fields, got %d: %+v", len(issues), issues)
	}
	fields := map[string]bool{}
	for _, issue := range issues {
		fields[issue.Field] = true
	}
	for _, field := range []string{"source", "basis", "trigger", "previousState", "scope", "recovery"} {
		if !fields[field] {
			t.Fatalf("missing aggregated field %s: %+v", field, issues)
		}
	}
}

func TestProductionDesignValidationAggregatesVariantsAndCollectionLimits(t *testing.T) {
	design := &productionDesignFields{
		SoundKind: "dialogue",
		Variants:  append([]productionDesignVariant{{Source: "approval"}, {Name: "第二状态", Source: "design"}}, make([]productionDesignVariant, 199)...),
		Sounds:    make([]string, 201),
	}
	issues := cloudAgentValidationIssues(productionValidateDesignFields(design))
	fields := map[string]bool{}
	for _, issue := range issues {
		fields[issue.Field] = true
	}
	for _, field := range []string{"design.soundKind", "design.variants", "design.sounds", "design.variants[0].name", "design.variants[0].description", "design.variants[0].source", "design.variants[1].description", "design.variants[1].basis"} {
		if !fields[field] {
			t.Fatalf("missing aggregated design issue %s: %+v", field, issues)
		}
	}
}

func TestProductionVariantRenameKeepsIdentity(t *testing.T) {
	previous := []productionDesignVariant{{Code: "CHR-0001-V0001", Name: "工作服"}}
	renamed := []productionDesignVariant{{Code: "CHR-0001-V0001", Name: "职业造型"}, {Name: "礼服"}}
	if err := productionMatchVariantCodes(renamed, previous); err != nil {
		t.Fatal(err)
	}
	if renamed[0].Code != previous[0].Code || renamed[1].Code != "" {
		t.Fatal("rename changed identity")
	}
	if productionMatchVariantCodes([]productionDesignVariant{{Code: "CHR-0002-V0001", Name: "foreign"}}, previous) == nil {
		t.Fatal("foreign code accepted")
	}
	if productionMatchVariantCodes([]productionDesignVariant{{Name: "duplicate"}, {Name: "duplicate"}}, previous) == nil {
		t.Fatal("duplicate state accepted")
	}
}

func TestProductionVariantIdentityValidationAggregatesUnknownAndDuplicateValues(t *testing.T) {
	previous := []productionDesignVariant{{Code: "CHR-0001-V0001", Name: "基准"}}
	variants := []productionDesignVariant{
		{Code: "CHR-9999-V0001", Name: "重复"},
		{Code: "CHR-0001-V0001", Name: "重复"},
		{Code: "CHR-0001-V0001", Name: "第三状态"},
	}
	issues := cloudAgentValidationIssues(productionMatchVariantCodes(variants, previous))
	fields := map[string]bool{}
	for _, issue := range issues {
		fields[issue.Field] = true
	}
	for _, field := range []string{"variants[0].code", "variants[1].name", "variants[2].code"} {
		if !fields[field] {
			t.Fatalf("missing aggregated identity issue %s: %+v", field, issues)
		}
	}
}

func TestProductionManualVariantReservationUsesUniqueCodesAndOwnership(t *testing.T) {
	s, db, _ := productionFixture(t)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionWorkflow(productionNode(doc, "body"))["assetIdentity"] = map[string]any{"id": "identity-one", "code": "CHR-0001", "kind": "character"}
	})
	first, err := s.ReserveProductionVariantCode("user", "agent-canvas", "body")
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.ReserveProductionVariantCode("user", "agent-canvas", "body")
	if err != nil || second == first || !strings.HasPrefix(second, "CHR-0001-V") {
		t.Fatalf("variant identity repeated: %q %q %v", first, second, err)
	}
	if _, err := s.ReserveProductionVariantCode("other", "agent-canvas", "body"); err == nil {
		t.Fatal("cross-user allocation accepted")
	}
	if _, err := s.ReserveProductionVariantCode("user", "agent-canvas", "target"); err == nil {
		t.Fatal("missing identity accepted")
	}
}

func TestProductionRelationshipLedgerDoesNotJudgeUnboundProse(t *testing.T) {
	text := "REL-001 | 主体：玛拉 | 客体：莱昂 | 类型：siblings | 方向：older_sister_younger_brother | 规范称呼：姐姐与弟弟 | 来源：故事总纲 | 适用范围：全剧"
	ledger, found, err := productionExtractRelationshipLedger(text)
	if err != nil || !found || len(ledger) != 1 {
		t.Fatalf("ledger parse failed: found=%v len=%d err=%v", found, len(ledger), err)
	}
	if issues := productionRelationshipConsistencyIssues("", "玛拉与弟弟在遮蔽车厢会合", ledger); len(issues) != 0 {
		t.Fatalf("canonical sibling wording rejected: %v", issues)
	}
	issues := productionRelationshipConsistencyIssues("", "终局兄妹获救", ledger)
	if len(issues) != 0 {
		t.Fatalf("prose without identified participants was treated as a factual conflict: %v", issues)
	}
}

func TestProductionRelationshipLedgerDoesNotInferDirectionFromCanonicalWording(t *testing.T) {
	text := "REL-001 | 主体：玛拉 | 客体：莱昂 | 类型：siblings | 方向：older_sister_younger_brother | 规范称呼：兄妹 | 来源：故事总纲 | 适用范围：全剧"
	ledger, _, err := productionExtractRelationshipLedger(text)
	if err != nil || len(ledger) != 1 || ledger[0].Direction != "older_sister_younger_brother" {
		t.Fatalf("canonical wording was used to change or reject declared facts: %v %+v", err, ledger)
	}
}

func TestProductionRelationshipLedgerAcceptsMarkdownTableAndNormalizesDirection(t *testing.T) {
	text := "|关系编号|主体|客体|固定关系类型|方向枚举|规范称呼|来源|适用范围|\n|---|---|---|---|---|---|---|---|\n|REL-001|玛拉|约纳斯|siblings|older_to_younger|姐姐→弟弟（姐弟）|选题明确二十七岁的弟弟；年龄补足为设计|全季及全部资产，永久方向|"
	ledger, found, err := productionExtractRelationshipLedger(text)
	if err != nil || !found || len(ledger) != 1 {
		t.Fatalf("markdown ledger parse failed: found=%v len=%d err=%v", found, len(ledger), err)
	}
	if got := ledger[0].Direction; got != "older_to_younger" {
		t.Fatalf("declared direction was inferred from prose: %q", got)
	}
}

func TestProductionRelationshipLedgerAcceptsExpandedRelationshipEnums(t *testing.T) {
	text := strings.Join([]string{
		"REL-001 | 主体：玛拉 | 客体：埃里克 | 类型：former_partners | 方向：bidirectional | 规范称呼：前安保工作搭档 | 来源：选题 | 适用范围：全剧",
		"REL-002 | 主体：埃里克 | 客体：约纳斯 | 类型：captor_captive | 方向：subject_to_object | 规范称呼：绑架者与被绑者 | 来源：设计 | 适用范围：本夜",
	}, "\n")
	ledger, _, err := productionExtractRelationshipLedger(text)
	if err != nil || len(ledger) != 2 {
		t.Fatalf("expanded relationship enums rejected: len=%d err=%v", len(ledger), err)
	}
}

func TestProductionRelationshipLedgerIgnoresHeadersAndReferences(t *testing.T) {
	for _, separator := range []string{"|", "｜"} {
		text := strings.ReplaceAll("结构化关系登记表\n|REL-编号|主体|客体|类型枚举|方向枚举|规范称呼|来源|适用范围|\n|---|---|---|---|---|---|---|---|\n|REL-001|角色甲|角色乙|siblings|older_sister_younger_brother|姐姐与弟弟|选题|全剧|\nREL-001、002 为已锁定关系的引用，不是新增记录。", "|", separator)
		ledger, found, err := productionExtractRelationshipLedger(text)
		if err != nil || !found || len(ledger) != 1 || ledger[0].Code != "REL-001" {
			t.Fatalf("header/reference parsed as a record: %q, %+v %v %v", separator, ledger, found, err)
		}
	}
}

func TestProductionRelationshipLedgerRejectsMissingCellAndUnknownEnum(t *testing.T) {
	for _, text := range []string{
		"|REL-001|角色甲||siblings|older_sister_younger_brother|姐姐与弟弟|选题|全剧|",
		"REL-001 | 主体：角色甲 | 客体：角色乙 | 类型：invented_relation | 方向：bidirectional | 规范称呼：盟友 | 来源：设计 | 适用范围：全剧",
	} {
		if _, found, err := productionExtractRelationshipLedger(text); err == nil || !found {
			t.Fatalf("invalid record silently accepted: %q, found=%v err=%v", text, found, err)
		}
	}
}

func TestProductionRelationshipLedgerAggregatesRowFieldsAndKeepsValidRows(t *testing.T) {
	text := strings.Join([]string{
		"REL-01 | 主体：角色甲 | 客体：角色甲 | 类型：invented_relation | 方向：invented_direction | 规范称呼： | 来源： | 适用范围：",
		"REL-002 | 主体：角色乙 | 客体：角色丙 | 类型：partners | 方向：bidirectional | 规范称呼：搭档 | 来源：总纲 | 适用范围：全剧",
	}, "\n")
	ledger, found, err := productionExtractRelationshipLedger(text)
	if err == nil || !found || len(ledger) != 1 || ledger[0].Code != "REL-002" {
		t.Fatalf("partial ledger was discarded or invalid row accepted: found=%v ledger=%+v err=%v", found, ledger, err)
	}
	issues := cloudAgentValidationIssues(err)
	fields := map[string]bool{}
	for _, issue := range issues {
		fields[issue.Field] = true
	}
	for _, field := range []string{"relationships[0].code", "relationships[0].relation", "relationships[0].direction", "relationships[0].canonical", "relationships[0].source", "relationships[0].scope", "relationships[0].object"} {
		if !fields[field] {
			t.Fatalf("missing aggregated relationship issue %s: %+v", field, issues)
		}
	}
}

func TestProductionRelationshipConsistencyReportsParseAndConflictTogether(t *testing.T) {
	baseline := productionRelationshipRecord{Code: "REL-001", Subject: "A", Object: "B", Relation: "partners", Direction: "bidirectional", Canonical: "搭档", Source: "总纲", Scope: "全剧"}
	conflict := baseline
	conflict.Object = "C"
	content := "REL-002 | 主体：D | 客体：D | 类型：invented | 方向：invented | 规范称呼： | 来源： | 适用范围：\n" + relationshipLedgerRow(conflict)
	issues := productionRelationshipConsistencyIssues("", content, []productionRelationshipRecord{baseline})
	joined := strings.Join(issues, "\n")
	if !strings.Contains(joined, "relationships[0]") || !strings.Contains(joined, "REL-001 的结构化关系事实不一致") {
		t.Fatalf("parse defects and valid-row conflict were not reported together: %v", issues)
	}
}

func TestProductionRelationshipContractUsesValidatorEnums(t *testing.T) {
	section := productionDocumentSection{Key: "relationships", Title: "人物关系"}
	description := productionPlanFieldDescription("story", "", section)
	for _, values := range []map[string]bool{productionRelationshipKinds, productionRelationshipDirections} {
		for key := range values {
			if !strings.Contains(description, key) {
				t.Fatalf("validator enum missing from model contract: %s", key)
			}
		}
	}
}

func TestProductionRelationshipPlanSavesFiveDocumentsWithoutStartingAssets(t *testing.T) {
	s, _, run := planFixture(t, 3)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	document := orderedPlanDocument("story", "")
	document["relationships"] = "|REL-编号|主体|客体|类型枚举|方向枚举|规范称呼|来源|适用范围|\n|---|---|---|---|---|---|---|---|\n|REL-001|角色甲|角色乙|siblings|older_sister_younger_brother|姐姐与弟弟|制作设计|全剧|\n关系登记沿用 REL-001。"
	bad := orderedPlanDocument("story", "")
	bad["relationships"] = strings.ReplaceAll(document["relationships"], "|siblings|", "|invented_type|")
	result := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "总纲", "document": bad}, true)
	if !strings.Contains(productionJSON(result), "document.relationships") || !strings.Contains(productionJSON(result), "invalid_relationship_ledger") {
		t.Fatal("relationship validation did not supply a repairable field error", result)
	}
	story := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "总纲", "document": document}, false)
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{StoryHash: stringValue(story["hash"]), Complete: true,
		Assets: []productionPlanAsset{
			{Key: "first", Kind: "character", Name: "角色甲", Purpose: "主要角色", PlannedRange: "全剧"},
			{Key: "second", Kind: "character", Name: "角色乙", Purpose: "主要角色", PlannedRange: "全剧"},
		}, Absent: map[string]string{"environment": "无独立场景", "prop": "无独立道具", "sound": "无独立声音"}}, false)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, run.ID, key, "", key)
	}
	if report := productionCall(t, s, run.ID, "production_check", map[string]any{}, false); report["valid"] != true {
		t.Fatal(report)
	}
	if err := s.completeCloudAgentPiRun("user", run.ID); err != nil {
		t.Fatal(err)
	}
	m, doc, rows := orderedPlanState(t, s, run.ID)
	if len(rows) != 5 || len(m.Plan.Relationships) != 1 || m.Plan.AssetsStarted || len(m.Plan.Groups) != 0 {
		t.Fatal("plan did not stop after five documents", m.Plan, rows)
	}
	for _, row := range rows {
		if productionNode(doc, row.NodeID) == nil || !productionPlanArtifactValid(m, doc, rows, row.Key) {
			t.Fatalf("saved document absent or invalid on canvas: %s", row.Key)
		}
	}
}

func TestProductionLegacyRelationshipWordsDoNotEstablishFacts(t *testing.T) {
	issues := productionRelationshipConsistencyIssues("玛拉救出她二十七岁的弟弟", "终局兄妹获救", nil)
	if len(issues) != 0 {
		t.Fatalf("legacy words created an unsupported relationship conflict: %v", issues)
	}
}

func TestProductionRelationshipParticipantsReuseInventoryNames(t *testing.T) {
	plan := productionPlan{
		ContinuityVersion: 1,
		Relationships:     []productionRelationshipRecord{{Code: "REL-001", Subject: "玛拉", Object: "莱昂", Relation: "siblings", Direction: "older_sister_younger_brother", Canonical: "姐姐与弟弟", Source: "故事总纲", Scope: "全剧"}},
		Assets:            []productionPlanAsset{{Kind: "character", Name: "玛拉·韦伯"}, {Kind: "character", Name: "莱昂·韦伯"}},
	}
	if err := productionValidateRelationshipParticipants(plan); err != nil {
		t.Fatal(err)
	}
	plan.Assets[1].Name = "丹尼尔·韦伯"
	if err := productionValidateRelationshipParticipants(plan); err == nil || !strings.Contains(err.Error(), "客体") {
		t.Fatalf("participant name drift accepted: %v", err)
	}
}

func TestProductionRelationshipsDoNotApplyOnePairVocabularyToOtherPairs(t *testing.T) {
	ledger := []productionRelationshipRecord{
		{Code: "REL-001", Subject: "角色甲", Object: "角色乙", Relation: "siblings", Direction: "older_sister_younger_brother", Canonical: "姐弟", Source: "选题证据", Scope: "全剧"},
		{Code: "REL-002", Subject: "角色丙", Object: "角色丁", Relation: "siblings", Direction: "older_brother_younger_sister", Canonical: "兄妹", Source: "已定总纲", Scope: "全剧"},
		{Code: "REL-003", Subject: "角色戊", Object: "角色己", Relation: "partners", Direction: "bidirectional", Canonical: "合作伙伴", Source: "制作设计", Scope: "当前篇章"},
	}
	for _, text := range []string{
		"角色甲和角色乙重逢。角色丙作为哥哥保护妹妹角色丁，这对兄妹随后加入合作伙伴的队伍。",
		"对白中角色戊将陌生人戏称为姐姐；这是一句玩笑，角色丙和妹妹角色丁仍是兄妹。",
		"古装喜剧：师兄与师妹互相斗嘴；另一对兄妹途经客栈。",
		"科幻动画：机体A调用代号“妹妹”的模块；角色甲与角色乙的既定关系继续有效。",
		"黑色犯罪剧：对手以“兄弟”套近乎，角色己引用片名《兄妹》，不表示真实亲属关系。",
	} {
		if issues := productionRelationshipConsistencyIssues("", text, ledger); len(issues) != 0 {
			t.Fatalf("unbound language or another pair caused a conflict: %q %v", text, issues)
		}
	}
}

func TestProductionRelationshipCanonicalLabelsAreLanguageIndependent(t *testing.T) {
	for _, test := range []struct{ direction, canonical string }{
		{"older_sister_younger_brother", "姐弟"},
		{"older_brother_younger_sister", "兄妹"},
		{"older_sister_younger_sister", "姐妹"},
		{"older_brother_younger_brother", "兄弟"},
		{"older_sister_younger_brother", "older sister and younger brother"},
		{"older_brother_younger_sister", "兄と妹"},
		{"older_to_younger", "siblings"},
		{"siblings_unspecified", "手足"},
	} {
		record := productionRelationshipRecord{Code: "REL-001", Subject: "A", Object: "B", Relation: "siblings", Direction: test.direction, Canonical: test.canonical, Source: "用户确认的原文证据", Scope: "全剧"}
		ledger, found, err := productionExtractRelationshipLedger(relationshipLedgerRow(record))
		if err != nil || !found || len(ledger) != 1 || ledger[0].Direction != test.direction || ledger[0].Canonical != test.canonical {
			t.Fatalf("wording changed declared facts: %+v %v %+v", test, err, ledger)
		}
	}
}

func TestProductionRelationshipStructuredConflictsRemainBoundToSameID(t *testing.T) {
	baseline := productionRelationshipRecord{Code: "REL-001", Subject: "A", Object: "B", Relation: "partners", Direction: "subject_to_object", Canonical: "任务委托方与承接方", Source: "原文第一个场次", Scope: "第一篇章"}
	for _, field := range []string{"subject", "object", "relation", "direction", "source", "scope"} {
		t.Run(field, func(t *testing.T) {
			current := baseline
			switch field {
			case "subject":
				current.Subject = "C"
			case "object":
				current.Object = "D"
			case "relation":
				current.Relation = "rivals"
			case "direction":
				current.Direction = "object_to_subject"
			case "source":
				current.Source = ""
			case "scope":
				current.Scope = ""
			}
			if issues := productionRelationshipConsistencyIssues("", relationshipLedgerRow(current), []productionRelationshipRecord{baseline}); len(issues) == 0 {
				t.Fatalf("explicit structured %s conflict or missing required evidence was accepted", field)
			}
		})
	}
	current := baseline
	current.Canonical, current.Source = "委托双方", "补充原文证据"
	if issues := productionRelationshipConsistencyIssues("", relationshipLedgerRow(current), []productionRelationshipRecord{baseline}); len(issues) != 0 {
		t.Fatalf("equivalent labels or additional evidence were treated as changed identity: %v", issues)
	}
	current.Code, current.Subject, current.Object = "REL-002", "C", "D"
	if issues := productionRelationshipConsistencyIssues("", relationshipLedgerRow(current), []productionRelationshipRecord{baseline}); len(issues) != 0 {
		t.Fatalf("different relation IDs were compared as the same pair: %v", issues)
	}
	current = baseline
	current.Object = "C"
	duplicated := relationshipLedgerRow(baseline) + "\n" + relationshipLedgerRow(current)
	if issues := productionRelationshipConsistencyIssues("", duplicated, nil); len(issues) != 1 || !strings.Contains(issues[0], "REL-001") {
		t.Fatalf("conflicting duplicate ledger ID escaped validation: %v", issues)
	}
}

func TestProductionRelationshipLegacyBaselineAndUnrelatedDialogueDoNotRequireInferredLedger(t *testing.T) {
	for _, baseline := range []string{"姐姐喜欢听《兄妹》这首歌。", "弟弟是一段引用中的称谓，没有人物身份绑定。", "旧稿里的哥哥是外号，双方无亲属关系。"} {
		if issues := productionRelationshipConsistencyIssues(baseline, "其他角色是合作伙伴，他们提及兄弟姐妹的泛称。", nil); len(issues) != 0 {
			t.Fatalf("legacy prose created unregistered facts: %v", issues)
		}
	}
	for _, relationships := range []string{"没有可锁定的人物关系；机器独自修复系统。", "无已定亲属关系。旁白引用“姐姐和弟弟”的旧童谣，不能据此登记关系事实。", "两名调查员仅在本篇章合作，方向与称呼尚无原文证据，标明待核。"} {
		s, _, run := planFixture(t, 3)
		productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
		document := orderedPlanDocument("story", "")
		document["relationships"] = relationships
		productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "总纲", "document": document, "factIds": []string{}}, false)
		m, _, rows := orderedPlanState(t, s, run.ID)
		if len(rows) != 1 || len(m.Plan.Relationships) != 0 {
			t.Fatal("natural language was turned into structured relationship facts")
		}
	}
}

func TestProductionRelationshipHistoricalReceiptKeepsDeclaredDirectionWithoutReinterpretingProse(t *testing.T) {
	s, _, run := planFixture(t, 3)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	document := orderedPlanDocument("story", "")
	record := productionRelationshipRecord{Code: "REL-001", Subject: "角色甲", Object: "角色乙", Relation: "siblings", Direction: "older_to_younger", Canonical: "姐姐与弟弟", Source: "选题原文", Scope: "全剧"}
	document["relationships"] = relationshipLedgerRow(record)
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "总纲", "document": document, "factIds": []string{}}, false)
	m, _, _ := orderedPlanState(t, s, run.ID)
	// Reproduce the old writer's stored manifest normalization. The original
	// receipt and its hash remain unchanged throughout the service boundary.
	m.Plan.Relationships[0].Direction = "older_sister_younger_brother"
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, productionJSON(m)); err != nil {
		t.Fatal(err)
	}
	s = &Service{repo: s.repo, dataDir: s.dataDir, disablePiRuntime: true}
	m, doc, rows := orderedPlanState(t, s, run.ID)
	if !productionPlanArtifactValid(m, doc, rows, "story") || m.Plan.Relationships[0].Direction != "older_sister_younger_brother" {
		t.Fatal("unchanged historical receipt was invalidated or its stored fact rewritten")
	}
	current := record
	current.Direction = "older_brother_younger_sister"
	if issues := productionRelationshipConsistencyIssues("", relationshipLedgerRow(current), m.Plan.Relationships, true); len(issues) == 0 {
		t.Fatal("historical precision handling equated different specific directions")
	}
	intermediate := relationshipLedgerRow(record) + "\n" + relationshipLedgerRow(current)
	if issues := productionRelationshipConsistencyIssues("", intermediate, m.Plan.Relationships, true); len(issues) == 0 {
		t.Fatal("a generic intermediate row hid different specific directions")
	}
	if issues := productionRelationshipConsistencyIssues("", relationshipLedgerRow(record), m.Plan.Relationships); len(issues) == 0 {
		t.Fatal("new submission was silently treated as a historical receipt")
	}
	changed := orderedPlanDocument("direction", "")
	changed["performance"] = relationshipLedgerRow(current)
	changedContent, err := productionRenderPlanDocument("direction", "", changed)
	if err != nil {
		t.Fatal(err)
	}
	if issues := productionPlanContinuityIssues(m, doc, rows, "direction", changedContent, changed); len(issues) == 0 {
		t.Fatal("new document with explicit contradictory direction escaped validation")
	}
}
