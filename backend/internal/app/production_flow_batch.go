package app

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
)

const productionFlowBatchPolicy = "business-batches-v3"

func productionFlowSourceBatches(sources []productionFlowSource) [][]productionFlowSource {
	var batches [][]productionFlowSource
	var current []productionFlowSource
	size := 0
	for _, src := range sources {
		next := utf8.RuneCountInString(src.Text)
		if len(current) > 0 && (size+next > 4800 || len(current) >= 4) {
			batches = append(batches, current)
			current, size = nil, 0
		}
		current = append(current, src)
		size += next
	}
	if len(current) > 0 {
		batches = append(batches, current)
	}
	return batches
}

func productionFlowInventoryGraph(g *productionFlowGraph, sources []productionFlowSource) bool {
	ready := true
	prefix := []model.ProductionFlowUnit{}
	prefixOpen := true
	for i, batch := range productionFlowSourceBatches(sources) {
		u, ok := g.add(fmt.Sprintf("extract/batch/%04d", i+1), "extract", fmt.Sprintf("提取并核对第%d批资产需求（%d份来源）", i+1, len(batch)), map[string]any{"sources": batch, "coveragePolicy": "integrated-v2", "soundPolicy": "action-sound-v2"})
		adopted := []model.ProductionFlowUnit{u}
		// An explicitly requested re-audit can make another semantic pass. It
		// is not part of every normal generation and reuses initial extraction.
		if ok && g.AuditRevision > 0 {
			audit, checked := g.add(fmt.Sprintf("omissions/batch/%04d", i+1), "omissions", fmt.Sprintf("重新核对第%d批资产需求", i+1), map[string]any{"sources": batch, "covered": productionFlowCandidates(adopted), "soundPolicy": "action-sound-v2", "coveragePolicy": "categories-v1", "auditRevision": g.AuditRevision})
			ok = ok && checked
			adopted = append(adopted, audit)
		}
		ready = ready && ok
		prefixOpen = prefixOpen && ok
		if prefixOpen {
			// This is an in-memory grouping only; durable receipts stay separate.
			u.ResultJSON = productionFlowJSON(map[string]any{"candidates": productionFlowCandidates(adopted)})
			prefix = append(prefix, u)
		}
	}
	all := productionFlowCandidates(prefix)
	extractionReady := ready
	byID := map[string]productionFlowCandidate{}
	for _, c := range all {
		byID[c.ID] = c
	}
	for _, kind := range productionCurrentPlanKinds {
		index := productionFlowIdentityIndex{byLabel: map[string][]int{}}
		kindReady := true
		for i := 0; i < len(prefix); i += 4 {
			endGroup := min(i+4, len(prefix))
			if endGroup-i < 4 && !extractionReady {
				break
			}
			assigned := []productionFlowCandidate{}
			for _, c := range productionFlowCandidates(prefix[i:endGroup]) {
				if c.Kind == kind {
					assigned = append(assigned, c)
				}
			}
			sort.SliceStable(assigned, func(i, j int) bool { return assigned[i].ID < assigned[j].ID })
			for start := 0; start < len(assigned); {
				end := productionFlowResolveEnd(assigned, start)
				shortlist, evidence := productionFlowResolveContext(&index, assigned[start:end], byID)
				u, ok := g.add(fmt.Sprintf("resolve/%s/batch/%04d/%04d", kind, i+1, start), "resolve", "归并身份："+productionPlanGroupLabels[kind], map[string]any{"kind": kind, "assignedCandidates": assigned[start:end], "existingEntities": shortlist, "existingEvidence": evidence, "identityPolicy": "continuity-v3", "auditRevision": g.AuditRevision})
				if !ok {
					kindReady = false
					break
				}
				var entities []productionFlowEntity
				_ = decodeFlowValue(productionFlowValue(u)["entities"], &entities)
				for _, entity := range entities {
					if n, exists := index.byID[entity.ID]; exists {
						previous := index.prior[n]
						previous.Members = append(previous.Members, entity.Members...)
						previous.Aliases = append(previous.Aliases, entity.Aliases...)
						index.append(previous)
					} else {
						index.append(entity)
					}
				}
				start = end
			}
			if !kindReady {
				break
			}
		}
		ready = ready && kindReady
	}
	if !ready {
		return false
	}
	return productionFlowIdentityGraph(g, byID)
}

// Decode only complete array members. Never close a truncated object, repair
// a string, or infer missing syntax/content from a provider's partial response.
func productionFlowCompleteArrayItems(raw, field string) []json.RawMessage {
	decoder := json.NewDecoder(strings.NewReader(productionFlowNormalizeJSON(raw)))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return nil
	}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return nil
		}
		if key != field {
			var skip json.RawMessage
			if decoder.Decode(&skip) != nil {
				return nil
			}
			continue
		}
		token, err := decoder.Token()
		if err != nil || token != json.Delim('[') {
			return nil
		}
		items := []json.RawMessage{}
		for decoder.More() {
			var item json.RawMessage
			if decoder.Decode(&item) != nil {
				break
			}
			items = append(items, item)
		}
		return items
	}
	return nil
}

func productionFlowBatchInstruction(stage string) string {
	switch stage {
	case "foundation":
		return "本次将主线命题、动机、结局与时代背景、能力规则、连续性约束一起确定。逐个填写selectedFields，不遗漏、不相互矛盾。"
	case "characters":
		return "本次将人物成长、关系、未定事项与冲突、完整因果链、伏笔回收一起规划。逐个填写selectedFields，遵循已定世界与结局。"
	case "extract":
		return "在同一次提取中完成四类覆盖核对与声音核对，填写soundReview、coverageReview、sourceReviews。sourceReviews逐份覆盖sources，每份仅填sourceRef及核对理由；候选与来源的关联由服务端根据已验证引文生成，不自行重复维护候选引用列表。coverageReview中新增候选用added，引用本批localRef或adopted.candidates的ID。已保存候选不要重新编号或重复提取。"
	}
	return ""
}

func productionFlowHasBatchPolicy(input map[string]any) bool {
	return strings.TrimSpace(stringValue(input["executionPolicy"])) == productionFlowBatchPolicy
}
