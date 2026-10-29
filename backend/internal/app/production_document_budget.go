package app

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

type productionDocumentBudget struct {
	MaxChars              int            `json:"maxChars"`
	HeadingChars          int            `json:"headingChars"`
	AcceptedContentChars  int            `json:"acceptedContentChars"`
	RemainingContentChars int            `json:"remainingContentChars"`
	BatchMaxContentChars  int            `json:"batchMaxContentChars"`
	SuggestedFieldChars   map[string]int `json:"suggestedFieldChars"`
}

// Use the renderer's Unicode character accounting, including all headings and
// separators, so later required chapters have a budget before they are written.
func productionDocumentHeadingChars(sections []productionDocumentSection) int {
	chars := -2
	for _, section := range sections {
		chars += utf8.RuneCountInString(section.Title) + 6
	}
	return max(0, chars)
}

func productionDocumentContentChars(fields map[string]string) int {
	chars := 0
	for _, value := range fields {
		chars += utf8.RuneCountInString(strings.TrimSpace(value))
	}
	return chars
}

func productionDocumentWorkBudget(m productionManifest, doc map[string]any, work productionParallelWork) productionDocumentBudget {
	sections := productionPlanDocumentSectionsForSchema(work.Key, productionPlanKind(m, work.Key), productionPlanDocumentSchemaVersion(m.Plan.Version))
	budget := productionDocumentBudget{MaxChars: productionArtifactContentLimit(m, doc, work.Key), HeadingChars: productionDocumentHeadingChars(sections), SuggestedFieldChars: map[string]int{}}
	pending := make([]string, 0, len(sections))
	for _, section := range sections {
		pending = append(pending, section.Key)
	}
	batch := pending
	if parts := work.DocumentParts; parts != nil {
		budget.AcceptedContentChars = productionDocumentContentChars(parts.Fields)
		pending = nil
		for _, fields := range parts.Pending {
			pending = append(pending, fields...)
		}
		batch = nil
		if len(parts.Pending) > 0 {
			batch = parts.Pending[0]
		}
	}
	budget.RemainingContentChars = max(0, budget.MaxChars-budget.HeadingChars-budget.AcceptedContentChars)
	if len(pending) > 0 {
		// Per-field shares are writing guidance, not a semantic size constraint.
		// A chapter can use another chapter's unused share within the total limit.
		weight := max(1, (min(budget.MaxChars, productionPlanDocumentMaxRunes)-budget.HeadingChars)/len(sections))
		weights, remainingWeight := map[string]int{}, 0
		for _, field := range pending {
			weights[field] = weight
			if work.Key == "story" && field == "episodeArchitecture" {
				weights[field] += max(0, budget.MaxChars-productionPlanDocumentMaxRunes)
			}
			remainingWeight += weights[field]
		}
		remainingChars := budget.RemainingContentChars
		for _, field := range pending {
			chars := remainingChars * weights[field] / remainingWeight
			remainingChars, remainingWeight = remainingChars-chars, remainingWeight-weights[field]
			if cloudAgentContainsString(batch, field) {
				budget.SuggestedFieldChars[field] = chars
				budget.BatchMaxContentChars += chars
			}
		}
	}
	return budget
}

func productionDocumentLengthError(actual, limit int) error {
	return cloudAgentFieldError("document", "field_length", fmt.Sprintf("章节合并后共 %d 字符，上限 %d，需压缩至少 %d 字符（含系统标题和分隔符）；按 documentBudget 精简重复叙述，保留全部制作要求、编码、条件与表格行，不截断或删除必填内容", actual, limit, actual-limit))
}

// Historical checkpoints may have spent the budget before the remaining
// chapters were requested. Reopen only oversized accepted chapters; originals
// remain private repair sources and the ordinary full validation still applies.
func productionRebalanceDocumentParts(m productionManifest, doc map[string]any, work *productionParallelWork) {
	parts := work.DocumentParts
	sections := productionPlanDocumentSectionsForSchema(work.Key, productionPlanKind(m, work.Key), parts.SchemaVersion)
	if len(sections) == 0 {
		return
	}
	targets := productionDocumentWorkBudget(m, doc, productionParallelWork{Key: work.Key}).SuggestedFieldChars
	if parts.RepairFields == nil {
		parts.RepairFields = map[string]string{}
	}
	reopened := [][]string{}
	for _, section := range sections {
		if value, exists := parts.Fields[section.Key]; exists && utf8.RuneCountInString(strings.TrimSpace(value)) > targets[section.Key] {
			parts.RepairFields[section.Key] = value
			delete(parts.Fields, section.Key)
			reopened = append(reopened, []string{section.Key})
		}
	}
	if len(reopened) > 0 {
		if len(parts.Pending) > 0 && len(parts.Pending[0]) == 0 {
			parts.Pending = parts.Pending[1:]
		}
		parts.Pending = append(reopened, parts.Pending...)
	}
}
