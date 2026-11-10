package app

import (
	"encoding/json"
	"strings"
)

const productionDocumentEpisodeBatchSize = 4

type productionDocumentEpisodeRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
	Total int `json:"total"`
}

func productionDocumentEpisodeBatch(m productionManifest, doc map[string]any, work productionParallelWork) *productionDocumentEpisodeRange {
	parts := work.DocumentParts
	if m.Plan == nil || m.Plan.StoryStructureVersion == 0 || work.Key != "story" || parts == nil || len(parts.Pending) == 0 || len(parts.Pending[0]) != 1 || parts.Pending[0][0] != "episodeArchitecture" {
		return nil
	}
	parameters, _ := productionWorkflow(productionNode(doc, m.FrameID))["parameters"].(map[string]any)
	total := int(numberValue(parameters["episodeCount"], 0))
	if total < 1 || total > 1000 {
		return nil
	}
	start := 1
	for parts.EpisodeRows[start] != "" && start <= total {
		start++
	}
	if start > total {
		return nil
	}
	size := parts.EpisodeBatchSize
	if size <= 0 {
		size = productionDocumentEpisodeBatchSize
	}
	end := min(total, start+size-1)
	for episode := start + 1; episode <= end; episode++ {
		if parts.EpisodeRows[episode] != "" {
			end = episode - 1
			break
		}
	}
	return &productionDocumentEpisodeRange{Start: start, End: end, Total: total}
}

func productionDocumentEpisodeContext(m productionManifest, doc map[string]any, work productionParallelWork, context map[string]any) {
	batch := productionDocumentEpisodeBatch(m, doc, work)
	if batch == nil {
		return
	}
	next := context["nextAction"].(map[string]any)
	next["documentEpisodeRange"] = batch
	budget := next["documentBudget"].(productionDocumentBudget)
	budget.BatchMaxContentChars = min(budget.BatchMaxContentChars, (batch.End-batch.Start+1)*300)
	budget.SuggestedFieldChars["episodeArchitecture"] = budget.BatchMaxContentChars
	next["documentBudget"] = budget
	if batch.Start > 1 {
		context["previousEpisodeRow"] = work.DocumentParts.EpisodeRows[batch.Start-1]
	}
	if row := work.DocumentParts.EpisodeRows[batch.End+1]; row != "" {
		context["followingEpisodeRow"] = row
	}
	if draft := productionEpisodeScopedDraft(work, *batch); len(draft) > 0 {
		context["episodeRepairDraft"] = draft
	}
}

// Successful batches remain private until full-document validation. Partial
// recovery of rejected batches belongs to the failure-recording transaction.
func productionStageDocumentEpisodes(m productionManifest, doc map[string]any, work *productionParallelWork, text string, batch productionDocumentEpisodeRange) (string, bool, error) {
	raw, _ := json.Marshal(text)
	rows, err := productionReadEpisodeRows(raw, batch)
	if err != nil {
		return "", false, err
	}
	merged := map[int]string{}
	for episode, row := range work.DocumentParts.EpisodeRows {
		merged[episode] = row
	}
	for episode, row := range rows {
		merged[episode] = row
	}
	combined := productionEpisodeTable(merged)
	if err := productionEpisodeCheckpointBudget(m, doc, *work, combined); err != nil {
		return "", false, err
	}
	for episode := 1; episode <= batch.Total; episode++ {
		if merged[episode] == "" {
			work.DocumentParts.EpisodeRows = merged
			return "", true, nil
		}
	}
	return combined, false, nil
}

func productionEpisodeTable(rows map[int]string) string {
	header := "| " + strings.Join(productionEpisodeArchitectureColumns[:], " | ") + " |\n| " + strings.TrimSuffix(strings.Repeat("--- | ", productionEpisodeArchitectureColumnCount), " ")
	return header + "\n" + productionEpisodeRowsText(rows)
}

func productionEpisodeCheckpointBudget(m productionManifest, doc map[string]any, work productionParallelWork, table string) error {
	fields := map[string]string{"episodeArchitecture": table}
	for key, value := range work.DocumentParts.Fields {
		fields[key] = value
	}
	sections := productionPlanDocumentSectionsForSchema(work.Key, "", work.DocumentParts.SchemaVersion)
	if chars, limit := productionDocumentContentChars(fields)+productionDocumentHeadingChars(sections), productionArtifactContentLimit(m, doc, work.Key); chars > limit {
		return productionDocumentLengthError(chars, limit)
	}
	return nil
}
