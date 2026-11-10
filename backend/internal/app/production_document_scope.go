package app

import (
	"strings"

	"infinite-canvas/backend/internal/model"
)

// Asset authors need the adopted world and their own registered identity, not
// every episode or every other dossier. Keep source sections whole.
func productionAssetWorkContext(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, item productionPlanAsset) map[string]any {
	documents := productionPlanRequiredContext(m, doc, artifacts, "story")
	for _, entry := range documents {
		content := stringValue(entry["content"])
		if scoped := productionStandardStoryContext(m, content); scoped != "" {
			entry["content"] = scoped
		}
		entry["scope"] = "沿用总纲中的主线、世界规则与关系约束；本轮只设计指定资产，不重写逐集内容或其他资产。"
	}
	return map[string]any{
		"requiredDocuments": documents,
		"registeredAssets": []map[string]any{{
			"key": item.Key, "identity": item.Identity, "kind": item.Kind, "name": item.Name,
			"episodes": item.Episodes, "coreFacts": item.CoreFacts, "purpose": item.Purpose,
			"plannedRange": item.PlannedRange, "aliases": item.Aliases, "variants": item.Variants,
			"subjectKeys": item.SubjectKeys, "parentKey": item.ParentKey, "baseKey": item.BaseKey, "stateName": item.StateName,
		}},
		"selectedAssetKeys": []string{item.Key}, "selectedAssetKinds": []string{item.Kind},
		"assetBackgroundContext": productionAssetBackgroundContext(m, item.Key),
	}
}

func productionPlanStandard(key string) bool {
	return key == "visual" || key == "direction" || key == "generation"
}

// Shared standards need creative boundaries, not the full episode/asset tables.
// Keep complete source sections and their version receipt; never truncate rules.
func productionStandardStoryContext(m productionManifest, content string) string {
	var parts []string
	for _, section := range productionPlanDocumentSectionsForSchema("story", "", productionPlanSchemaVersion(*m.Plan)) {
		if section.Key == "episodeArchitecture" || section.Key == "coreAssets" || section.Key == "arcs" {
			continue
		}
		if body := productionPlanSectionBody("story", "", content, section.Key, productionPlanSchemaVersion(*m.Plan)); body != "" {
			parts = append(parts, "## "+section.Title+"\n"+body)
		}
	}
	return strings.Join(parts, "\n\n")
}

func productionLargeStoryPlan(m productionManifest, doc map[string]any, key string) bool {
	if key != "story" || m.Plan == nil || m.Plan.StoryStructureVersion == 0 {
		return false
	}
	parameters, _ := productionWorkflow(productionNode(doc, m.FrameID))["parameters"].(map[string]any)
	return int(numberValue(parameters["episodeCount"], 0)) >= 24
}

// A chapter worker must not receive a second, broader delivery instruction in
// the user turn or the whole-plan system policy. Preserve the original brief as
// reference data, with the durable checkpoint defining this call's scope.
func productionDocumentWorkPrompt(system, prompt string, m productionManifest, work productionParallelWork, context map[string]any) (string, string) {
	if m.Plan != nil && m.Plan.Version >= 5 && work.Key != "story" {
		// Adopted creative facts already live in the saved story. The initial
		// request can contain obsolete one-shot delivery instructions.
		policy := productionPolicyBase(system) + "\n当前为服务端派发的制作子任务，以本轮 instruction、nextAction 和工具字段为唯一执行范围；已保存总纲是创作事实来源。只提交当前批次，不另行调用工具读取状态，不规划其他阶段。"
		if work.Key == "inventory" {
			policy += "\n" + productionInventoryWorkerInstruction
		}
		if work.DocumentParts != nil {
			policy += "\n当前是章节子任务，只生成 nextAction.documentFields 指定字段，直接调用 production_submit，已接受章节不重写；完整文稿由服务端合并。"
		}
		return policy, "执行当前制作子任务。按持久检查点中的分配范围提交内容。"
	}
	if work.DocumentParts == nil {
		return productionScopedPolicy(system, m), prompt
	}
	context["originalRequest"] = prompt
	policy := productionPolicyBase(system) + "\n\n" + productionWorldPolicy + "\n当前是服务端派发的文稿章节子任务。只生成 nextAction.documentFields 指定章节并直接调用 production_submit；originalRequest 是完整项目要求和创作约束的参考数据，不代表本次要规划或输出整份文稿。已接受章节为定稿依据，后续章节由其他调用完成，本次不构思、展开或提交后续章节、全季逐集表或其他资产。只需完成当前字段，不能为了整份任务完整性继续推演。遵守当前工具字段说明和本批预算，保留用户的明确设定及补充要求。服务端已经读取来源、绑定目标版本，并负责最后合并与完整校验。"
	if _, exists := context["nextAction"].(map[string]any)["documentEpisodeRange"]; exists {
		policy += " 当前字段是分批逐集表，只生成 documentEpisodeRange 指定集号；整季主线沿用已接受章节，不重新规划全季。前一批末集仅用于承接，不重复提交；本批结尾衔接后续集次。"
	}
	return strings.TrimSpace(policy), "执行当前章节子任务。只提交指定字段；完整项目要求见 originalRequest，已完成内容及本批范围见持久检查点。"
}
