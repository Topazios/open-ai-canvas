package app

import (
	"fmt"
	"regexp"
	"slices"
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
	planPhaseGeneration productionPlanPhase = "generation"
	planPhaseAssets     productionPlanPhase = "assets"
	planPhaseValidation productionPlanPhase = "validation"
)

// Shared plan documents contain more required sections than an individual
// asset dossier. Keep their budget aligned with the schema instead of making
// valid multi-section standards fail at the legacy asset limit.
const productionPlanDocumentMaxRunes = 24000

var productionPlanPhaseLabels = map[productionPlanPhase]string{
	planPhaseInput: "读取选题与全局设定", planPhaseStory: "故事总纲与世界规则",
	planPhaseInventory: "资产清单与编码", planPhaseStandards: "统一美术与视听规范",
	planPhaseAssets: "逐资产设计档案", planPhaseGeneration: "生成与连续性规范", planPhaseValidation: "完成检查",
}

var productionPlanReferencePattern = regexp.MustCompile(`@` + model.ProductionAssetReferencePattern)

func productionPlanDocumentSchemaVersion(planVersion int) int {
	if planVersion >= 4 {
		return 2
	}
	return 1
}

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
	var failures []error
	for index, reference := range productionPlanReferencePattern.FindAllString(content, -1) {
		if !known[reference] {
			failures = append(failures, cloudAgentFieldError("document.reference["+reference+"]", "unknown_asset_reference", fmt.Sprintf("第 %d 个引用 %s 尚未在本版登记；请沿用 registeredAssets 返回的编码，不自行编造。公共规范尚未分配变体时，用已登记基础编码加状态名称描述，不添加 -V01 等后缀；不能通过去掉 @ 绕过身份核对", index+1, truncateRunes(reference, 80))))
		}
	}
	return cloudAgentValidationErrors(failures...)
}

func productionPlanInventoryHash(plan productionPlan) string {
	assets := append([]productionPlanAsset{}, plan.Assets...)
	sort.Slice(assets, func(i, j int) bool { return assets[i].Key < assets[j].Key })
	if plan.InventoryReviewVersion > 0 {
		return productionStoredValueHash([]any{plan.StoryHash, assets, plan.Absent, plan.InventoryReviewVersion, plan.InventoryReview})
	}
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
	var failures []error
	if len(plan.Assets) == 0 {
		failures = append(failures, cloudAgentFieldError("assets", "empty_inventory", "完整资产总表至少需要登记一项实际制作资产；不能将所有类别标为不存在后结束方案"))
	}
	for i, item := range plan.Assets {
		if !cloudAgentContainsString(validKinds, item.Kind) {
			failures = append(failures, cloudAgentFieldError(fmt.Sprintf("assets[%d].kind", i), "invalid_kind", "资产类别不属于本版清单："+truncateRunes(item.Kind, 80)))
		}
		if strings.TrimSpace(item.Purpose) == "" || strings.TrimSpace(item.PlannedRange) == "" {
			failures = append(failures, cloudAgentFieldError(fmt.Sprintf("assets[%d]", i), "missing_asset_plan", "清单尚有资产缺少剧情功能或计划出场范围："+truncateRunes(item.Key, 80)))
		}
		items[item.Key], kinds[item.Kind] = item, true
	}
	planManifest := productionManifest{Plan: &plan}
	for _, kind := range validKinds {
		if !kinds[kind] && strings.TrimSpace(plan.Absent[kind]) == "" {
			failures = append(failures, cloudAgentFieldError("absent."+kind, "missing_kind", "清单完成前需要登记或说明不存在的类别："+kind))
		}
	}
	// Strongly connected components identify every cyclic dependency edge in
	// one pass, rather than exposing a different first cycle after each repair.
	sequence := 0
	index, low, component, sizes := map[string]int{}, map[string]int{}, map[string]int{}, map[int]int{}
	stack := []string{}
	onStack := map[string]bool{}
	var visit func(string)
	visit = func(key string) {
		sequence++
		index[key], low[key] = sequence, sequence
		stack, onStack[key] = append(stack, key), true
		for _, dependency := range productionPlanAssetDependencies(planManifest, items[key]) {
			if _, exists := items[dependency]; !exists {
				continue
			}
			if index[dependency] == 0 {
				visit(dependency)
				low[key] = min(low[key], low[dependency])
			} else if onStack[dependency] {
				low[key] = min(low[key], index[dependency])
			}
		}
		if low[key] == index[key] {
			for {
				last := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				onStack[last], component[last] = false, index[key]
				sizes[index[key]]++
				if last == key {
					break
				}
			}
		}
	}
	for _, item := range plan.Assets {
		if index[item.Key] == 0 {
			visit(item.Key)
		}
	}
	for assetIndex, item := range plan.Assets {
		for dependencyIndex, dependency := range item.DependsOn {
			field := fmt.Sprintf("assets[%d].dependsOn[%d]", assetIndex, dependencyIndex)
			if _, exists := items[dependency]; !exists {
				failures = append(failures, cloudAgentFieldError(field, "unknown_dependency", "资产设计依赖未登记："+truncateRunes(item.Key, 60)+" → "+truncateRunes(dependency, 60)))
			} else if item.Kind == "prop" && items[dependency].Kind == "environment" {
				continue
			} else if component[item.Key] == component[dependency] && (sizes[component[item.Key]] > 1 || item.Key == dependency) {
				failures = append(failures, cloudAgentFieldError(field, "dependency_cycle", "资产设计依赖形成循环："+truncateRunes(item.Key, 60)+" → "+truncateRunes(dependency, 60)))
			}
		}
	}
	return cloudAgentValidationErrors(failures...)
}

func productionPlanKind(m productionManifest, key string) string {
	if item := productionPlanItem(m, key); item != nil {
		return item.Kind
	}
	return ""
}

// A prop may be associated with a location, but its design is independently
// generatable. Older inventories sometimes stored that association as a hard
// dependency, which could block props forever behind a scene dossier.
func productionPlanAssetDependencies(m productionManifest, item productionPlanAsset) []string {
	dependencies := make([]string, 0, len(item.DependsOn))
	for _, key := range item.DependsOn {
		dependency := productionPlanItem(m, key)
		if dependency == nil {
			continue
		}
		if (item.Kind == "prop" && dependency.Kind == "environment") || (item.Kind == "environment" && dependency.Kind == "prop") {
			continue
		}
		dependencies = append(dependencies, key)
	}
	return dependencies
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
		if m.Plan.Version >= 5 {
			keys = []string{"story"}
		}
	case "generation":
		keys = []string{"story", "inventory", "visual", "direction"}
		if m.Plan.Version >= 5 {
			keys = []string{"story"}
		}
	default:
		if m.Plan.AssetsStarted && productionPlanItem(m, key) != nil {
			keys = []string{"story"}
			deps = map[string]string{}
		} else {
			keys = []string{"story", "inventory", "visual", "direction", "generation"}
		}
		if item := productionPlanItem(m, key); item != nil && !m.Plan.AssetsStarted {
			keys = append(keys, productionPlanAssetDependencies(m, *item)...)
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
	if m.Plan != nil && slices.Contains(m.Plan.NewVersionAssetKeys, key) {
		return false
	}
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
			if !m.Read[id] && m.Plan.Version < 5 {
				return false
			}
		}
	}
	if key == "inventory" && !m.Plan.Complete {
		return false
	}
	if key == "inventory" && productionValidatePlanInventory(*m.Plan) != nil {
		return false
	}
	if key == "inventory" && m.Plan.InventoryReviewVersion > 0 && productionValidateInventoryReview(*m.Plan, doc, m.FrameID, artifacts, true) != nil {
		return false
	}
	for _, a := range artifacts {
		if a.Key != key {
			continue
		}
		node := productionNode(doc, a.NodeID)
		if node == nil {
			return false
		}
		meta, _ := node["metadata"].(map[string]any)
		schemaVersion := int(numberValue(productionWorkflow(node)["planDocumentSchema"], 1))
		if node["parentId"] != productionPlanParent(m, key) || !productionArtifactMatches(node, a.ContentHash) || len(productionPlanDocumentMissingForSchema(key, productionPlanKind(m, key), stringValue(meta["content"]), schemaVersion)) > 0 {
			return false
		}
		if key == "story" && m.Plan.StoryStructureVersion > 0 && len(productionPlanEpisodeArchitectureIssues(m, doc, stringValue(meta["content"]), schemaVersion)) > 0 {
			return false
		}
		assetGeneration := m.Plan.AssetsStarted && productionPlanItem(m, key) != nil
		if !assetGeneration && productionValidatePlanReferences(m, doc, artifacts, stringValue(meta["content"])) != nil {
			return false
		}
		if !assetGeneration && m.Plan.Version < 5 && len(productionPlanContinuityIssues(m, doc, artifacts, key, stringValue(meta["content"]), nil)) > 0 {
			return false
		}
		if assetGeneration {
			return true
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
	if item := productionPlanItem(m, key); item != nil && m.Plan.AssetsStarted {
		if !productionPlanStoryPresent(m, doc, artifacts) {
			return cloudAgentFieldError("key", "plan_prerequisite", "请先保存制作方案的故事总纲")
		}
		if !productionPlanAssetSelected(m, key) {
			return cloudAgentFieldError("key", "plan_asset_not_selected", "此方案项未在本次启动范围内")
		}
		return nil
	}
	if m.Plan.Version >= 5 {
		if key == "story" {
			return nil
		}
		if key != "inventory" && key != "visual" && key != "direction" && key != "generation" && !productionPlanAssetSelected(m, key) {
			return cloudAgentFieldError("key", "plan_asset_not_selected", "此方案项未在本次启动范围内")
		}
		if key != "story" && !productionPlanArtifactValid(m, doc, artifacts, "story") {
			return cloudAgentFieldError("key", "plan_prerequisite", "请先完成故事总纲与世界规则")
		}
		if key == "visual" || key == "direction" || key == "generation" {
			if !productionPlanArtifactValid(m, doc, artifacts, "inventory") {
				return cloudAgentFieldError("key", "plan_prerequisite", "请先完成资产总表与编码")
			}
		}
		if key == "generation" && (!productionPlanArtifactValid(m, doc, artifacts, "visual") || !productionPlanArtifactValid(m, doc, artifacts, "direction")) {
			return cloudAgentFieldError("key", "plan_prerequisite", "请先完成视觉与美术规范、导演与视听规范")
		}
		return nil
	}
	if _, section := planSection(key); !section && !m.Plan.AssetsStarted {
		return cloudAgentFieldError("key", "plan_assets_not_started", "资产生成尚未手动启动；请先完成制作方案，再点击生成资产")
	}
	if _, section := planSection(key); !section && !productionPlanAssetSelected(m, key) {
		return cloudAgentFieldError("key", "plan_asset_not_selected", "此资产未在本次生成范围内，请先手动选择："+key)
	}
	for _, source := range m.Sources {
		for _, page := range source.Pages {
			if !m.Read[page] && m.Plan.Version < 5 {
				return BadAuthRequest("请先读取选题与项目约束，再保存制作方案")
			}
		}
	}
	if key == "inventory" && !m.Plan.Complete && m.Plan.Version < 5 {
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

func productionPlanStandardsReady(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) bool {
	keys := []string{"story", "inventory", "visual", "direction", "generation"}
	if m.Plan.Version >= 5 && !m.Plan.PlansStarted {
		keys = []string{"story"}
	}
	for _, key := range keys {
		if !productionPlanArtifactValid(m, doc, artifacts, key) {
			return false
		}
	}
	return true
}

func productionPlanStoryPresent(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) bool {
	if m.Plan == nil {
		return false
	}
	for _, artifact := range artifacts {
		if artifact.Key != "story" {
			continue
		}
		node := productionNode(doc, artifact.NodeID)
		if node == nil || node["parentId"] != productionPlanParent(m, "story") {
			return false
		}
		meta, _ := node["metadata"].(map[string]any)
		return strings.TrimSpace(stringValue(meta["content"])) != ""
	}
	return false
}

func productionPlanAssetGenerationReady(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) bool {
	return m.Plan != nil && m.Plan.Version >= 2 && productionPlanStoryPresent(m, doc, artifacts)
}

func productionPlanGroupProgress(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, state *cloudAgentRuntime) []ProductionPlanGroupProgress {
	standardsReady := productionPlanAssetGenerationReady(m, doc, artifacts)
	groups := []ProductionPlanGroupProgress{}
	for _, kind := range productionPlanGroupKinds {
		group := ProductionPlanGroupProgress{Kind: kind, Status: "waiting"}
		pendingSelected := false
		for _, item := range m.Plan.Assets {
			if productionPlanGroupKind(item) != kind {
				continue
			}
			group.Total++
			if productionPlanArtifactValid(m, doc, artifacts, item.Key) {
				group.Completed++
			} else if productionPlanAssetSelected(m, item.Key) {
				pendingSelected = true
			}
			if work, ok := state.ProductionParallel[item.Key]; ok && standardsReady && productionPlanAssetSelected(m, item.Key) {
				if work.Error != "" {
					group.Status = "error"
				} else if group.Status != "error" && (work.TaskID != "" || work.RetryAt > 0) {
					group.Status = "running"
				}
			}
		}
		if group.Total == 0 {
			continue
		}
		if !standardsReady {
			group.Status = "waiting_standards"
		} else if !m.Plan.AssetsStarted && group.Completed < group.Total {
			group.Status = "waiting_manual"
		} else if group.Completed == group.Total {
			group.Status = "complete"
		} else if group.Status == "waiting" && !pendingSelected {
			group.Status = "waiting_manual"
		}
		groups = append(groups, group)
	}
	return groups
}

func productionPlanNextAction(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) map[string]any {
	action := func(phase productionPlanPhase, tool string, args map[string]any) map[string]any {
		return map[string]any{"phase": string(phase), "phaseLabel": productionPlanPhaseLabels[phase], "tool": tool, "arguments": args}
	}
	for _, source := range m.Sources {
		for _, page := range source.Pages {
			if !m.Read[page] && m.Plan.Version < 5 {
				return action(planPhaseInput, "production_read", map[string]any{"pageId": page})
			}
		}
	}
	if m.Plan.Version >= 5 && !productionPlanStoryPresent(m, doc, artifacts) {
		return action(planPhaseStory, "production_submit", map[string]any{"key": "story", "name": "故事总纲与世界规则", "expectedHash": productionDocumentTargetHash(artifacts, "story"), "factIds": []string{}})
	}
	// Manual edits/deletions cannot be repaired by overwriting or recreating nodes.
	for _, a := range artifacts {
		if m.Plan.Version >= 5 && m.Plan.AssetsStarted {
			continue
		}
		node := productionNode(doc, a.NodeID)
		if node == nil || node["parentId"] != productionPlanParent(m, a.Key) || !productionArtifactMatches(node, a.ContentHash) {
			blocked := action(planPhaseValidation, "production_check", map[string]any{})
			blocked["blockedReason"] = "已有文稿被删除、移动或人工修改，已保留现场；请创建新的方案版本：" + a.Key
			return blocked
		}
	}
	submit := func(phase productionPlanPhase, key, name string) map[string]any {
		args := map[string]any{"key": key, "name": name, "factIds": []string{}, "expectedHash": productionDocumentTargetHash(artifacts, key)}
		next := action(phase, "production_submit", args)
		next["key"], next["name"], next["kind"] = key, name, productionPlanKind(m, key)
		schemaVersion := productionPlanDocumentSchemaVersion(m.Plan.Version)
		next["documentSchemaVersion"] = schemaVersion
		next["documentSchema"] = productionPlanDocumentSectionsForSchema(key, productionPlanKind(m, key), schemaVersion)
		next["documentBudget"] = productionDocumentWorkBudget(m, doc, productionParallelWork{Key: key})
		next["instruction"] = "在 arguments 中添加 document 对象，将 documentSchema 的每个 Key 作为 document 内的字段逐项填写，不能放到工具参数顶层。key、name、expectedHash 原样沿用 arguments，factIds=[]。新建文稿 expectedHash 为空字符串，不能使用前置文稿的版本号；已有文稿须保留内容增补。不要只检查或重述计划。"
		return next
	}
	if m.Plan.Version >= 5 && m.Plan.AssetsStarted {
		for _, item := range m.Plan.Assets {
			if productionPlanAssetSelected(m, item.Key) && !productionPlanArtifactValid(m, doc, artifacts, item.Key) {
				return submit(planPhaseAssets, item.Key, item.Name)
			}
		}
		next := action(planPhaseValidation, "production_check", map[string]any{})
		next["complete"] = true
		return next
	}
	if m.Plan.Version >= 5 {
		keys := m.Plan.SelectedPlanKeys
		if m.Plan.AssetsStarted {
			keys = m.Plan.SelectedAssetKeys
		}
		for _, key := range keys {
			deferredInventory := key == "inventory" && len(m.Plan.SelectedAssetKinds) > 0
			if productionPlanArtifactValid(m, doc, artifacts, key) && !deferredInventory {
				continue
			}
			if key == "inventory" {
				args := map[string]any{"assets": []any{}, "absent": m.Plan.Absent, "complete": true, "independent": true}
				for _, a := range artifacts {
					if a.Key == "story" {
						args["storyHash"] = a.ContentHash
					}
				}
				next := action(planPhaseInventory, "production_plan_inventory", args)
				if m.Plan.InventoryReviewVersion > 0 {
					next["inventoryReviewRequired"] = true
					next["inventoryReview"] = m.Plan.InventoryReview
					for _, artifact := range artifacts {
						if artifact.Key != "story" {
							continue
						}
						meta, _ := productionNode(doc, artifact.NodeID)["metadata"].(map[string]any)
						sections, sectionBodies := productionInventoryReviewSources(*m.Plan, stringValue(meta["content"]))
						next["sourceSections"], next["sourceSectionText"] = sections, sectionBodies
						break
					}
				}
				return next
			}
			section, ok := planSection(key)
			if ok {
				return submit(planPhaseStandards, key, section.Title)
			}
			if item := productionPlanItem(m, key); item != nil {
				return submit(planPhaseAssets, key, item.Name)
			}
		}
		next := action(planPhaseValidation, "", map[string]any{})
		next["complete"] = true
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
		kinds := map[string]int{}
		for _, asset := range m.Plan.Assets {
			kinds[asset.Kind]++
		}
		missingKinds := []string{}
		for _, kind := range planKinds(m) {
			if kinds[kind] == 0 && strings.TrimSpace(m.Plan.Absent[kind]) == "" {
				missingKinds = append(missingKinds, kind)
			}
		}
		next["registeredKindCounts"], next["undeclaredKinds"] = kinds, missingKinds
		next["instruction"] = "依据总纲逐篇章核对当前 kind 枚举；registeredAssets 已持久保存，只追加遗漏项或修正计划字段，不重发未变化的资产。undeclaredKinds 需要补登记或在 absent 说明不适用原因。必须显式传 complete：资产及 inventoryReview 均可在本步骤分批登记并设 false；末批 complete=true 对已保存的全表统一复检，无需重发未变化的章节。类别覆盖不等于语义完整，不为结束任务跳过遗漏；不重读选题、重写总纲或查询相同进度。"
		if m.Plan.InventoryReviewVersion > 0 {
			next["inventoryReviewRequired"] = true
			next["inventoryReview"] = m.Plan.InventoryReview
			for _, a := range artifacts {
				if a.Key == "story" {
					meta, _ := productionNode(doc, a.NodeID)["metadata"].(map[string]any)
					sections, sectionBodies := productionInventoryReviewSources(*m.Plan, stringValue(meta["content"]))
					next["sourceSections"] = sections
					next["sourceSectionText"] = sectionBodies
				}
			}
			next["instruction"] = stringValue(next["instruction"]) + productionInventoryReviewInstruction
		}
		return next
	}
	for _, key := range []string{"visual", "direction"} {
		if !productionPlanArtifactValid(m, doc, artifacts, key) {
			section, _ := planSection(key)
			return submit(planPhaseStandards, key, section.Title)
		}
	}
	if !productionPlanArtifactValid(m, doc, artifacts, "generation") {
		return submit(planPhaseGeneration, "generation", "生成与一致性规范")
	}
	if !m.Plan.AssetsStarted {
		return action(planPhaseValidation, "production_check", map[string]any{})
	}
	for _, item := range m.Plan.Assets {
		if productionPlanAssetSelected(m, item.Key) && !productionPlanArtifactValid(m, doc, artifacts, item.Key) && productionPlanPrerequisites(m, doc, artifacts, item.Key) == nil {
			return submit(planPhaseAssets, item.Key, item.Name)
		}
	}
	for _, item := range m.Plan.Assets {
		if productionPlanAssetSelected(m, item.Key) && !productionPlanArtifactValid(m, doc, artifacts, item.Key) {
			next := action(planPhaseAssets, "production_check", map[string]any{})
			next["blockedReason"] = "资产设计依赖无法推进，请检查清单依赖：" + item.Key
			return next
		}
	}
	return action(planPhaseValidation, "production_check", map[string]any{})
}

func productionOrderedPlanCoverage(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) map[string]any {
	issues, missing := []string{}, []productionPlanAsset{}
	count := 0
	keys := []string{"story", "inventory", "visual", "direction", "generation"}
	if m.Plan.Version >= 5 && !m.Plan.PlansStarted {
		keys = []string{"story"}
	}
	for _, key := range keys {
		if productionPlanArtifactValid(m, doc, artifacts, key) {
			count++
		} else {
			section, _ := planSection(key)
			issues = append(issues, "缺少或需更新前置制作规范："+section.Title)
		}
	}
	for _, item := range m.Plan.Assets {
		if !productionPlanAssetSelected(m, item.Key) {
			continue
		}
		if productionPlanArtifactValid(m, doc, artifacts, item.Key) {
			count++
		} else {
			missing = append(missing, item)
		}
	}
	if story := productionPlanStoryContent(m, doc, artifacts, "", ""); story != "" {
		if continuityIssues := productionPlanContinuityIssues(m, doc, artifacts, "story", story, nil); len(continuityIssues) > 0 {
			issues = append(issues, "人物关系连续性："+strings.Join(continuityIssues, "；"))
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
		if a.Key != "inventory" {
			entry["content"] = meta["content"]
		}
		result = append(result, entry)
	}
	return result
}

func productionPlanScopedTools(tools []map[string]any, work map[string]any, planVersions ...int) []map[string]any {
	next, _ := work["nextAction"].(map[string]any)
	key := stringValue(next["key"])
	priorityRequired := len(planVersions) > 0 && planVersions[0] >= 5
	for _, tool := range tools {
		fn, _ := tool["function"].(map[string]any)
		parameters, _ := fn["parameters"].(map[string]any)
		properties, _ := parameters["properties"].(map[string]any)
		if fn["name"] == "production_plan_inventory" {
			parameters["required"] = []string{"storyHash", "assets", "absent", "complete"}
			properties["complete"].(map[string]any)["description"] = "必须显式填写。资产或来源核对仍有后续批次时填 false；全部章节和资产已保存后传 true，服务端统一复检。已有内容不必重传，末批可传 assets=[]、inventoryReview=[]。"
			items := properties["assets"].(map[string]any)["items"].(map[string]any)
			items["required"] = []string{"key", "kind", "name", "episodes", "purpose", "plannedRange", "dependsOn"}
			if priorityRequired {
				items["required"] = append(items["required"].([]string), "priority")
			}
			properties["absent"].(map[string]any)["description"] = "只传确实没有资产的类别及非空理由；已有资产的类别直接省略，全部类别有资产时填写 {}，不要填空字符串。"
			if next["inventoryReviewRequired"] == true {
				parameters["required"] = []string{"storyHash", "assets", "absent", "complete", "inventoryReview"}
				sections, hasSections := next["sourceSections"].([]string)
				properties["inventoryReview"] = productionInventoryReviewSchema(len(sections))
				if hasSections {
					properties["inventoryReview"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)["section"].(map[string]any)["enum"] = sections
				}
				properties["inventoryReview"].(map[string]any)["description"] = productionInventoryReviewInstruction + " sourceSectionText 含本版全部可引用的章节原文；assetKey 可引用已有资产或本次同批登记资产，最终由系统统一核验。"
				itemProperties := items["properties"].(map[string]any)
				// The review and the new registry can arrive in the same atomic call;
				// only the server can validate those cross-field references together.
				assetKey := properties["inventoryReview"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)["requirements"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)["assetKey"].(map[string]any)
				delete(assetKey, "enum")
				itemProperties["subjectKeys"] = map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "maxItems": 100, "description": "关联主体的已登记key；可以前后互相关联，不代表设计先后。无关联填[]。"}
				items["required"] = append(items["required"].([]string), "subjectKeys")
			}
		}
		if fn["name"] != "production_submit" {
			continue
		}
		fields, required := map[string]any{}, []string{}
		schemaVersion := int(numberValue(next["documentSchemaVersion"], 1))
		sections := productionPlanDocumentSectionsForSchema(key, stringValue(next["kind"]), schemaVersion)
		partFields, isPart := next["documentFields"].([]string)
		for _, section := range sections {
			if isPart && !cloudAgentContainsString(partFields, section.Key) {
				continue
			}
			description := productionPlanFieldDescriptionForSchema(key, stringValue(next["kind"]), section, schemaVersion)
			if budget, ok := next["documentBudget"].(productionDocumentBudget); ok {
				description += fmt.Sprintf("本字段建议约 %d 字符，可在本批合计 %d 字符内调配；精简重复描述，保留可执行要求。", budget.SuggestedFieldChars[section.Key], budget.BatchMaxContentChars)
			}
			fields[section.Key] = map[string]any{"type": "string", "description": description}
			required = append(required, section.Key)
		}
		properties["document"] = map[string]any{"type": "object", "properties": fields, "required": required, "additionalProperties": false}
		// Plan documents are rendered from the typed document object. Leaving the
		// legacy free-form content field in the scoped schema encourages providers
		// to flatten document sections into unsupported top-level arguments.
		delete(properties, "content")
		if _, shared := planSection(key); shared {
			delete(properties, "design")
		}
		if isPart && (next["documentPartFinal"] != true || len(partFields) == 0) {
			delete(properties, "design")
		}
		if key != "" {
			properties["key"] = map[string]any{"type": "string", "enum": []string{key}}
		}
		if name := stringValue(next["name"]); name != "" {
			properties["name"] = map[string]any{"type": "string", "enum": []string{name}}
		}
		if args, ok := next["arguments"].(map[string]any); ok {
			if expected, ok := args["expectedHash"].(string); ok {
				properties["expectedHash"] = map[string]any{"type": "string", "enum": []string{expected}, "description": "目标文稿的版本号，原样沿用此唯一值。新建时为 \"\"，不得使用来源文稿或资产总表的哈希。"}
				parameters["required"] = []string{"key", "name", "document", "factIds", "expectedHash"}
			}
		}
		properties["factIds"] = map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "maxItems": 0, "description": "制作方案固定填写 []。"}
		fn["description"] = "保存当前 nextAction 文稿；document 按本次类型模板逐字段填写。修订沿用 expectedHash，factIds=[]。"
		if isPart {
			fn["description"] = "提交当前指定章节供服务端暂存；document 只含本批指定字段，已保存章节不重写。完整文稿由服务端合并校验。factIds=[]。"
		}
		if next["serverBoundArguments"] == true {
			for _, field := range []string{"key", "name", "factIds", "expectedHash"} {
				delete(properties, field)
			}
			parameters["required"] = []string{"document"}
			fn["description"] = "提交当前任务指定的文稿或章节；仅填写本次 document 模板和允许的 design。任务身份、固定引用及版本参数由服务端绑定，完整校验后保存。"
		}
	}
	return tools
}

func productionSavePlanInventory(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, policy RuntimePolicySetting) error {
	content, err := productionRenderPlanInventory(*m.Plan)
	if err != nil {
		return err
	}
	expected := ""
	for _, a := range artifacts {
		if a.Key == "inventory" {
			expected = a.ContentHash
		}
	}
	_, err = productionSubmit(repo, run, state, m, doc, "inventory", "资产总表与编码", content, nil, expected, nil, nil, policy)
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
