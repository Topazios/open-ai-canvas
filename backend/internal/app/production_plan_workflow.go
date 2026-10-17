package app

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type productionPlanPhase string

const (
	planPhaseInput      productionPlanPhase = "input"
	planPhaseStory      productionPlanPhase = "story"
	planPhaseInventory  productionPlanPhase = "inventory"
	planPhaseStandards  productionPlanPhase = "standards"
	planPhaseAssets     productionPlanPhase = "assets"
	planPhaseGeneration productionPlanPhase = "generation"
	planPhaseValidation productionPlanPhase = "validation"
)

var productionPlanPhaseLabels = map[productionPlanPhase]string{
	planPhaseInput: "读取选题与全局设定", planPhaseStory: "故事总纲与世界规则",
	planPhaseInventory: "资产清单与编码", planPhaseStandards: "统一美术与视听规范",
	planPhaseAssets: "逐资产设计档案", planPhaseGeneration: "生成与连续性规范", planPhaseValidation: "完成检查",
}

var productionPlanReferencePattern = regexp.MustCompile(`@(?:CHR|SCN|PRP|SPC|AUD)-[0-9]{4,}(?:-V[0-9]{4,})?`)

func productionValidatePlanReferences(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, content string) error {
	known := map[string]bool{}
	for _, item := range m.Plan.Assets {
		if item.Identity != nil {
			known["@"+item.Identity.Code] = true
		}
	}
	for _, a := range artifacts {
		node := productionNode(doc, a.NodeID)
		profile, _ := productionWorkflow(node)["assetProfile"].(map[string]any)
		if variants, ok := profile["variants"].([]productionDesignVariant); ok {
			for _, variant := range variants {
				if variant.Code != "" {
					known["@"+variant.Code] = true
				}
			}
			continue
		}
		for _, variant := range creationMaps(profile["variants"]) {
			if code := stringValue(variant["code"]); code != "" {
				known["@"+code] = true
			}
		}
	}
	for _, reference := range productionPlanReferencePattern.FindAllString(content, -1) {
		if !known[reference] {
			return cloudAgentFieldError("document", "unknown_asset_reference", "引用的资产或变体编码尚未在本版登记："+reference+"；请沿用 registeredAssets 返回的编码，不自行编造")
		}
	}
	return nil
}

func productionPlanInventoryHash(plan productionPlan) string {
	assets := append([]productionPlanAsset{}, plan.Assets...)
	sort.Slice(assets, func(i, j int) bool { return assets[i].Key < assets[j].Key })
	return productionStoredValueHash([]any{plan.StoryHash, assets, plan.Absent})
}

func productionValidatePlanInventory(plan productionPlan) error {
	items := map[string]productionPlanAsset{}
	kinds := map[string]bool{}
	validKinds := planKinds(productionManifest{Plan: &plan})
	// Version zero is the pre-v2 in-memory contract. Preserve its historical
	// requirement for an explicit independent sound declaration while new v3
	// plans use the integrated four-category contract.
	if plan.Version == 0 {
		validKinds = append(validKinds, "sound")
	}
	for _, item := range plan.Assets {
		if !cloudAgentContainsString(validKinds, item.Kind) {
			return BadAuthRequest("资产类别不属于本版清单：" + item.Kind)
		}
		if strings.TrimSpace(item.Purpose) == "" || strings.TrimSpace(item.PlannedRange) == "" {
			return BadAuthRequest("清单尚有资产缺少剧情功能或计划出场范围：" + item.Key)
		}
		items[item.Key], kinds[item.Kind] = item, true
	}
	for _, kind := range validKinds {
		if !kinds[kind] && strings.TrimSpace(plan.Absent[kind]) == "" {
			return BadAuthRequest("清单完成前需要登记或说明不存在的类别：" + kind)
		}
	}
	visiting, visited := map[string]bool{}, map[string]bool{}
	var visit func(string) error
	visit = func(key string) error {
		if visiting[key] {
			return BadAuthRequest("资产设计依赖形成循环：" + key)
		}
		if visited[key] {
			return nil
		}
		item, ok := items[key]
		if !ok {
			return BadAuthRequest("资产设计依赖未登记：" + key)
		}
		visiting[key] = true
		for _, dependency := range item.DependsOn {
			if err := visit(dependency); err != nil {
				return err
			}
		}
		delete(visiting, key)
		visited[key] = true
		return nil
	}
	for _, item := range plan.Assets {
		if err := visit(item.Key); err != nil {
			return err
		}
	}
	return nil
}

func productionPlanKind(m productionManifest, key string) string {
	if item := productionPlanItem(m, key); item != nil {
		return item.Kind
	}
	return ""
}

// Dependencies reference durable receipts, not conversational memory. Changing an
// upstream document invalidates only documents whose recorded inputs differ.
func productionPlanDependencies(m productionManifest, artifacts []model.ProductionAgentArtifact, key string) map[string]string {
	deps := map[string]string{"$input": productionHash([]any{m.TargetHash, m.Sources})}
	keys := []string{}
	switch key {
	case "story":
	case "inventory":
		keys = []string{"story"}
		deps["$inventory"] = productionPlanInventoryHash(*m.Plan)
	case "visual", "direction":
		keys = []string{"story", "inventory"}
	default:
		keys = []string{"story", "inventory", "visual", "direction"}
		if key == "generation" {
			for _, item := range m.Plan.Assets {
				keys = append(keys, item.Key)
			}
		} else if item := productionPlanItem(m, key); item != nil {
			keys = append(keys, item.DependsOn...)
		}
	}
	for _, dependency := range keys {
		deps[dependency] = ""
		for _, artifact := range artifacts {
			if artifact.Key == dependency {
				deps[dependency] = artifact.ContentHash
				break
			}
		}
	}
	return deps
}

func productionPlanArtifactValid(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, key string) bool {
	return productionPlanArtifactValidPath(m, doc, artifacts, key, map[string]bool{}, map[string]bool{})
}

func productionPlanArtifactValidPath(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, key string, path, memo map[string]bool) (valid bool) {
	if value, exists := memo[key]; exists {
		return value
	}
	defer func() { memo[key] = valid }()
	if path[key] {
		return false
	}
	path[key] = true
	defer delete(path, key)
	for _, source := range m.Sources {
		for _, id := range source.Pages {
			if !m.Read[id] {
				return false
			}
		}
	}
	if key == "inventory" && (!m.Plan.Complete || productionValidatePlanInventory(*m.Plan) != nil) {
		return false
	}
	for _, a := range artifacts {
		if a.Key != key {
			continue
		}
		node := productionNode(doc, a.NodeID)
		meta, _ := node["metadata"].(map[string]any)
		if node == nil || node["parentId"] != productionPlanParent(m, key) || !productionArtifactMatches(node, a.ContentHash) || len(productionPlanDocumentMissing(key, productionPlanKind(m, key), stringValue(meta["content"]))) > 0 {
			return false
		}
		if productionValidatePlanReferences(m, doc, artifacts, stringValue(meta["content"])) != nil {
			return false
		}
		deps := productionPlanDependencies(m, artifacts, key)
		if productionStoredValueHash(productionWorkflow(node)["planDependencies"]) != productionStoredValueHash(deps) {
			return false
		}
		for dependency, hash := range deps {
			if strings.HasPrefix(dependency, "$") {
				continue
			}
			if hash == "" || !productionPlanArtifactValidPath(m, doc, artifacts, dependency, path, memo) {
				return false
			}
			if key == "inventory" && dependency == "story" && hash != m.Plan.StoryHash {
				return false
			}
		}
		return true
	}
	return false
}

func productionPlanPrerequisites(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, key string) error {
	for _, source := range m.Sources {
		for _, page := range source.Pages {
			if !m.Read[page] {
				return BadAuthRequest("请先读取选题与项目约束，再保存制作方案")
			}
		}
	}
	if key == "inventory" && !m.Plan.Complete {
		return BadAuthRequest("请先完成资产清单登记")
	}
	for dependency := range productionPlanDependencies(m, artifacts, key) {
		if strings.HasPrefix(dependency, "$") {
			continue
		}
		if !productionPlanArtifactValid(m, doc, artifacts, dependency) {
			return cloudAgentFieldError("key", "plan_prerequisite", "前置文稿尚未完成或版本已变化，请先处理："+dependency)
		}
	}
	return nil
}

func productionPlanNextAction(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) map[string]any {
	action := func(phase productionPlanPhase, tool string, args map[string]any) map[string]any {
		return map[string]any{"phase": string(phase), "phaseLabel": productionPlanPhaseLabels[phase], "tool": tool, "arguments": args}
	}
	for _, source := range m.Sources {
		for _, page := range source.Pages {
			if !m.Read[page] {
				return action(planPhaseInput, "production_read", map[string]any{"pageId": page})
			}
		}
	}
	// Manual edits/deletions cannot be repaired by overwriting or recreating nodes.
	for _, a := range artifacts {
		node := productionNode(doc, a.NodeID)
		if node == nil || node["parentId"] != productionPlanParent(m, a.Key) || !productionArtifactMatches(node, a.ContentHash) {
			blocked := action(planPhaseValidation, "production_check", map[string]any{})
			blocked["blockedReason"] = "已有文稿被删除、移动或人工修改，已保留现场；请创建新的方案版本：" + a.Key
			return blocked
		}
	}
	submit := func(phase productionPlanPhase, key, name string) map[string]any {
		args := map[string]any{"key": key, "name": name, "factIds": []string{}}
		for _, a := range artifacts {
			if a.Key == key {
				args["expectedHash"] = a.ContentHash
			}
		}
		next := action(phase, "production_submit", args)
		next["key"], next["name"], next["kind"] = key, name, productionPlanKind(m, key)
		next["documentSchema"] = productionPlanDocumentSections(key, productionPlanKind(m, key))
		next["instruction"] = "按 documentSchema 的 Key 逐字段填写并保存此文稿。已有文稿须保留内容增补，使用 arguments.expectedHash；不要只检查或重述计划。"
		return next
	}
	if !productionPlanArtifactValid(m, doc, artifacts, "story") {
		return submit(planPhaseStory, "story", "故事总纲与世界规则")
	}
	if !productionPlanArtifactValid(m, doc, artifacts, "inventory") {
		args := map[string]any{"assets": []any{}, "absent": m.Plan.Absent, "complete": true}
		for _, a := range artifacts {
			if a.Key == "story" {
				args["storyHash"] = a.ContentHash
			}
		}
		next := action(planPhaseInventory, "production_plan_inventory", args)
		next["instruction"] = "依据总纲逐篇章登记计划资产；只追加未登记项，补齐 purpose/plannedRange。分批时 complete=false，五类核对完成后 complete=true。已登记的稳定身份必须复用。"
		return next
	}
	for _, key := range []string{"visual", "direction"} {
		if !productionPlanArtifactValid(m, doc, artifacts, key) {
			section, _ := planSection(key)
			return submit(planPhaseStandards, key, section.Title)
		}
	}
	for _, item := range m.Plan.Assets {
		if !productionPlanArtifactValid(m, doc, artifacts, item.Key) && productionPlanPrerequisites(m, doc, artifacts, item.Key) == nil {
			return submit(planPhaseAssets, item.Key, item.Name)
		}
	}
	for _, item := range m.Plan.Assets {
		if !productionPlanArtifactValid(m, doc, artifacts, item.Key) {
			next := action(planPhaseAssets, "production_check", map[string]any{})
			next["blockedReason"] = "资产设计依赖无法推进，请检查清单依赖：" + item.Key
			return next
		}
	}
	if !productionPlanArtifactValid(m, doc, artifacts, "generation") {
		return submit(planPhaseGeneration, "generation", "生成与一致性规范")
	}
	return action(planPhaseValidation, "production_check", map[string]any{})
}

func productionOrderedPlanCoverage(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) map[string]any {
	issues, missing := []string{}, []productionPlanAsset{}
	count := 0
	for _, key := range []string{"story", "inventory", "visual", "direction", "generation"} {
		if productionPlanArtifactValid(m, doc, artifacts, key) {
			count++
		} else {
			section, _ := planSection(key)
			issues = append(issues, "缺少或需更新前置制作规范："+section.Title)
		}
	}
	for _, item := range m.Plan.Assets {
		if productionPlanArtifactValid(m, doc, artifacts, item.Key) {
			count++
		} else {
			missing = append(missing, item)
		}
	}
	if len(missing) > 0 {
		issues = append(issues, fmt.Sprintf("还有%d项资产设定需要完成或更新", len(missing)))
	}
	return map[string]any{"valid": len(issues) == 0, "issues": issues, "missingAssets": missing[:min(12, len(missing))], "missingCount": len(missing), "artifactCount": len(artifacts), "validArtifactCount": count, "plannedAssets": len(m.Plan.Assets), "absent": m.Plan.Absent, "inventoryComplete": m.Plan.Complete, "semanticReview": "模板、依赖版本和登记清单覆盖检查；剧情合理性及资产语义质量待人工验收"}
}

func productionPlanRequiredContext(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, key string) []map[string]any {
	keys := map[string]bool{"story": true}
	if key != "" {
		keys[key] = true
		for dependency := range productionPlanDependencies(m, artifacts, key) {
			keys[dependency] = true
		}
	}
	result := []map[string]any{}
	for _, a := range artifacts {
		if !keys[a.Key] {
			continue
		}
		node := productionNode(doc, a.NodeID)
		meta, _ := node["metadata"].(map[string]any)
		entry := map[string]any{"key": a.Key, "name": node["title"], "expectedHash": a.ContentHash}
		// Final generation rules use an asset index, fetching particular dossiers
		// on demand rather than resending every full asset description.
		if key == "generation" && productionPlanItem(m, a.Key) != nil {
			entry["asset"] = productionPlanItem(m, a.Key)
		} else if a.Key != "inventory" {
			entry["content"] = meta["content"]
		}
		result = append(result, entry)
	}
	return result
}

func productionPlanScopedTools(tools []map[string]any, work map[string]any) []map[string]any {
	next, _ := work["nextAction"].(map[string]any)
	key := stringValue(next["key"])
	for _, tool := range tools {
		fn, _ := tool["function"].(map[string]any)
		parameters, _ := fn["parameters"].(map[string]any)
		properties, _ := parameters["properties"].(map[string]any)
		if fn["name"] == "production_plan_inventory" {
			parameters["required"] = []string{"storyHash", "assets", "absent", "complete"}
			items := properties["assets"].(map[string]any)["items"].(map[string]any)
			items["required"] = []string{"key", "kind", "name", "episodes", "purpose", "plannedRange", "dependsOn"}
		}
		if fn["name"] != "production_submit" {
			continue
		}
		fields, required := map[string]any{}, []string{}
		sections := productionPlanDocumentSections(key, stringValue(next["kind"]))
		for _, section := range sections {
			fields[section.Key] = map[string]any{"type": "string", "description": productionPlanFieldDescription(key, stringValue(next["kind"]), section)}
			required = append(required, section.Key)
		}
		properties["document"] = map[string]any{"type": "object", "properties": fields, "required": required, "additionalProperties": false}
		if key != "" {
			properties["key"] = map[string]any{"type": "string", "enum": []string{key}}
		}
		fn["description"] = "保存当前 nextAction 文稿；document 按本次类型模板逐字段填写。修订沿用 expectedHash，factIds=[]。"
	}
	return tools
}

func productionSavePlanInventory(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, policy RuntimePolicySetting) error {
	lines := []string{"| 编码 | 名称 | 类别 | 剧情功能 | 计划出场 | 设计前置 |", "|---|---|---|---|---|---|"}
	cell := func(value string) string { return strings.NewReplacer("|", "\\|", "\n", " ", "\r", " ").Replace(value) }
	for _, item := range m.Plan.Assets {
		code := item.Key
		if item.Identity != nil {
			code = item.Identity.Code
		}
		lines = append(lines, fmt.Sprintf("| %s | %s | %s | %s | %s | %s |", cell(code), cell(item.Name), cell(item.Kind), cell(item.Purpose), cell(item.PlannedRange), cell(strings.Join(item.DependsOn, ", "))))
	}
	absent := []string{}
	for _, kind := range planKinds(m) {
		if reason := m.Plan.Absent[kind]; reason != "" {
			absent = append(absent, kind+"："+reason)
		}
	}
	if len(absent) == 0 {
		absent = append(absent, "本版所需资产类别均已登记；此表为创作计划，实际出场由正文校核。")
	}
	content, err := productionRenderPlanDocument("inventory", "", map[string]string{"facts": "当前总纲版本：" + m.Plan.StoryHash, "design": strings.Join(lines, "\n"), "continuity": "系统登记编码，状态变化复用原资产身份。计划出场不等同正文证据；后续新增资产须明确补录。", "uncertainties": strings.Join(absent, "\n")})
	if err != nil {
		return err
	}
	expected := ""
	for _, a := range artifacts {
		if a.Key == "inventory" {
			expected = a.ContentHash
		}
	}
	_, err = productionSubmit(repo, run, state, m, doc, "inventory", "资产总表与编码", content, nil, expected, nil, policy)
	return err
}

func productionPlanRunNextAction(repo *repository.Repository, userID, runID string, m productionManifest) (map[string]any, error) {
	job, err := repo.ProductionAgentJob(userID, runID)
	if err != nil {
		return nil, err
	}
	canvas, err := repo.CanvasProjectForUser(userID, job.CanvasID)
	if err != nil {
		return nil, err
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		return nil, err
	}
	artifacts, err := repo.ProductionAgentArtifacts(userID, runID)
	if err != nil {
		return nil, err
	}
	return productionPlanNextAction(m, doc, artifacts), nil
}

func productionPlanSound(document map[string]string) string {
	parts := []string{}
	for _, key := range []string{"sound", "voiceTimbre", "voiceRange", "voicePace", "voiceAccent", "voicePerformance", "voicePrompt"} {
		if value := strings.TrimSpace(document[key]); value != "" {
			parts = append(parts, value)
		}
	}
	return strings.Join(parts, "\n")
}
