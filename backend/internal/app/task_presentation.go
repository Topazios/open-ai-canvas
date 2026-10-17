package app

import (
	"encoding/json"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/model"
)

func missingTaskPresentationParents(tasks []model.Task) []string {
	seen := make(map[string]bool, len(tasks))
	for _, task := range tasks {
		seen[task.ID] = true
	}
	var ids []string
	for _, task := range tasks {
		context := taskClientContext(task.InputJSON)
		if context != nil && context.ParentTaskID != "" && !seen[context.ParentTaskID] {
			ids = append(ids, context.ParentTaskID)
			seen[context.ParentTaskID] = true
		}
	}
	return ids
}

// Project only a bounded source title; never expose unit text or model inputs.
func workflowBatchSourceLabel(raw, key string) string {
	if !strings.HasPrefix(key, "map-") {
		return ""
	}
	index, err := strconv.Atoi(strings.TrimPrefix(key, "map-"))
	if err != nil || index < 0 {
		return ""
	}
	var input struct {
		Batch struct {
			Units []struct {
				Label string `json:"label"`
			} `json:"units"`
		} `json:"workflowBatch"`
	}
	if json.Unmarshal([]byte(raw), &input) != nil || index >= len(input.Batch.Units) {
		return ""
	}
	return truncateRunes(strings.TrimSpace(input.Batch.Units[index].Label), 160)
}
