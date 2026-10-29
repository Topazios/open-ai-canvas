package app

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// productionRelationshipRecord is the small, durable fact used by every
// later production document.  Prose may vary, but the subject, object and
// directional relationship do not.
type productionRelationshipRecord struct {
	Code      string `json:"code"`
	Subject   string `json:"subject"`
	Object    string `json:"object"`
	Relation  string `json:"relation"`
	Direction string `json:"direction"`
	Canonical string `json:"canonical"`
	Source    string `json:"source"`
	Scope     string `json:"scope"`
}

var productionRelationshipKinds = map[string]bool{
	"siblings": true, "parent_child": true, "partners": true, "spouse": true,
	"rivals": true, "friends": true, "colleagues": true, "guardian": true,
	"employer_employee": true, "former_partners": true, "accomplices": true,
	"captor_captive": true, "seller_buyer": true, "source_journalist": true,
	"other": true,
}

var productionRelationshipDirections = map[string]bool{
	"none":                          true,
	"bidirectional":                 true,
	"subject_to_object":             true,
	"object_to_subject":             true,
	"siblings_unspecified":          true,
	"older_sister_younger_brother":  true,
	"older_brother_younger_sister":  true,
	"older_sister_younger_sister":   true,
	"older_brother_younger_brother": true,
	"older_to_younger":              true,
	"parent_to_child":               true,
	"child_to_parent":               true,
}

var productionRelationshipRowStart = regexp.MustCompile(`(?i)^REL-[0-9]+(?:$|[\s|｜;；])`)

func productionRelationshipLedgerContract() string {
	keys := func(values map[string]bool) []string {
		result := make([]string, 0, len(values))
		for key := range values {
			result = append(result, key)
		}
		sort.Strings(result)
		return result
	}
	return "关系登记格式：REL-001 | 主体：人物名称 | 客体：人物名称 | 类型：固定类型 | 方向：固定方向 | 规范称呼：明确称谓 | 来源：依据 | 适用范围：范围。也可使用同列序的八列 Markdown 表格，编号使用至少三位数字。类型仅可选：" + strings.Join(keys(productionRelationshipKinds), ", ") + "。方向仅可选：" + strings.Join(keys(productionRelationshipDirections), ", ") + "。没有精确类型用 other，并在规范称呼说明，不自行扩充枚举。siblings 必须采用与主体、客体及规范称呼相符的具体亲属方向或 siblings_unspecified；非亲属单向关系使用 subject_to_object 或 object_to_subject，双向使用 bidirectional。全部字段写在 document.relationships 内，不放到工具参数顶层。"
}

// productionExtractRelationshipLedger reads the compact ledger requested in
// the story relationships field.  It accepts both Chinese and English field
// labels so a model can write Chinese prose while keeping the contract
// machine-checkable.
func productionExtractRelationshipLedger(text string) ([]productionRelationshipRecord, bool, error) {
	records := []productionRelationshipRecord{}
	found := false
	var failures []error
	rowIndex := 0
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(strings.Trim(strings.TrimSpace(raw), "|｜`* "))
		if !productionRelationshipRowStart.MatchString(line) {
			continue
		}
		rowIndex++
		found = true
		parts := strings.FieldsFunc(line, func(r rune) bool { return r == '|' || r == '｜' || r == '；' || r == ';' })
		fields := map[string]string{}
		for index, part := range parts {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if index == 0 && strings.HasPrefix(strings.ToUpper(part), "REL-") {
				fields["code"] = part
				continue
			}
			key, value, ok := splitProductionRelationshipField(part)
			if !ok {
				continue
			}
			fields[normalizeProductionRelationshipField(key)] = strings.TrimSpace(value)
		}
		// Models commonly render the required ledger as a Markdown table. The
		// column order is part of the document contract, so accept that form as
		// well as the labeled field form above.
		// A labeled row can contain an empty value (for example, "来源：").
		// Do not reinterpret that row as a positional Markdown table, otherwise
		// the labels themselves become values and required-field defects vanish.
		if !relationshipFieldsComplete(fields) && len(fields) <= 1 {
			if cells, ok := parseProductionRelationshipTableRow(raw); ok {
				fields = map[string]string{
					"code":      cells[0],
					"subject":   cells[1],
					"object":    cells[2],
					"relation":  cells[3],
					"direction": cells[4],
					"canonical": cells[5],
					"source":    cells[6],
					"scope":     cells[7],
				}
			}
		}
		record := productionRelationshipRecord{
			Code: strings.TrimSpace(strings.Trim(fields["code"], "`")), Subject: strings.TrimSpace(fields["subject"]),
			Object: strings.TrimSpace(fields["object"]), Relation: strings.TrimSpace(fields["relation"]),
			Direction: normalizeProductionRelationshipDirection(fields["direction"]), Canonical: strings.TrimSpace(fields["canonical"]),
			Source: strings.TrimSpace(fields["source"]), Scope: strings.TrimSpace(fields["scope"]),
		}
		if err := productionValidateRelationshipRecord(record); err != nil {
			issues := cloudAgentValidationIssues(err)
			if len(issues) == 0 {
				failures = append(failures, cloudAgentFieldError(fmt.Sprintf("relationships[%d]", rowIndex-1), "invalid_relationship_record", err.Error()))
			} else {
				for _, issue := range issues {
					failures = append(failures, cloudAgentFieldError(fmt.Sprintf("relationships[%d].%s", rowIndex-1, issue.Field), issue.Issue, issue.Message))
				}
			}
			continue
		}
		records = append(records, record)
	}
	if len(records) == 0 && found {
		if len(failures) == 0 {
			failures = append(failures, cloudAgentFieldError("relationships", "invalid_relationship_ledger", "人物关系登记表存在但格式不完整；请按 REL-001 | 主体：... | 客体：... | 类型：siblings | 方向：... | 规范称呼：... | 来源：... | 适用范围：... 填写"))
		}
	}
	if err := cloudAgentValidationErrors(failures...); err != nil {
		return records, found, err
	}
	return records, found, nil
}

func relationshipFieldsComplete(fields map[string]string) bool {
	for _, key := range []string{"code", "subject", "object", "relation", "direction", "canonical", "source", "scope"} {
		if strings.TrimSpace(fields[key]) == "" {
			return false
		}
	}
	return true
}

func parseProductionRelationshipTableRow(raw string) ([]string, bool) {
	if !strings.ContainsAny(raw, "|｜") {
		return nil, false
	}
	row := strings.ReplaceAll(strings.TrimSpace(raw), "｜", "|")
	row = strings.TrimPrefix(strings.TrimSuffix(row, "|"), "|")
	parts := strings.Split(row, "|")
	cells := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(strings.Trim(part, "`"))
		cells = append(cells, part)
	}
	if len(cells) != 8 || !strings.HasPrefix(strings.ToUpper(strings.TrimSpace(cells[0])), "REL-") {
		return nil, false
	}
	for _, cell := range cells[1:] {
		if strings.TrimSpace(cell) == "" || strings.HasPrefix(cell, "---") {
			return nil, false
		}
	}
	return cells, true
}

func normalizeProductionRelationshipDirection(direction string) string {
	direction = strings.ToLower(strings.TrimSpace(direction))
	return strings.NewReplacer("-", "_", " ", "_").Replace(direction)
}

func splitProductionRelationshipField(value string) (string, string, bool) {
	for _, separator := range []string{"：", ":"} {
		if index := strings.Index(value, separator); index >= 0 {
			return strings.TrimSpace(value[:index]), strings.TrimSpace(value[index+len(separator):]), true
		}
	}
	return "", "", false
}

func normalizeProductionRelationshipField(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	switch value {
	case "rel", "关系编号", "编号":
		return "code"
	case "subject", "主体", "关系主体":
		return "subject"
	case "object", "客体", "关系客体":
		return "object"
	case "relation", "type", "类型", "关系类型":
		return "relation"
	case "direction", "方向":
		return "direction"
	case "canonical", "规范称呼", "对外称呼":
		return "canonical"
	case "source", "来源":
		return "source"
	case "scope", "适用范围":
		return "scope"
	default:
		return value
	}
}

func productionValidateRelationshipRecord(record productionRelationshipRecord) error {
	failures := []error{}
	for _, field := range []struct {
		key, label, value string
	}{
		{"code", "编号", record.Code}, {"subject", "主体", record.Subject}, {"object", "客体", record.Object},
		{"relation", "类型", record.Relation}, {"direction", "方向", record.Direction}, {"canonical", "规范称呼", record.Canonical},
		{"source", "来源", record.Source}, {"scope", "适用范围", record.Scope},
	} {
		if strings.TrimSpace(field.value) == "" {
			failures = append(failures, cloudAgentFieldError(field.key, "required", "人物关系记录缺少"+field.label))
		}
	}
	if record.Code != "" && (!strings.HasPrefix(strings.ToUpper(record.Code), "REL-") || len(record.Code) < 7) {
		failures = append(failures, cloudAgentFieldError("code", "invalid_format", "人物关系编号必须使用 REL-001 形式"))
	}
	if record.Relation != "" && !productionRelationshipKinds[record.Relation] {
		failures = append(failures, cloudAgentFieldError("relation", "invalid_enum", "人物关系类型不属于固定枚举："+record.Relation))
	}
	if record.Direction != "" && !productionRelationshipDirections[record.Direction] {
		failures = append(failures, cloudAgentFieldError("direction", "invalid_enum", "人物关系方向不属于固定枚举："+record.Direction))
	}
	if record.Subject != "" && record.Subject == record.Object {
		failures = append(failures, cloudAgentFieldError("object", "same_participant", "人物关系主体和客体不能是同一对象："+record.Code))
	}
	return cloudAgentValidationErrors(failures...)
}

func productionValidationIssueMessages(err error) []string {
	issues := cloudAgentValidationIssues(err)
	if len(issues) == 0 {
		if err == nil {
			return nil
		}
		return []string{err.Error()}
	}
	result := make([]string, 0, len(issues))
	for _, issue := range issues {
		result = append(result, issue.Field+"："+issue.Message)
	}
	return result
}

// Only explicit ledger facts can establish an automatic conflict. Free prose
// needs contextual review of its participants, evidence and applicable scope;
// isolated words cannot identify a relationship or establish a contradiction.
func productionRelationshipConsistencyIssues(baseline string, content string, ledger []productionRelationshipRecord, historicalReceipt ...bool) []string {
	issues := []string{}
	if len(ledger) == 0 {
		var err error
		ledger, _, err = productionExtractRelationshipLedger(baseline)
		if err != nil {
			issues = append(issues, productionValidationIssueMessages(err)...)
		}
	}
	current, _, err := productionExtractRelationshipLedger(content)
	if err != nil {
		issues = append(issues, productionValidationIssueMessages(err)...)
	}
	byCode := map[string]productionRelationshipRecord{}
	allowHistoricalPrecision := len(historicalReceipt) > 0 && historicalReceipt[0]
	for _, record := range append(append([]productionRelationshipRecord{}, ledger...), current...) {
		if err := productionValidateRelationshipRecord(record); err != nil {
			issues = append(issues, productionValidationIssueMessages(err)...)
			continue
		}
		code := strings.ToUpper(record.Code)
		if previous, exists := byCode[code]; exists {
			if record.Subject != previous.Subject || record.Object != previous.Object || record.Relation != previous.Relation || productionRelationshipDirectionsConflict(previous, record, allowHistoricalPrecision) {
				issues = append(issues, fmt.Sprintf("%s 的结构化关系事实不一致：已登记主体=%s、客体=%s、类型=%s、方向=%s；当前主体=%s、客体=%s、类型=%s、方向=%s。请核对双方原文证据及适用范围，保留来源，明确修正关系记录，不凭称呼关键词判断。", record.Code, previous.Subject, previous.Object, previous.Relation, previous.Direction, record.Subject, record.Object, record.Relation, record.Direction))
				continue
			}
			// Keep the explicit specific fact in this comparison index. A later
			// generic historical row must not hide conflicting specific records.
			if previous.Direction != "older_to_younger" || record.Direction == "older_to_younger" {
				continue
			}
		}
		byCode[code] = record
	}
	return uniqueProductionContinuityIssues(issues)
}

func productionRelationshipDirectionsConflict(previous, current productionRelationshipRecord, historicalReceipt bool) bool {
	if previous.Direction == current.Direction {
		return false
	}
	// Older writers inferred a more specific manifest direction from canonical
	// prose while saving older_to_younger unchanged in the receipt. Only compare
	// that historical precision difference; never rewrite either fact or infer it
	// for a new submission, and never equate two different specific directions.
	if historicalReceipt && previous.Relation == "siblings" && current.Relation == "siblings" {
		generic, specific := previous.Direction, current.Direction
		if specific == "older_to_younger" {
			generic, specific = specific, generic
		}
		if generic == "older_to_younger" {
			switch specific {
			case "older_sister_younger_brother", "older_brother_younger_sister", "older_sister_younger_sister", "older_brother_younger_brother":
				return false
			}
		}
	}
	return true
}

func uniqueProductionContinuityIssues(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		if strings.TrimSpace(value) == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func productionRelationshipIssueIdentity(issue string, ordinal int) string {
	if index := strings.Index(issue, "REL-"); index >= 0 {
		end := index
		for end < len(issue) && ((issue[end] >= 'A' && issue[end] <= 'Z') || (issue[end] >= 'a' && issue[end] <= 'z') || (issue[end] >= '0' && issue[end] <= '9') || issue[end] == '-') {
			end++
		}
		if end > index {
			return string(issue[index:end])
		}
	}
	return fmt.Sprintf("issue[%d]", ordinal)
}

func productionRelationshipValidationText(document map[string]string, content string) string {
	if len(document) == 0 {
		return content
	}
	parts := make([]string, 0, len(document))
	keys := make([]string, 0, len(document))
	for key := range document {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		parts = append(parts, document[key])
	}
	if len(parts) == 0 {
		return content
	}
	return strings.Join(parts, "\n")
}

func productionPlanStoryContent(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, currentKey, currentContent string) string {
	if currentKey == "story" {
		return currentContent
	}
	for _, artifact := range artifacts {
		if artifact.Key != "story" {
			continue
		}
		node := productionNode(doc, artifact.NodeID)
		meta, _ := node["metadata"].(map[string]any)
		return stringValue(meta["content"])
	}
	return ""
}

func productionPlanContinuityIssues(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, key, content string, document map[string]string) []string {
	// Relationship ledgers became mandatory under the continuity contract, not
	// plan v3 itself. Do not reinterpret already saved pre-contract documents.
	if m.Plan == nil || m.Plan.Version < 3 || m.Plan.ContinuityVersion == 0 {
		return nil
	}
	baseline := productionPlanStoryContent(m, doc, artifacts, key, content)
	if strings.TrimSpace(baseline) == "" {
		return nil
	}
	historicalReceipt := false
	for _, artifact := range artifacts {
		if artifact.Key != key {
			continue
		}
		node := productionNode(doc, artifact.NodeID)
		meta, _ := node["metadata"].(map[string]any)
		historicalReceipt = stringValue(meta["content"]) == content && productionArtifactMatches(node, artifact.ContentHash)
		break
	}
	return productionRelationshipConsistencyIssues(baseline, productionRelationshipValidationText(document, content), m.Plan.Relationships, historicalReceipt)
}

func productionValidateRelationshipParticipants(plan productionPlan) error {
	if plan.ContinuityVersion == 0 || len(plan.Relationships) == 0 {
		return nil
	}
	characters := []string{}
	for _, item := range plan.Assets {
		if item.Kind == "character" {
			characters = append(characters, item.Name)
		}
	}
	var failures []error
	for i, relationship := range plan.Relationships {
		for _, participantField := range []struct{ key, label, value string }{{"subject", "主体", relationship.Subject}, {"object", "客体", relationship.Object}} {
			label, participant := participantField.label, participantField.value
			matched := false
			for _, character := range characters {
				if productionIdentityTextMatches(participant, character) {
					matched = true
					break
				}
			}
			if !matched {
				failures = append(failures, cloudAgentFieldError(fmt.Sprintf("relationships[%d].%s", i, participantField.key), "unregistered_participant", fmt.Sprintf("关系 %s 的%s“%s”未在人物资产清单中登记；请沿用关系登记表中的人物名称或先补充同一人物的别名", truncateRunes(relationship.Code, 40), label, truncateRunes(participant, 80))))
			}
		}
	}
	return cloudAgentValidationErrors(failures...)
}

func productionIdentityTextMatches(left, right string) bool {
	clean := func(value string) string {
		value = strings.ToLower(strings.TrimSpace(value))
		value = strings.NewReplacer("·", "", "・", "", " ", "", "　", "", "-", "", "_", "").Replace(value)
		return value
	}
	left, right = clean(left), clean(right)
	return left != "" && right != "" && (left == right || strings.Contains(left, right) || strings.Contains(right, left))
}

type productionStateSource string

func productionValidSoundKind(kind string) bool {
	switch kind {
	case "voice", "prop", "ambience", "music":
		return true
	}
	return false
}

const productionContinuityPolicy = `制作时先建立资产总表、人物造型转换表和声音总表，收纳在现有四份规范及资产档案，不额外创建文稿。身份码、状态变体码和修订版分离。变体只用于资产本身发生重大形态、结构或身份变化，且变化后需要独立参考图、独立制作约束或独立资产码才能稳定复用；变身、兽化、机械化、显著年龄或体型形态变化、场景拓扑完全改变、道具结构完全改变可以登记。疲惫、情绪、普通受伤、包扎、血迹、灰尘、污渍、湿润、轻微破损、普通换装、持物、开合、运行、位置、日夜、天气、开关灯和光照变化均写入正文、continuity、镜头前后状态、动作/表演描述或提示词，不创建变体；没有重大形态变化时 variants 必须为空。活动、职业、时间或剧情事件需要换装妆造时，只有造成必须独立参考的重大形态变化才列来源类别script/design、依据basis、触发trigger、前态previousState、范围scope和结束/恢复recovery；普通活动切换只记录连续性，不强制换衣镜头。公共规范只在document中规划重大形态转换，不提交design或自行分配变体编码，独立资产档案阶段才同步design.variants并由系统分配编码。不可逆变化不能在切镜或跨集后自动恢复，同一事件的发生集次保持唯一，时间收支须可核算。转换表逐项核对总纲和已定美术设计，不能把普通伤势、污渍、持物或光照波动扩成变体。场景与道具给统一单位的真实尺寸、相对人体尺度与固定空间锚点，切镜只改透视不改物理尺寸。人物声线以人物档案和CHR编码为唯一权威，声音总表按人物编码登记制作引用，不强制为每位人物另造AUD；声音只有变成需要独立复用的全新声源或制作形态时才登记变体，情绪、音量、语速和场景适配写入表演或声音提示。独立复用的音乐、环境或动作声音才登记AUD；subjectKeys指关联主体，dependsOn只列确实必须先完成的设计，普通关联不等于设计依赖。声纹身份固定，同语言人物试听采用统一校准文本。无需待确认状态或人工审批，完成即可使用。媒体实际制作按依赖和系统各类型并发策略执行。`

const (
	productionStateScript productionStateSource = "script"
	productionStateDesign productionStateSource = "design"
)

func productionValidateVariant(v productionDesignVariant) error {
	// Historical variants remain readable; explicitly structured transitions
	// must carry their cause and scope rather than a human approval status.
	if v.Source == "" {
		return nil
	}
	failures := []error{}
	if productionStateSource(v.Source) != productionStateScript && productionStateSource(v.Source) != productionStateDesign {
		failures = append(failures, cloudAgentFieldError("source", "invalid_enum", "状态来源必须是 script（故事明确）或 design（制作设计补充）"))
	}
	for _, field := range []struct {
		key, label, value string
	}{
		{"basis", "来源依据", v.Basis}, {"trigger", "触发事件", v.Trigger}, {"previousState", "前置状态", v.PreviousState},
		{"scope", "生效范围", v.Scope}, {"recovery", "结束/恢复条件", v.Recovery},
	} {
		if strings.TrimSpace(field.value) == "" {
			failures = append(failures, cloudAgentFieldError(field.key, "required", "状态变化缺少"+field.label))
		}
	}
	return cloudAgentValidationErrors(failures...)
}

func productionMatchVariantCodes(variants, previous []productionDesignVariant) error {
	used := map[string]bool{}
	names := map[string]bool{}
	failures := []error{}
	for i := range variants {
		v := &variants[i]
		requested := v.Code
		matched := ""
		for _, old := range previous {
			if (requested != "" && old.Code == requested) || (requested == "" && old.Name == v.Name) {
				matched = old.Code
				break
			}
		}
		v.Code = matched
		if requested != "" && v.Code == "" {
			failures = append(failures, cloudAgentFieldError(fmt.Sprintf("variants[%d].code", i), "foreign_code", "状态编码不属于当前资产，新增状态请留空由系统分配"))
		}
		if names[v.Name] {
			failures = append(failures, cloudAgentFieldError(fmt.Sprintf("variants[%d].name", i), "duplicate", "状态名称重复"))
		}
		if v.Code != "" && used[v.Code] {
			failures = append(failures, cloudAgentFieldError(fmt.Sprintf("variants[%d].code", i), "duplicate", "状态编码重复"))
		}
		names[v.Name] = true
		if v.Code != "" {
			used[v.Code] = true
		}
	}
	return cloudAgentValidationErrors(failures...)
}

var productionAssetFieldRequirements = map[string]map[string]string{
	"character": {
		"appearance": "固定身份识别锚点、年龄阶段、身高、体重、肩宽及适用的胸围/腰围/臀围；形成可复用的身体比例表，身份编号不随服装或修订变化。故事未提供时标为制作设计估算，避免对不适用年龄或体型机械填写三围。",
		"costume":    "规划日常、工作及剧情活动所需服装，说明穿着层次、材质与配色；普通搭配和一次性活动造型写在正文与continuity，只有需要独立参考图的重大形态变化才进入变体。",
		"hairMakeup": "固定辨识点并规划活动对应妆发；伤势、湿污、血迹、灰尘等普通连续性状态写入正文、镜头状态或提示词，不创建变体。",
		"variants":   "只给重大形态、结构或身份变化的转换表：变化后必须需要独立参考图、独立制作约束或独立资产码，例如变身、兽化、机械化、显著年龄/体型变化。记录状态名、固定特征/变化、来源类别（script/design）、来源依据、前态、触发事件、生效范围、结束/恢复条件；疲惫、受伤、污渍、湿润、轻微破损、普通换装、持物、开合、运行、位置、日夜天气和光照写入正文连续性，未发生重大形态变化时 variants 填空数组。design.variants 同步结构化字段，不要求人工确认；系统分配变体编码，不另造人物。",
		"sound":      "以本人物 @CHR 编码登记声线制作引用，人物档案唯一维护声线，不强制创建对应 AUD。确有独立复用的声音才引用已登记 @AUD 编号与用途；固定音色身份与口音，情绪和语速可在表演范围内变化。各人物试听使用项目同一语言的同一校准文本，不把样本当成整集配音。",
	},
	"environment": {
		"layout":           "给尺度与空间表：统一单位，标明空间长宽净高、面积/占地面积、门窗墙角及固定地标坐标/相对位置，并以人物身高作参照；故事未给尺寸时作为明确的制作设计估算补充。各视角、平面和剖面共用同一组尺寸和坐标。",
		"spatialRelations": "固定门窗、出入口、通道及家具相对位置、可达关系和尺度。切镜只改变透视与遮挡，不改变真实空间尺寸。",
		"variants":         "只有场景拓扑、结构或固定陈设发生重大改变，且需要独立空间参考或独立资产码时才登记变体。日夜、天气、光照、开关灯和普通陈设变化写入lighting、continuity或镜头状态；重大变化才列前态、来源、触发、生效范围和恢复，并依照 design.variants 的 script/design 结构填写。",
		"sound":            "说明本场景环境声与所属 @SCN 编码；确需独立复用时关联已登记 @AUD，未单建时说明由场景档案承载，不编造编码。空间混响随同一真实空间与听点变化，切镜不能随机换底噪。",
	},
	"prop": {
		"appearance": "给统一单位的长宽高/直径、适用时重量、相对人物身高或手掌的尺寸比例、轮廓、色彩与固定标识；视角只改变投影，不改变物理尺寸。",
		"variants":   "只有道具结构、部件或身份发生重大变化，且需要独立参考图或独立资产码时才登记变体。拥有者、开合、运行、位置、轻微损坏、湿污、消耗和普通动作写入正文、continuity或镜头状态；重大变化才列来源、前态、触发、范围及恢复条件，不可逆变化持续。",
		"sound":      "以本 @PRP 编码说明开、关、碰撞等实际动作声音；独立复用时才引用已登记 @AUD，不为每次使用新建身份或编造声音编码。",
	},
	"sound": {
		"soundType":         "区分道具动作声、环境声、音乐母题；design.soundKind 沿用 voice/prop/ambience/music 枚举以便读取历史档案。人物声线以人物档案为权威，不强制单建AUD。独立声音总表使用已登记 AUD，只有实际依赖才等待所属档案，不在图像提示词中混用。",
		"subjectReferences": "列所属人物/道具/场景编码，区分subjectKeys普通关联和dependsOn设计先后；普通关联不强制依赖。复用已定声线和物理材质，声音不是另一个人物身份。",
		"variants":          "只有声音变成需要独立复用的全新声源或制作形态时才列变体、触发和范围；动作、使用情境、音量、语速、情绪和场景适配写入cues、emotion或提示词，角色情绪不更换声纹。",
		"prompt":            "分开实际朗读文本与声音设计/表演指令；人物样本使用系统统一校准文本。环境声/道具声仅交给明确支持音效的模型，禁止用朗读伪装音效。",
	},
}
