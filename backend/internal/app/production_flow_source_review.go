package app

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

type productionFlowSourceReview struct {
	SourceRef  string   `json:"sourceRef"`
	Candidates []string `json:"candidates"`
	Reason     string   `json:"reason"`
}

func productionFlowValidateSourceReviews(raw json.RawMessage, sources []productionFlowSource) []productionFlowIssue {
	issues := []productionFlowIssue{}
	add := func(ref, message string) {
		issues = append(issues, productionFlowIssueAt("schema", "source_coverage", ref, message))
	}
	var rows []productionFlowSourceReview
	if json.Unmarshal(raw, &rows) != nil {
		add("sourceReviews", "需逐份核对来源，不能只覆盖本批第一份素材")
		return issues
	}
	known := map[string]bool{}
	for _, src := range sources {
		known[src.ID] = true
	}
	seen := map[string]bool{}
	for _, row := range rows {
		if !known[row.SourceRef] || seen[row.SourceRef] || strings.TrimSpace(row.Reason) == "" {
			add(row.SourceRef, "来源不存在、重复或缺少核对依据")
			continue
		}
		seen[row.SourceRef] = true
	}
	for _, src := range sources {
		if !seen[src.ID] {
			add(src.ID, "此来源尚未核对，仅补充此来源的遗漏与结论")
		}
	}
	return issues
}

func productionFlowSourceReviewIDs(raw json.RawMessage, candidates []productionFlowCandidate) json.RawMessage {
	var rows []productionFlowSourceReview
	_ = json.Unmarshal(raw, &rows)
	refs := map[string][]string{}
	for _, c := range candidates {
		refs[c.SourceRef] = append(refs[c.SourceRef], c.ID)
	}
	for i := range rows {
		// Occurrence ownership comes from validated source quotes, not another
		// model-maintained copy of candidate references.
		rows[i].Candidates = productionFlowUnique(refs[rows[i].SourceRef])
	}
	return json.RawMessage(productionFlowJSON(rows))
}

func productionFlowMergeSourceReviews(parent model.ProductionFlowUnit, result map[string]any, children []model.ProductionFlowUnit) {
	byRef := map[string]productionFlowSourceReview{}
	for _, u := range append([]model.ProductionFlowUnit{parent}, children...) {
		var rows []productionFlowSourceReview
		_ = decodeFlowValue(productionFlowValue(u)["sourceReviews"], &rows)
		for _, row := range rows {
			prior := byRef[row.SourceRef]
			prior.SourceRef = row.SourceRef
			prior.Candidates = productionFlowUnique(append(prior.Candidates, row.Candidates...))
			if prior.Reason != "" {
				prior.Reason += "；"
			}
			prior.Reason += row.Reason
			byRef[row.SourceRef] = prior
		}
	}
	var sources []productionFlowSource
	_ = decodeFlowValue(productionFlowInput(parent)["sources"], &sources)
	rows := []productionFlowSourceReview{}
	for _, src := range sources {
		if row, ok := byRef[src.ID]; ok {
			rows = append(rows, row)
		}
	}
	result["sourceReviews"] = rows
}
