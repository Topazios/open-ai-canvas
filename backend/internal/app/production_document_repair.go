package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
)

// Nest validators' relative document paths beneath the submitted field before
// they reach repair checkpoints, keeping equal defects in different sections
// independently addressable.
func productionDocumentIssueField(sectionKey, field string) string {
	prefix := "document." + sectionKey
	if field == prefix || strings.HasPrefix(field, prefix+".") {
		return field
	}
	field = strings.TrimPrefix(field, "document.")
	if field == "" {
		return prefix
	}
	return prefix + "." + field
}

func productionParallelCallError(work productionParallelWork, call cloudAgentCall, toolName string) error {
	var args map[string]any
	if err := decodeCloudAgentJSONObject(call.Function.Arguments, &args); err != nil {
		return cloudAgentJSONArgumentError(err)
	}
	if toolName == "production_storyboard_expand" {
		shot, _ := args["shot"].(map[string]any)
		if stringValue(shot["id"]) != work.Key {
			return cloudAgentFieldError("shot.id", "work_identity", "返回的镜头编号与当前分工不一致，请沿用指定的 sceneId 和 shot.id")
		}
		return nil
	}
	for _, field := range []struct{ key, value string }{{"key", work.Key}, {"name", work.Name}} {
		if value, ok := args[field.key].(string); !ok || value != field.value {
			if err := productionDocumentArgumentsError(call.Function.Arguments); err != nil {
				return err
			}
			return cloudAgentFieldError(field.key, "work_identity", "文稿 "+field.key+" 与当前分工不一致，请原样沿用 nextAction.arguments."+field.key)
		}
	}
	if work.TargetHash != nil {
		raw, supplied := args["expectedHash"]
		expected, ok := raw.(string)
		if (supplied && !ok) || expected != *work.TargetHash {
			return productionDocumentVersionArgumentError(*work.TargetHash)
		}
	}
	return nil
}

func productionDocumentVersionArgumentError(expected string) error {
	message := "expectedHash 必须原样沿用 nextAction.arguments.expectedHash，不得使用前置文稿的版本号"
	if expected == "" {
		message = "当前为新建文稿，expectedHash 必须为空字符串 \"\"，不得使用故事总纲、资产总表或其他文稿的哈希"
	}
	return cloudAgentFieldError("expectedHash", "part_version", message)
}

func productionValidationFailureSignature(work productionParallelWork, failure error, task *model.Task) string {
	var arguments any
	if task != nil {
		var result struct {
			ToolCalls []cloudAgentCall `json:"toolCalls"`
		}
		if json.Unmarshal([]byte(task.ResultJSON), &result) == nil {
			calls := make([]any, 0, len(result.ToolCalls))
			for _, call := range result.ToolCalls {
				var decoded any
				if json.Unmarshal([]byte(call.Function.Arguments), &decoded) != nil {
					decoded = call.Function.Arguments
				}
				calls = append(calls, []any{call.Function.Name, decoded})
			}
			arguments = calls
		}
	}
	var field *cloudAgentFieldArgumentError
	if errors.As(failure, &field) {
		return productionStoredValueHash([]any{work.Key, field.Field, field.Issue, cloudAgentValidationIssues(failure), arguments})
	}
	return productionStoredValueHash([]any{work.Key, cloudAgentSafeToolError(failure), arguments})
}

// Rejected prose stays private. Only structurally valid, declared chapters can
// become checkpoints; every merged result still passes the full business checks.
func productionPrepareDocumentRepair(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, work *productionParallelWork, task *model.Task, failure error) {
	var fieldError *cloudAgentFieldArgumentError
	if !errors.As(failure, &fieldError) {
		return
	}
	issues := cloudAgentValidationIssues(failure)
	var result struct {
		ToolCalls []cloudAgentCall `json:"toolCalls"`
	}
	if json.Unmarshal([]byte(task.ResultJSON), &result) != nil || len(result.ToolCalls) != 1 || result.ToolCalls[0].Function.Name != "production_submit" {
		return
	}
	call, bindErr := productionBindDocumentCall(*work, result.ToolCalls[0])
	if bindErr != nil {
		return
	}
	raw := call.Function.Arguments
	if len(raw) > productionToolArgumentsMaxBytes {
		return
	}
	rawFailure := false
	for _, issue := range issues {
		if issue.Issue == "misplaced_arguments" || issue.Issue == "field_type" {
			rawFailure = true
		}
	}
	if rawFailure {
		var args struct {
			Key          string                     `json:"key"`
			Name         string                     `json:"name"`
			Document     map[string]json.RawMessage `json:"document"`
			FactIDs      []string                   `json:"factIds"`
			ExpectedHash string                     `json:"expectedHash"`
			Design       *productionDesignFields    `json:"design"`
		}
		if decodeCloudAgentJSONObject(raw, &args) != nil || len(args.FactIDs) != 0 || len(args.Document) == 0 {
			return
		}
		for _, identity := range []struct{ root, field, expected string }{{args.Key, "key", work.Key}, {args.Name, "name", work.Name}} {
			var nested string
			if value, supplied := args.Document[identity.field]; supplied {
				if json.Unmarshal(value, &nested) != nil || nested != identity.expected {
					return
				}
			}
			if (identity.root != "" && identity.root != identity.expected) || (identity.root != identity.expected && nested != identity.expected) {
				return
			}
		}
		if _, shared := planSection(work.Key); shared && args.Design != nil {
			return
		}
		count := 0
		for key, value := range args.Document {
			count += utf8.RuneCountInString(key) + utf8.RuneCount(value)
		}
		if args.Design != nil {
			encoded, err := json.Marshal(args.Design)
			if err != nil {
				return
			}
			count += utf8.RuneCount(encoded)
		}
		if count > productionArtifactContentLimit(m, doc, work.Key)*2 || work.TargetHash == nil || *work.TargetHash != productionDocumentTargetHash(artifacts, work.Key) {
			return
		}
		if work.DocumentParts != nil && productionDocumentPartsVersion(m, doc, artifacts, *work) != nil {
			return
		}
		// Keep the rejected JSON as private retry context. No fields are moved,
		// coerced, staged as accepted chapters or written into an artifact.
		work.RepairDocumentRaw, work.RepairDocument = args.Document, nil
		if _, shared := planSection(work.Key); !shared && args.Design != nil {
			work.RepairDesign = args.Design
		}
		return
	}
	var args struct {
		Key          string                  `json:"key"`
		Name         string                  `json:"name"`
		Document     map[string]string       `json:"document"`
		FactIDs      []string                `json:"factIds"`
		ExpectedHash string                  `json:"expectedHash"`
		Design       *productionDesignFields `json:"design"`
	}
	if decodeCloudAgentJSONObject(raw, &args) != nil || args.Key != work.Key || args.Name != work.Name || len(args.FactIDs) != 0 {
		return
	}
	lengthFailure := false
	for _, issue := range issues {
		if issue.Field == "document" && issue.Issue == "field_length" {
			lengthFailure = true
		}
	}
	if len(args.Document) == 0 && !(lengthFailure && work.DocumentParts != nil) {
		return
	}
	count := 0
	for key, value := range args.Document {
		count += utf8.RuneCountInString(key) + utf8.RuneCountInString(value)
	}
	if count > productionArtifactContentLimit(m, doc, work.Key)*2 {
		return
	}
	work.RepairDocumentRaw = nil
	work.RepairDocument = args.Document
	schema := productionPlanDocumentSchemaVersion(m.Plan.Version)
	sections := productionPlanDocumentSectionsForSchema(work.Key, productionPlanKind(m, work.Key), schema)
	byKey := map[string]productionDocumentSection{}
	expected := make([]string, 0, len(sections))
	for _, section := range sections {
		byKey[section.Key] = section
		expected = append(expected, section.Key)
	}
	targetHash := productionDocumentTargetHash(artifacts, work.Key)
	if work.TargetHash == nil || *work.TargetHash != targetHash {
		return
	}
	if _, shared := planSection(work.Key); shared && args.Design != nil {
		return
	}
	if work.DocumentParts != nil {
		if productionDocumentPartsVersion(m, doc, artifacts, *work) != nil || len(work.DocumentParts.Pending) == 0 {
			return
		}
		expected = work.DocumentParts.Pending[0]
		if args.Design != nil && len(work.DocumentParts.Pending) > 1 {
			return
		}
	}
	for key := range args.Document {
		if !cloudAgentContainsString(expected, key) {
			// The next request receives this content for explicit reconciliation;
			// undeclared fields are never silently dropped from a saved artifact.
			return
		}
	}
	if lengthFailure && args.ExpectedHash == targetHash {
		if work.DocumentParts == nil {
			work.DocumentParts = &productionDocumentParts{SchemaVersion: schema, ExpectedHash: targetHash, Fields: map[string]string{}, Pending: [][]string{expected}}
		}
		if args.Design != nil {
			work.DocumentParts.RepairDesign = args.Design
		}
		if work.DocumentParts.RepairFields == nil {
			work.DocumentParts.RepairFields = map[string]string{}
		}
		for key, value := range args.Document {
			work.DocumentParts.RepairFields[key] = value
		}
		productionRebalanceDocumentParts(m, doc, work)
		work.RepairDocument = nil
		return
	}
	repairFields := map[string]bool{}
	versionOnly := len(issues) > 0
	for _, issue := range issues {
		field := strings.TrimPrefix(issue.Field, "document.")
		if strings.HasPrefix(issue.Field, "document.") {
			sectionField := field
			if _, known := byKey[sectionField]; !known {
				sectionField, _, _ = strings.Cut(field, ".")
			}
			if _, known := byKey[sectionField]; known {
				repairFields[sectionField] = true
			}
		}
		if issue.Field != "expectedHash" {
			versionOnly = false
		}
	}
	if len(repairFields) == 0 && !versionOnly {
		return
	}
	if !versionOnly && args.ExpectedHash != targetHash {
		return
	}
	accepted, pending := map[string]string{}, []string{}
	for _, field := range expected {
		value := args.Document[field]
		section := byKey[field]
		content := "## " + section.Title + "\n" + value
		if repairFields[field] || strings.TrimSpace(value) == "" || productionValidatePlanField(work.Key, productionPlanKind(m, work.Key), section, value) != nil || cloudAgentContainsString(productionPlanDocumentMissingForSchema(work.Key, productionPlanKind(m, work.Key), content, schema), field) {
			pending = append(pending, field)
		} else {
			accepted[field] = value
		}
	}
	if len(accepted) == 0 {
		return
	}
	if work.DocumentParts == nil {
		work.DocumentParts = &productionDocumentParts{SchemaVersion: schema, ExpectedHash: targetHash, Fields: map[string]string{}, Pending: [][]string{expected}}
	}
	parts := work.DocumentParts
	for key, value := range accepted {
		parts.Fields[key] = value
	}
	// An empty batch requires explicit acknowledgement of corrected metadata.
	parts.Pending[0] = pending
	if args.Design != nil {
		parts.RepairDesign = args.Design
	}
	if parts.RepairFields == nil {
		parts.RepairFields = map[string]string{}
	}
	for field := range accepted {
		delete(parts.RepairFields, field)
	}
	for _, field := range pending {
		if value := args.Document[field]; value != "" {
			parts.RepairFields[field] = value
		}
	}
	work.RepairDocument = nil
}

// Inspect the document before decoding its string values, so misplaced root
// arguments and non-string chapters produce an actionable field diagnostic.
func productionDocumentArgumentsError(raw string) error {
	var args map[string]json.RawMessage
	if err := decodeCloudAgentJSONObject(raw, &args); err != nil {
		return cloudAgentJSONArgumentError(err)
	}
	document, supplied := args["document"]
	if !supplied {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := decodeCloudAgentJSONObject(string(document), &fields); err != nil {
		return cloudAgentFieldError("document", "field_type", "document 必须是 JSON 对象，每个正文章节的值必须是字符串；key、name、factIds、expectedHash 与 document 并列放在工具参数根层级。")
	}
	misplaced := []string{}
	for _, key := range []string{"key", "name", "factIds", "expectedHash"} {
		if _, exists := fields[key]; exists {
			misplaced = append(misplaced, key)
		}
	}
	var failures []error
	if len(misplaced) > 0 {
		failures = append(failures, cloudAgentFieldError("document", "misplaced_arguments", "以下工具参数误放入 document："+productionDocumentDiagnosticKeys(misplaced)+"；按 nextAction.arguments 在与 document 并列的根层级填写这些参数，再从 document 移除同名键，保留全部正文章节。document 内只填写当前模板声明的正文字段。"))
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if cloudAgentContainsString(misplaced, key) {
			continue
		}
		var value string
		if len(fields[key]) == 0 || fields[key][0] != '"' || json.Unmarshal(fields[key], &value) != nil {
			failures = append(failures, cloudAgentFieldError("document."+key, "field_type", "document 章节 "+productionDocumentDiagnosticKeys([]string{key})+" 的值必须是字符串，不能是数组、对象、数字、布尔值或 null；保留正文并按当前模板修正类型。"))
		}
	}
	return cloudAgentValidationErrors(failures...)
}

// Inspect independently decodable chapters against the caller's current schema.
// A chapter with an invalid JSON type keeps its type diagnostic and raw draft;
// it is never coerced to text or misreported as a missing chapter.
func productionDocumentRawValidationError(raw, key, kind string, schema int, expected []string) error {
	base := productionDocumentArgumentsError(raw)
	var args map[string]json.RawMessage
	if decodeCloudAgentJSONObject(raw, &args) != nil {
		return base
	}
	var fields map[string]json.RawMessage
	if decodeCloudAgentJSONObject(string(args["document"]), &fields) != nil {
		return base
	}
	sections := productionPlanDocumentSectionsForSchema(key, kind, schema)
	if len(sections) == 0 {
		return base
	}
	partial := expected != nil
	if !partial {
		expected = make([]string, 0, len(sections))
		for _, section := range sections {
			expected = append(expected, section.Key)
		}
	}
	failures := []error{base}
	unknown := []string{}
	for field := range fields {
		if !cloudAgentContainsString(expected, field) && !cloudAgentContainsString([]string{"key", "name", "factIds", "expectedHash"}, field) {
			unknown = append(unknown, field)
		}
	}
	if len(unknown) > 0 {
		if partial {
			failures = append(failures, cloudAgentFieldError("document", "part_fields", "本批 document 含未声明字段："+productionDocumentDiagnosticKeys(unknown)+"；保留有效正文并合并到本批指定字段后移除额外键。本批只允许："+strings.Join(expected, ", ")))
		} else {
			failures = append(failures, productionDocumentUnknownFieldsError(sections, unknown))
		}
	}
	for _, section := range sections {
		if !cloudAgentContainsString(expected, section.Key) {
			continue
		}
		value, supplied := fields[section.Key]
		var text string
		if supplied && (len(value) == 0 || value[0] != '"' || json.Unmarshal(value, &text) != nil) {
			continue
		}
		if strings.TrimSpace(text) == "" {
			issue := "missing_sections"
			if partial {
				issue = "part_fields"
			}
			failures = append(failures, cloudAgentFieldError("document."+section.Key, issue, "请补齐 document 字段："+section.Key+"（"+section.Title+"）。没有对应项时明确说明不适用及原因，不要空填。"))
			continue
		}
		if err := productionValidatePlanField(key, kind, section, text); err != nil {
			failures = append(failures, err)
			continue
		}
		if cloudAgentContainsString(productionPlanDocumentMissingForSchema(key, kind, "## "+section.Title+"\n"+text, schema), section.Key) {
			failures = append(failures, cloudAgentFieldError("document."+section.Key, "missing_sections", "字段 "+section.Key+"（"+section.Title+"）只有标题或空代码围栏，请补充实际正文。"))
		}
	}
	return cloudAgentValidationErrors(failures...)
}

func productionDocumentDiagnosticKeys(keys []string) string {
	keys = append([]string{}, keys...)
	sort.Strings(keys)
	quoted := make([]string, 0, len(keys))
	for i, key := range keys {
		if i == 8 {
			quoted = append(quoted, fmt.Sprintf("另 %d 项", len(keys)-i))
			break
		}
		if runes := []rune(key); len(runes) > 64 {
			key = string(runes[:64]) + "…"
		}
		quoted = append(quoted, fmt.Sprintf("%q", key))
	}
	return strings.Join(quoted, ", ")
}

func productionDocumentUnknownFieldsError(sections []productionDocumentSection, unknown []string) error {
	fields := make([]string, 0, len(sections))
	for _, section := range sections {
		fields = append(fields, section.Key)
	}
	return cloudAgentFieldError("document", "unknown_fields", fmt.Sprintf("document 含 %d 个未声明字段：%s；保留其有效正文并合并到以下已有字段后移除额外键，不能添加备注或占位字段：%s。key、name、factIds、expectedHash 只能放在工具参数根层级。", len(unknown), productionDocumentDiagnosticKeys(unknown), strings.Join(fields, ", ")))
}
