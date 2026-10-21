package app

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/productionrules"
	"infinite-canvas/backend/internal/repository"
)

func productionPolicyBase(system string) string {
	const marker = "本轮是制作长任务。只能使用 production_* 工具"
	if index := strings.Index(system, marker); index >= 0 {
		system = system[:index]
	}
	// Restored runs may predate source scoping. Their system snapshot must not
	// silently reintroduce the whole canvas library outside the manifest.
	const contextMarker = "\n\n本轮执行上下文：\n"
	if index := strings.Index(system, contextMarker); index >= 0 {
		start := index + len(contextMarker)
		decoder := json.NewDecoder(strings.NewReader(system[start:]))
		var context map[string]any
		if decoder.Decode(&context) == nil {
			if _, exists := context["referenceCandidates"]; exists {
				delete(context, "referenceCandidates")
				encoded, err := json.Marshal(context)
				if err == nil {
					system = system[:start] + string(encoded) + system[start+int(decoder.InputOffset()):]
				}
			}
		}
	}
	return strings.TrimSpace(system)
}

func productionCurrentPolicy(system string) string {
	system = productionPolicyBase(system)
	return strings.TrimSpace(system) + "\n\n" + productionAgentPolicy + "\n\n" + productionrules.Block("assets", "text")
}

func productionScopedPolicy(system string, m productionManifest) string {
	system = productionPolicyBase(system)
	if m.Plan != nil {
		policy := productionPlanPolicy
		if m.Plan.Version >= 2 {
			policy = unifiedPlanPolicy
		}
		if m.Plan.Version >= 3 {
			policy = strings.NewReplacer("人物（含配角和画外音）、场景、道具、特殊资产、独立声音五类", "人物（含配角和画外音）、场景、道具、独立声音四类", "覆盖全部篇章和五类", "覆盖全部篇章和四类", "CHR/SCN/PRP/SPC/AUD", "CHR/SCN/PRP/AUD").Replace(policy)
			policy += "\n" + productionPlanIntegratedEffectsPolicy
		}
		return strings.TrimSpace(system) + "\n\n" + policy + "\n\n" + productionrules.Block("story", "text")
	}
	if m.Storyboard != nil {
		if m.Storyboard.Version == storyboardEpisodeVersion {
			return strings.TrimSpace(system) + "\n\n" + storyboardEpisodePolicy + "\n\n" + productionrules.Block("storyboard", "text")
		}
		return strings.TrimSpace(system) + "\n\n" + storyboardPolicy + "\n\n" + productionrules.Block("storyboard", "text")
	}
	policy := productionCurrentPolicy(system)
	if m.Category == "reconcile" {
		policy = strings.ReplaceAll(policy, "只生成本轮指定分类，逐项调用 production_submit 写入。", "统一处理人物、场景、道具、独立声音四类资产，逐项调用 production_submit 写入。")
		policy = strings.ReplaceAll(policy, "character/environment/prop/special/setting/style/sound", "character/environment/prop/setting/style/sound")
		policy = strings.ReplaceAll(policy, "特殊资产只记录正文确有的重复元素。", productionPlanIntegratedEffectsPolicy)
		policy += "\n当前任务为统一资产校核与补充：同一集正文只解析一次，统一处理 character/environment/prop/sound 四类，跨集归并。先读前置方案共用规范和资产索引，复用对应资产编码，按需读取相关档案，不重新设计全局规范。不重复提交已关联事实。setting/style 用于识别规范冲突，冲突写入相关资产 uncertainties。已有资产提交 key 使用前置编码，新资产使用稳定主体标识并沿用返回的 identity 编码。人物声线与声音资产保持关联一致。旧版 special 仅可按原编号修订已有档案，不新增此类身份。"
	}
	policy += "\n若来源含 story.plan，先沿用其中已规划的资产编号、人物性格声线、外观、空间和状态规则。只对照正文核对实际出场、变化、新增项和冲突，补齐可执行提示词，不重新创造一套设定。计划出场不等于正文证据，factIds 仍须来自本轮正文；没有实际出场的计划资产不伪称已出现。"
	if m.Category == "bible" {
		sections, _ := json.Marshal(productionBibleRequirements(m))
		policy += "\n\n当前作业的持久分类清单：" + string(sections) + "。每类必须独立保存为节点；历史对话中的分类数量不能替代此清单。复用已有产物，补齐缺项，不重新提取已处理正文。"
	}
	return policy
}

// Keep repair input bounded and include the actual prior document/hash. The
// model can amend a single asset without re-reading the entire transcript.
func productionPendingWork(m productionManifest, doc map[string]any, facts []productionFact, artifacts []model.ProductionAgentArtifact) map[string]any {
	if m.Plan != nil {
		return productionPlanCoverage(m, doc, artifacts)
	}
	covered := map[string]bool{}
	repairs := []map[string]any{}
	for _, a := range artifacts {
		for _, id := range productionIDs(json.RawMessage(a.FactIDsJSON)) {
			covered[id] = true
		}
		node := productionNode(doc, a.NodeID)
		meta, _ := node["metadata"].(map[string]any)
		missing := productionDocumentMissing(m.Category, a.Key, stringValue(meta["content"]))
		if len(missing) > 0 && len(repairs) < 1 {
			repairs = append(repairs, map[string]any{"key": a.Key, "name": node["title"], "expectedHash": a.ContentHash, "content": meta["content"], "missingSections": missing})
		}
	}
	missingFacts := []productionFact{}
	for _, f := range facts {
		if productionAssetFact(m, f.Kind) && !covered[f.ID] && len(missingFacts) < 12 {
			missingFacts = append(missingFacts, f)
		}
	}
	missingSections := []productionBibleSection{}
	for _, section := range productionBibleRequirements(m) {
		found := false
		for _, artifact := range artifacts {
			found = found || artifact.Key == section.Key
		}
		if !found {
			missingSections = append(missingSections, section)
		}
	}
	return map[string]any{"facts": missingFacts, "repairArtifacts": repairs, "missingBibleSections": missingSections, "instruction": "先 production_submit 补齐本批遗漏事实、缺少的规范分类或 repairArtifacts 的 document，使用稳定 key 和 expectedHash；再检查下一批。缺规范但无遗漏事实时查询共享事实选取相关依据，不虚构引用。不需要用户先确认制作规范；没有工具调用的普通总结不能结束任务。"}
}

// Report every invalid index without echoing source text or arbitrary model fields.
// The whole page stays unprocessed until all facts pass; nothing is silently lost.
func productionValidateFacts(facts []workflowFact, source string) (string, error) {
	invalid := []string{}
	for i, fact := range facts {
		one, _ := json.Marshal(map[string]any{"facts": []workflowFact{fact}})
		if _, err := selectWorkflowFacts(string(one), source, "bible"); err != nil {
			invalid = append(invalid, fmt.Sprintf("第 %d 项：%s", i+1, err.Error()))
		}
	}
	if len(invalid) > 0 {
		return "", cloudAgentFieldError("facts", "invalid_evidence", strings.Join(invalid[:min(12, len(invalid))], "；")+fmt.Sprintf("；共 %d 项校验失败。evidence 必须来自当前集正文的连续片段，允许换行、中文/英文标点和 Markdown 标记差异，但不能改写、拼接其他集或只提交过短词语。修正后重新提交本页完整 facts。", len(invalid)))
	}
	body, _ := json.Marshal(map[string]any{"facts": facts})
	return selectWorkflowFacts(string(body), source, "bible")
}

func productionNextAction(repo *repository.Repository, userID string, m productionManifest, runIDs ...string) (map[string]any, error) {
	if m.Plan != nil && m.Plan.Version >= 2 && len(runIDs) > 0 {
		return productionPlanRunNextAction(repo, userID, runIDs[0], m)
	}
	if m.Storyboard != nil {
		return map[string]any{"tool": "production_storyboard_context", "arguments": map[string]any{}}, nil
	}
	sources := append([]productionSource{}, m.Sources...)
	if m.Category == "reconcile" {
		sort.SliceStable(sources, func(i, j int) bool { return sources[i].Step != "story.body" && sources[j].Step == "story.body" })
	}
	for _, source := range sources {
		if source.OnDemand {
			continue
		}
		for _, id := range source.Pages {
			page, err := repo.ProductionAgentPage(userID, id)
			if err != nil {
				return nil, err
			}
			if (source.Step == "story.body" && !page.Processed) || (source.Step != "story.body" && !m.Read[id]) {
				return map[string]any{"tool": "production_read", "arguments": map[string]any{"pageId": id}, "episode": source.Episode, "step": source.Step, "instruction": "读取此页；若为正文，紧接着保存本页事实，再按返回的 nextAction 继续。"}, nil
			}
		}
	}
	if m.Plan != nil {
		return map[string]any{"tool": "production_check", "arguments": map[string]any{}, "instruction": "根据缺项创作：先 production_submit 保存 story，再 production_plan_inventory 登记全剧资产清单，然后逐项 production_submit。已保存的用 production_query(assetKey) 读取后增补，不能只重复检查。"}, nil
	}
	kind := productionCategoryKind(m.Category)
	facts, _, _, err := productionFacts(repo, userID, m)
	if err != nil {
		return nil, err
	}
	kindKey := kind
	if kindKey == "" {
		kindKey = "*"
	}
	offset := productionQueryCursor(m, kindKey, productionFactsForKind(facts, kind))
	filtered := productionFactsForKind(facts, kind)
	if offset < len(filtered) {
		return map[string]any{"tool": "production_query", "arguments": map[string]any{"kind": kind, "offset": offset}, "instruction": "查询尚未归并的事实；每批先 production_submit 保存或增量更新资产，再查下一批。复用现有产物和 hash，不重复提取正文。"}, nil
	}
	return map[string]any{"tool": "production_check", "arguments": map[string]any{}, "instruction": "事实已查询。根据覆盖检查中的遗漏调用 production_submit 保存或修订资产；不要反复查询相同事实，也不要仅重复检查。"}, nil
}

func productionFactsForKind(facts []productionFact, kind string) []productionFact {
	if kind == "" {
		return facts
	}
	filtered := make([]productionFact, 0, len(facts))
	for _, fact := range facts {
		if fact.Kind == kind {
			filtered = append(filtered, fact)
		}
	}
	return filtered
}

// productionQueryCursor returns the next contiguous offset. New manifests use
// QueryCursors. Older manifests may only have the per-fact Queried map; derive
// one cursor from that map once, then the next successful query persists the
// compact representation.
func productionQueryCursor(m productionManifest, key string, filtered []productionFact) int {
	if m.QueryCursors != nil {
		if cursor, ok := m.QueryCursors[key]; ok && cursor >= 0 {
			return min(cursor, len(filtered))
		}
	}
	for index, fact := range filtered {
		if !m.Queried[fact.ID] {
			return index
		}
	}
	return len(filtered)
}

func (s *Service) productionRepairCall(userID, runID, taskID string) (cloudAgentCall, error) {
	job, err := s.repo.ProductionAgentJob(userID, runID)
	if err != nil {
		return cloudAgentCall{}, err
	}
	var manifest productionManifest
	if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
		return cloudAgentCall{}, err
	}
	next, err := productionNextAction(s.repo, userID, manifest, runID)
	if err != nil {
		return cloudAgentCall{}, err
	}
	call := cloudAgentCall{ID: "production-next-" + taskID}
	call.Function.Name = next["tool"].(string)
	// A repair probe may read/check, but cannot invent document bodies or submit
	// an empty inventory on behalf of the model.
	if call.Function.Name == "production_submit" || call.Function.Name == "production_plan_inventory" {
		call.Function.Name = "production_status"
		next["arguments"] = map[string]any{}
	}
	arguments, _ := json.Marshal(next["arguments"])
	call.Function.Arguments = string(arguments)
	return call, nil
}
