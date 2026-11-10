package app

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

type productionFlowCoverage struct {
	Kind        string   `json:"kind"`
	Disposition string   `json:"disposition"`
	Candidates  []string `json:"candidates"`
	Reason      string   `json:"reason"`
}

func productionFlowCoverageIDs(raw json.RawMessage, candidates []productionFlowCandidate) json.RawMessage {
	refs := map[string]string{}
	for _, c := range candidates {
		refs[c.LocalRef] = c.ID
	}
	var rows []productionFlowCoverage
	_ = json.Unmarshal(raw, &rows)
	for i := range rows {
		if rows[i].Disposition == "added" {
			for n, ref := range rows[i].Candidates {
				if id, ok := refs[ref]; ok {
					rows[i].Candidates[n] = id
				}
			}
		}
	}
	return json.RawMessage(productionFlowJSON(rows))
}

func productionFlowMergeCoverage(parent model.ProductionFlowUnit, result map[string]any, children []model.ProductionFlowUnit) {
	rows := map[string]productionFlowCoverage{}
	for _, child := range append([]model.ProductionFlowUnit{parent}, children...) {
		var coverage []productionFlowCoverage
		_ = decodeFlowValue(productionFlowValue(child)["coverageReview"], &coverage)
		for _, row := range coverage {
			previous, ok := rows[row.Kind]
			if !ok || previous.Disposition == "none" {
				rows[row.Kind] = row
				continue
			}
			if row.Disposition == "none" {
				continue
			}
			// Added candidates are checked together with the original covered set
			// below, so a split can contain both without losing either reference.
			previous.Candidates = productionFlowUnique(append(previous.Candidates, row.Candidates...))
			previous.Reason += "；" + row.Reason
			if row.Disposition == "added" {
				previous.Disposition = "added"
			}
			rows[row.Kind] = previous
		}
	}
	ordered := []productionFlowCoverage{}
	for _, kind := range productionCurrentPlanKinds {
		if row, ok := rows[kind]; ok {
			ordered = append(ordered, row)
		}
	}
	result["coverageReview"] = ordered
}

func productionFlowCoverageSchema() map[string]any {
	return map[string]any{"type": "array", "minItems": 4, "maxItems": 4, "items": map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"kind":        map[string]any{"type": "string", "enum": productionCurrentPlanKinds},
			"disposition": map[string]any{"type": "string", "enum": []string{"covered", "added", "none"}},
			"candidates":  map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			"reason":      map[string]any{"type": "string"},
		}, "required": []string{"kind", "disposition", "candidates", "reason"},
	}}
}

func productionFlowValidateCoverage(raw json.RawMessage, input map[string]any, current []productionFlowCandidate) []productionFlowIssue {
	issues := []productionFlowIssue{}
	add := func(kind, msg string) {
		issues = append(issues, productionFlowIssueAt("schema", "coverage_review", kind, msg))
	}
	var rows []productionFlowCoverage
	if json.Unmarshal(raw, &rows) != nil {
		add("coverageReview", "需逐类提交可核验的补漏结论，不能只写已检查")
		return issues
	}
	var covered []productionFlowCandidate
	_ = decodeFlowValue(input["covered"], &covered)
	known, fresh := map[string]productionFlowCandidate{}, map[string]productionFlowCandidate{}
	for _, c := range covered {
		known[c.ID] = c
	}
	for _, c := range current {
		fresh[c.LocalRef] = c
		fresh[c.ID] = c
	}
	for ref, c := range known {
		if _, ok := fresh[ref]; !ok {
			fresh[ref] = c
		}
	}
	seen := map[string]bool{}
	for _, r := range rows {
		if !cloudAgentContainsString(productionCurrentPlanKinds, r.Kind) || seen[r.Kind] || strings.TrimSpace(r.Reason) == "" {
			add(r.Kind, "类别无效、重复或缺少具体核对理由")
			continue
		}
		seen[r.Kind] = true
		if r.Disposition == "none" {
			present := false
			for _, c := range covered {
				present = present || c.Kind == r.Kind
			}
			for _, c := range current {
				present = present || c.Kind == r.Kind
			}
			if len(r.Candidates) != 0 || present {
				add(r.Kind, "已有该类候选，不能同时声明无此类需求")
			}
			continue
		}
		pool := known
		if r.Disposition == "added" {
			pool = fresh
		} else if r.Disposition != "covered" {
			add(r.Kind, "处理方式须为covered、added或none")
			continue
		}
		if len(r.Candidates) == 0 {
			add(r.Kind, "声明覆盖或新增时必须引用实际候选")
		}
		for _, ref := range r.Candidates {
			if c, ok := pool[ref]; !ok || c.Kind != r.Kind {
				add(r.Kind, "核对结论引用的候选不存在或类别不符："+ref)
			}
		}
	}
	for _, kind := range productionCurrentPlanKinds {
		if !seen[kind] {
			add(kind, "缺少该类需求核对结论")
		}
	}
	return issues
}

func productionFlowCandidateRelations(current []productionFlowCandidate, input map[string]any) ([]productionFlowCandidate, []productionFlowIssue) {
	refs := map[string]string{}
	for _, c := range current {
		refs[c.LocalRef] = c.ID
		refs[c.ID] = c.ID
	}
	var covered []productionFlowCandidate
	_ = decodeFlowValue(input["covered"], &covered)
	for _, c := range covered {
		refs[c.ID] = c.ID
	}
	issues := []productionFlowIssue{}
	for i := range current {
		c := &current[i]
		for _, field := range []struct {
			name   string
			values *[]string
		}{{"subjectRefs", &c.SubjectRefs}, {"dependsOnRefs", &c.DependsOnRefs}} {
			resolved := []string{}
			for _, ref := range *field.values {
				id, ok := refs[ref]
				if !ok || id == c.ID {
					issues = append(issues, productionFlowIssueAt("schema", "candidate_relation", c.LocalRef+"."+field.name, "关联须引用本批localRef或covered候选ID，不能引用自身或不存在的主体："+ref))
					// Keep unresolved input for a targeted repair, never silently drop it.
					resolved = append(resolved, ref)
				} else if !cloudAgentContainsString(resolved, id) {
					resolved = append(resolved, id)
				}
			}
			*field.values = resolved
		}
	}
	return current, issues
}
