package app

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/model"
)

var productionEpisodeFields = [...]string{
	"episode", "task", "openingState", "goalAndObstacle", "action", "outcomeAndCost",
	"informationRelationshipEmotion", "characterAssetState", "endingState", "nextConnection", "pacingAndCoverage",
}

func productionEpisodeSubmissionSchema(batch *productionDocumentEpisodeRange) map[string]any {
	properties := map[string]any{"episode": map[string]any{"type": "integer", "minimum": batch.Start, "maximum": batch.End}}
	for i, key := range productionEpisodeFields[1:] {
		properties[key] = map[string]any{"type": "string", "minLength": 1, "description": productionEpisodeArchitectureColumns[i+1] + "。本集具体行动与变化；多个要点用分号连接，不拆成额外字段。"}
	}
	return map[string]any{
		"type": "array", "minItems": batch.End - batch.Start + 1, "maxItems": batch.End - batch.Start + 1,
		"description": fmt.Sprintf("本批仅生成第 %d 至 %d 集，每集一个对象，必须逐字段填写。不要输出 Markdown 表格或竖线分列字符串；服务端按字段排版，保留全部内容。", batch.Start, batch.End),
		"items":       map[string]any{"type": "object", "properties": properties, "required": productionEpisodeFields[:], "additionalProperties": false},
	}
}

func productionEpisodeTableCell(value string) string {
	return strings.NewReplacer("|", "&#124;", "｜", "&#65372;", "\r\n", "<br>", "\n", "<br>", "\r", "<br>").Replace(strings.TrimSpace(value))
}

func productionEpisodeRowsText(rows map[int]string) string {
	keys := make([]int, 0, len(rows))
	for episode := range rows {
		keys = append(keys, episode)
	}
	sort.Ints(keys)
	lines := make([]string, 0, len(keys))
	for _, episode := range keys {
		lines = append(lines, rows[episode])
	}
	return strings.Join(lines, "\n")
}

// Field names remove semantic ambiguity from positional tables. Legacy strings
// remain readable for already queued responses; extra columns are never guessed.
func productionReadEpisodeRows(raw json.RawMessage, batch productionDocumentEpisodeRange) (map[int]string, error) {
	rows, seen := map[int]string{}, map[int]bool{}
	var failures []error
	var entries []map[string]json.RawMessage
	trimmed := strings.TrimSpace(string(raw))
	if strings.HasPrefix(trimmed, "[") {
		if err := json.Unmarshal(raw, &entries); err != nil {
			return rows, cloudAgentFieldError("document.episodeArchitecture", "episode_type", "逐集规划必须是对象数组，每集按本轮字段填写")
		}
		for index, entry := range entries {
			var episode int
			if json.Unmarshal(entry["episode"], &episode) != nil || episode < batch.Start || episode > batch.End {
				failures = append(failures, cloudAgentFieldError(fmt.Sprintf("document.episodeArchitecture[%d].episode", index), "episode_range", fmt.Sprintf("集号必须是 %d 至 %d 范围内的整数", batch.Start, batch.End)))
				continue
			}
			path := fmt.Sprintf("document.episodeArchitecture.episode[%d]", episode)
			if seen[episode] {
				delete(rows, episode)
				failures = append(failures, cloudAgentFieldError(path, "episode_duplicate", fmt.Sprintf("第 %d 集重复提交，无法判定采用哪条", episode)))
				continue
			}
			seen[episode] = true
			cells := []string{fmt.Sprintf("EP-%03d", episode)}
			valid := true
			keys := make([]string, 0, len(entry))
			for key := range entry {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				if !cloudAgentContainsString(productionEpisodeFields[:], key) {
					valid = false
					failures = append(failures, cloudAgentFieldError(path+"."+key, "episode_unknown_field", "逐集对象包含未声明字段："+key+"；将内容放入对应命名字段，不删除剧情"))
				}
			}
			for i, key := range productionEpisodeFields[1:] {
				var value string
				if json.Unmarshal(entry[key], &value) != nil || strings.TrimSpace(value) == "" || productionPlanPlaceholder(value) {
					valid = false
					failures = append(failures, cloudAgentFieldError(path+"."+key, "episode_required", fmt.Sprintf("第 %d 集缺少有效的%s（%s），须填写具体内容", episode, productionEpisodeArchitectureColumns[i+1], key)))
				}
				cells = append(cells, productionEpisodeTableCell(value))
			}
			if valid {
				rows[episode] = "| " + strings.Join(cells, " | ") + " |"
			}
		}
	} else {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return rows, cloudAgentFieldError("document.episodeArchitecture", "episode_type", "逐集规划必须按本轮工具模板提交对象数组")
		}
		for _, rawLine := range strings.Split(text, "\n") {
			line := strings.TrimSpace(rawLine)
			if line == "" {
				continue
			}
			cells := strings.Split(strings.Trim(strings.ReplaceAll(line, "｜", "|"), "|"), "|")
			match := productionEpisodeArchitectureID.FindStringSubmatch(strings.TrimSpace(cells[0]))
			if match == nil {
				if strings.HasPrefix(line, "|") && (strings.Contains(line, "集号") || strings.Contains(line, "---")) {
					continue
				}
				failures = append(failures, cloudAgentFieldError("document.episodeArchitecture", "episode_row", "本批仅提交指定集数的逐集规划，不添加其他说明"))
				continue
			}
			episode, _ := strconv.Atoi(match[1])
			path := fmt.Sprintf("document.episodeArchitecture.episode[%d]", episode)
			if episode < batch.Start || episode > batch.End || seen[episode] {
				delete(rows, episode)
				failures = append(failures, cloudAgentFieldError(path, "episode_range", fmt.Sprintf("本批只接收第 %d 至 %d 集，每集一条且不得重复", batch.Start, batch.End)))
				continue
			}
			seen[episode] = true
			if len(cells) != productionEpisodeArchitectureColumnCount {
				failures = append(failures, cloudAgentFieldError(path, "episode_columns", fmt.Sprintf("第 %d 集实际 %d 列，需要 %d 列。请改按命名字段提交该集，结果与代价合在 outcomeAndCost，信息/关系/情绪合在 informationRelationshipEmotion；服务端排版，不删除剧情凑列数。", episode, len(cells), productionEpisodeArchitectureColumnCount)))
				continue
			}
			valid := true
			for i, cell := range cells[1:] {
				if strings.TrimSpace(cell) == "" || productionPlanPlaceholder(cell) {
					valid = false
					failures = append(failures, cloudAgentFieldError(path+"."+productionEpisodeFields[i+1], "episode_required", fmt.Sprintf("第 %d 集的%s为空或占位，需补齐具体内容", episode, productionEpisodeArchitectureColumns[i+1])))
				}
			}
			if valid {
				rows[episode] = line
			}
		}
	}
	for episode := batch.Start; episode <= batch.End; episode++ {
		if !seen[episode] {
			failures = append(failures, cloudAgentFieldError(fmt.Sprintf("document.episodeArchitecture.episode[%d]", episode), "episode_missing", fmt.Sprintf("本批缺少第 %d 集", episode)))
		}
	}
	return rows, cloudAgentValidationErrors(failures...)
}

// Only episode content errors allow sibling rows into the private checkpoint.
// Envelope, source, target and storage failures never authorize partial writes.
func productionPrepareEpisodeRepair(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, work *productionParallelWork, task *model.Task, failure error) bool {
	batch := productionDocumentEpisodeBatch(m, doc, *work)
	if batch == nil || productionDocumentPartsVersion(m, doc, artifacts, *work) != nil {
		return false
	}
	issues := cloudAgentValidationIssues(failure)
	if len(issues) == 0 {
		return false
	}
	for _, issue := range issues {
		if !strings.HasPrefix(issue.Field, "document.episodeArchitecture") || !strings.HasPrefix(issue.Issue, "episode_") {
			return false
		}
	}
	var result struct {
		ToolCalls []cloudAgentCall `json:"toolCalls"`
	}
	if task == nil || json.Unmarshal([]byte(task.ResultJSON), &result) != nil || len(result.ToolCalls) != 1 || result.ToolCalls[0].Function.Name != "production_submit" || len(result.ToolCalls[0].Function.Arguments) > productionToolArgumentsMaxBytes {
		return false
	}
	call, err := productionBindDocumentCall(*work, result.ToolCalls[0])
	if err != nil || productionParallelCallError(*work, call, "production_submit") != nil {
		return false
	}
	var args struct {
		Key          string                     `json:"key"`
		Name         string                     `json:"name"`
		ExpectedHash string                     `json:"expectedHash"`
		FactIDs      []string                   `json:"factIds"`
		Document     map[string]json.RawMessage `json:"document"`
	}
	if decodeCloudAgentJSONObject(call.Function.Arguments, &args) != nil || len(args.FactIDs) != 0 || args.ExpectedHash != work.DocumentParts.ExpectedHash || len(args.Document) != 1 {
		return false
	}
	raw, exists := args.Document["episodeArchitecture"]
	if !exists {
		return false
	}
	rows, _ := productionReadEpisodeRows(raw, *batch)
	merged := map[int]string{}
	for episode, row := range work.DocumentParts.EpisodeRows {
		merged[episode] = row
	}
	// A rejected extra row must not turn a wholly valid range into a completed
	// checkpoint without an accepted batch receipt.
	if len(rows) < batch.End-batch.Start+1 {
		for episode, row := range rows {
			merged[episode] = row
		}
	}
	if productionEpisodeCheckpointBudget(m, doc, *work, productionEpisodeTable(merged)) != nil {
		return false
	}
	work.DocumentParts.EpisodeRows = merged
	work.RepairDocument, work.RepairDocumentRaw = nil, nil
	delete(work.DocumentParts.RepairFields, "episodeArchitecture")
	// Keep the original rejected payload as data; the next scope filters it to
	// the missing range, so the model cannot copy accepted siblings back again.
	work.EpisodeRepairDraft = append(json.RawMessage(nil), raw...)
	return true
}

func productionEpisodeScopedDraft(work productionParallelWork, batch productionDocumentEpisodeRange) json.RawMessage {
	raw := work.EpisodeRepairDraft
	if len(raw) == 0 {
		if value := work.RepairDocument["episodeArchitecture"]; value != "" {
			raw, _ = json.Marshal(value)
		} else {
			raw = work.RepairDocumentRaw["episodeArchitecture"]
		}
		if len(raw) == 0 && work.DocumentParts != nil {
			if value := work.DocumentParts.RepairFields["episodeArchitecture"]; value != "" {
				raw, _ = json.Marshal(value)
			}
		}
	}
	var entries []map[string]json.RawMessage
	if json.Unmarshal(raw, &entries) == nil {
		selected := []map[string]json.RawMessage{}
		for _, entry := range entries {
			var episode int
			if json.Unmarshal(entry["episode"], &episode) == nil && episode >= batch.Start && episode <= batch.End {
				selected = append(selected, entry)
			}
		}
		if len(selected) > 0 {
			encoded, _ := json.Marshal(selected)
			return encoded
		}
		return nil
	}
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return nil
	}
	lines := []string{}
	for _, line := range strings.Split(text, "\n") {
		cells := strings.Split(strings.Trim(strings.ReplaceAll(strings.TrimSpace(line), "｜", "|"), "|"), "|")
		match := productionEpisodeArchitectureID.FindStringSubmatch(strings.TrimSpace(cells[0]))
		if match == nil {
			continue
		}
		episode, _ := strconv.Atoi(match[1])
		if episode >= batch.Start && episode <= batch.End {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return nil
	}
	encoded, _ := json.Marshal(strings.Join(lines, "\n"))
	return encoded
}
