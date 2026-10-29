package app

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// Parts are private checkpoints, never incomplete canvas artifacts. A capped
// response is discarded; only complete, validated tool arguments enter Fields.
type productionDocumentParts struct {
	SchemaVersion int                     `json:"schemaVersion"`
	ExpectedHash  string                  `json:"expectedHash,omitempty"`
	Fields        map[string]string       `json:"fields"`
	Pending       [][]string              `json:"pending"`
	RepairFields  map[string]string       `json:"repairFields,omitempty"`
	RepairDesign  *productionDesignFields `json:"repairDesign,omitempty"`
}

func productionDocumentTargetHash(artifacts []model.ProductionAgentArtifact, key string) string {
	for _, artifact := range artifacts {
		if artifact.Key == key {
			return artifact.ContentHash
		}
	}
	return ""
}

func productionSplitDocumentParts(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, work *productionParallelWork) error {
	if work.DocumentParts == nil {
		schema := productionPlanDocumentSchemaVersion(m.Plan.Version)
		sections := productionPlanDocumentSectionsForSchema(work.Key, productionPlanKind(m, work.Key), schema)
		if len(sections) == 0 || work.Key == "inventory" {
			return BadAuthRequest("当前操作没有可分批的文稿模板")
		}
		fields := make([]string, 0, len(sections))
		for _, section := range sections {
			fields = append(fields, section.Key)
		}
		work.DocumentParts = &productionDocumentParts{SchemaVersion: schema, ExpectedHash: productionDocumentTargetHash(artifacts, work.Key), Fields: map[string]string{}, Pending: [][]string{fields}}
	}
	if err := productionDocumentPartsVersion(m, doc, artifacts, *work); err != nil {
		return err
	}
	parts := work.DocumentParts
	if len(parts.Pending) == 0 {
		return BadAuthRequest("文稿章节检查点缺少待生成字段")
	}
	fields := parts.Pending[0]
	if len(fields) < 2 {
		return BadAuthRequest(fmt.Sprintf("%s 的章节 %s 单独生成仍达到输出上限，已停止自动重试；已完成章节保留，请调整本章制作要求或系统输出策略后继续", work.Name, strings.Join(fields, ", ")))
	}
	mid := len(fields) / 2
	parts.Pending = append([][]string{fields[:mid:mid], fields[mid:]}, parts.Pending[1:]...)
	work.DisableThinking = true
	return nil
}

func productionDocumentPartsVersion(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, work productionParallelWork) error {
	if work.DocumentParts.SchemaVersion != productionPlanDocumentSchemaVersion(m.Plan.Version) || work.Dependencies != productionParallelDependencyHash(m, artifacts, work.Key) {
		return BadAuthRequest("文稿模板或前置版本已变化，未继续旧章节")
	}
	if work.DocumentParts.ExpectedHash != productionDocumentTargetHash(artifacts, work.Key) {
		return BadAuthRequest("目标文稿已更新，未覆盖已有章节或新版本")
	}
	for _, artifact := range artifacts {
		if artifact.Key == work.Key && !productionArtifactMatches(productionNode(doc, artifact.NodeID), artifact.ContentHash) {
			return BadAuthRequest("目标文稿已删除或人工修改，未覆盖")
		}
	}
	return nil
}

func productionDocumentPartsContext(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, work productionParallelWork, context map[string]any) error {
	if err := productionDocumentPartsVersion(m, doc, artifacts, work); err != nil {
		return err
	}
	parts := work.DocumentParts
	if len(parts.Pending) == 0 {
		return BadAuthRequest("文稿章节检查点缺少待生成字段")
	}
	next := context["nextAction"].(map[string]any)
	next["documentFields"] = parts.Pending[0]
	next["documentPartFinal"] = len(parts.Pending) == 1
	if len(parts.Pending[0]) == 0 {
		// Metadata acknowledgement needs no creative sources or asset library.
		for key := range context {
			if key != "nextAction" {
				delete(context, key)
			}
		}
		context["instruction"] = "原稿已由服务端暂存。本次只修正提交参数：key、name、expectedHash 原样沿用 nextAction.arguments，factIds=[]，document={}。新建文稿 expectedHash=\"\"，不得使用任何前置文稿版本。不重写正文，不添加 design 或其他字段；服务端将复用原稿执行完整校验。"
		return nil
	}
	context["acceptedDocumentFields"] = parts.Fields
	context["repairDocumentFields"] = parts.RepairFields
	context["documentMaxChars"] = productionArtifactContentLimit(m, doc, work.Key)
	next["documentBudget"] = productionDocumentWorkBudget(m, doc, work)
	context["instruction"] = "当前文稿按章节制作或定向修复。只生成 nextAction.documentFields 指定字段，不重复 acceptedDocumentFields；字段列表为空时提交 document={} 确认修正后的版本参数即可。key、name、expectedHash 原样沿用 nextAction.arguments；新建时 expectedHash=\"\"，不得使用前置文稿的版本号。已保存章节保持不变；repairDocumentFields 是被拒绝原稿，按 correction 修正。总文稿遵守 documentMaxChars，不省略制作要求。全部完成后统一校验保存原文稿，最后一批可提交资产 design，不创建额外节点。"
	context["instruction"] = stringValue(context["instruction"]) + "按 nextAction.documentBudget 控制本批正文合计字数，标题已预留，后续批次有独立预算；suggestedFieldChars 是可调配的章节建议，不能把整份上限当作每一批上限。压缩重复说明，保留规则、依据、变化条件和清单行；公共规范写共用标准，逐资产细节由后续独立档案承载。"
	if len(work.RepairDocument) > 0 {
		repair := map[string]string{}
		for key, value := range work.RepairDocument {
			repair[key] = value
		}
		for key, value := range parts.RepairFields {
			repair[key] = value
		}
		context["repairDocumentFields"] = repair
	}
	return nil
}

func productionDocumentPartsProgress(work productionParallelWork) string {
	remaining := 0
	for _, fields := range work.DocumentParts.Pending {
		remaining += len(fields)
	}
	done := len(work.DocumentParts.Fields)
	return fmt.Sprintf("%s：章节已暂存 %d/%d，完整校验后写入画布", work.Name, done, done+remaining)
}

// Return staged=true only when a new complete batch was accepted. The last
// batch is merged in memory and still passes the ordinary full-document tool.
func productionStageDocumentParts(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, work *productionParallelWork, call cloudAgentCall) (bool, cloudAgentCall, error) {
	if err := productionDocumentPartsVersion(m, doc, artifacts, *work); err != nil {
		return false, call, err
	}
	parts := work.DocumentParts
	if len(parts.Pending) == 0 {
		return false, call, BadAuthRequest("文稿章节检查点缺少待生成字段")
	}
	if len(call.Function.Arguments) > productionToolArgumentsMaxBytes {
		return false, call, BadAuthRequest("文稿章节工具参数超过安全大小限制")
	}
	var args map[string]json.RawMessage
	if err := decodeCloudAgentJSONObject(call.Function.Arguments, &args); err != nil {
		return false, call, cloudAgentJSONArgumentError(err)
	}
	var expectedHash string
	if raw := args["expectedHash"]; len(raw) > 0 {
		if raw[0] != '"' || json.Unmarshal(raw, &expectedHash) != nil {
			return false, call, cloudAgentFieldError("expectedHash", "field_type", "expectedHash 必须是字符串，原样沿用 nextAction.arguments.expectedHash")
		}
	}
	if expectedHash != parts.ExpectedHash {
		return false, call, productionDocumentVersionArgumentError(parts.ExpectedHash)
	}
	var rawFields map[string]json.RawMessage
	if err := decodeCloudAgentJSONObject(string(args["document"]), &rawFields); err != nil {
		if argumentErr := productionDocumentArgumentsError(call.Function.Arguments); argumentErr != nil {
			return false, call, argumentErr
		}
		return false, call, cloudAgentFieldError("document", "field_type", "本批必须提交 document JSON 对象，每个正文章节的值必须是字符串")
	}
	fields := map[string]string{}
	for field, value := range rawFields {
		var text string
		if len(value) > 0 && value[0] == '"' && json.Unmarshal(value, &text) == nil {
			fields[field] = text
		}
	}
	expected := parts.Pending[0]
	failures := []error{productionDocumentRawValidationError(call.Function.Arguments, work.Key, productionPlanKind(m, work.Key), parts.SchemaVersion, expected)}
	sections := productionPlanDocumentSectionsForSchema(work.Key, productionPlanKind(m, work.Key), parts.SchemaVersion)
	// Check the envelope now, rather than silently dropping unsupported fields
	// while persisting a successful partial response.
	argumentKeys := make([]string, 0, len(args))
	for key := range args {
		argumentKeys = append(argumentKeys, key)
	}
	sort.Strings(argumentKeys)
	for _, key := range argumentKeys {
		if !cloudAgentContainsString([]string{"key", "name", "document", "factIds", "expectedHash", "design"}, key) {
			failures = append(failures, cloudAgentFieldError(key, "unexpected_field", "本批工具参数包含未声明字段："+productionDocumentDiagnosticKeys([]string{key})))
		}
	}
	var factIDs []string
	if err := json.Unmarshal(args["factIds"], &factIDs); err != nil || len(factIDs) != 0 {
		failures = append(failures, cloudAgentFieldError("factIds", "part_facts", "制作方案 factIds 必须为 []"))
	}
	if raw := args["design"]; len(raw) > 0 && string(raw) != "null" {
		_, shared := planSection(work.Key)
		if shared || len(parts.Pending) > 1 || len(expected) == 0 {
			failures = append(failures, cloudAgentFieldError("design", "part_design", "公共规范不提交 design；独立资产 design 请在最后一批提交"))
		}
	}
	if err := cloudAgentValidationErrors(failures...); err != nil {
		return false, call, err
	}
	merged := make(map[string]string, len(parts.Fields)+len(fields))
	for key, value := range parts.Fields {
		merged[key] = value
	}
	for key, value := range fields {
		if _, exists := merged[key]; exists {
			return false, call, BadAuthRequest("本批包含已经保存的章节，未覆盖")
		}
		merged[key] = value
	}
	runes := productionDocumentContentChars(merged) + productionDocumentHeadingChars(sections)
	if limit := productionArtifactContentLimit(m, doc, work.Key); runes > limit {
		return false, call, productionDocumentLengthError(runes, limit)
	}
	if len(parts.Pending) > 1 {
		parts.Fields, parts.Pending = merged, parts.Pending[1:]
		work.RepairDocumentRaw = nil
		for key := range fields {
			delete(parts.RepairFields, key)
		}
		return true, call, nil
	}
	args["document"], _ = json.Marshal(merged)
	if (len(args["design"]) == 0 || string(args["design"]) == "null") && parts.RepairDesign != nil {
		args["design"], _ = json.Marshal(parts.RepairDesign)
	}
	encoded, err := json.Marshal(args)
	if err != nil {
		return false, call, err
	}
	call.Function.Arguments = string(encoded)
	return false, call, nil
}

// A final cross-document check may identify earlier chapters. Reopen every
// affected field, retaining its original text for a directed repair. Retry counters
// remain document-wide, so successful staging cannot reset a failing loop.
func productionReopenDocumentField(work *productionParallelWork, failure error) {
	if work.DocumentParts == nil {
		return
	}
	parts := work.DocumentParts
	fields := []string{}
	for _, issue := range cloudAgentValidationIssues(failure) {
		if !strings.HasPrefix(issue.Field, "document.") {
			continue
		}
		field := strings.TrimPrefix(issue.Field, "document.")
		if _, exists := parts.Fields[field]; !exists {
			field, _, _ = strings.Cut(field, ".")
		}
		value, exists := parts.Fields[field]
		if !exists {
			continue
		}
		if parts.RepairFields == nil {
			parts.RepairFields = map[string]string{}
		}
		parts.RepairFields[field] = value
		delete(parts.Fields, field)
		fields = append(fields, field)
	}
	if len(fields) == 0 {
		return
	}
	if len(work.DocumentParts.Pending) > 0 && len(work.DocumentParts.Pending[0]) == 0 {
		work.DocumentParts.Pending = work.DocumentParts.Pending[1:]
	}
	work.DocumentParts.Pending = append([][]string{fields}, work.DocumentParts.Pending...)
}
