package app

import (
	"encoding/json"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/productionrules"
	"infinite-canvas/backend/internal/repository"
)

func productionCurrentPolicy(system string) string {
	const marker = "本轮是制作长任务。只能使用 production_* 工具"
	if index := strings.Index(system, marker); index >= 0 {
		system = system[:index]
	}
	return strings.TrimSpace(system) + "\n\n" + productionAgentPolicy + "\n\n" + productionrules.Block("assets", "text")
}

func productionScopedPolicy(system string, m productionManifest) string {
	policy := productionCurrentPolicy(system)
	if m.Category == "bible" {
		sections, _ := json.Marshal(productionBibleRequirements(m))
		policy += "\n\n当前作业的持久分类清单：" + string(sections) + "。每类必须独立保存为节点；历史对话中的分类数量不能替代此清单。复用已有产物，补齐缺项，不重新提取已处理正文。"
	}
	return policy
}

// Keep repair input bounded and include the actual prior document/hash. The
// model can amend a single asset without re-reading the entire transcript.
func productionPendingWork(m productionManifest, doc map[string]any, facts []productionFact, artifacts []model.ProductionAgentArtifact) map[string]any {
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
	kind := map[string]string{"characters": "character", "environments": "environment", "props": "prop", "special": "special"}[m.Category]
	missingFacts := []productionFact{}
	for _, f := range facts {
		if (m.Category == "bible" || f.Kind == kind) && !covered[f.ID] && len(missingFacts) < 12 {
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

func productionNextAction(repo *repository.Repository, userID string, m productionManifest) (map[string]any, error) {
	for _, source := range m.Sources {
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
	kind := map[string]string{"characters": "character", "environments": "environment", "props": "prop", "special": "special"}[m.Category]
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
	next, err := productionNextAction(s.repo, userID, manifest)
	if err != nil {
		return cloudAgentCall{}, err
	}
	call := cloudAgentCall{ID: "production-next-" + taskID}
	call.Function.Name = next["tool"].(string)
	arguments, _ := json.Marshal(next["arguments"])
	call.Function.Arguments = string(arguments)
	return call, nil
}
