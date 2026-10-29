package app

import (
	"fmt"
	"regexp"
	"strings"
)

var productionEpisodeArchitectureID = regexp.MustCompile(`(?i)^(?:第\s*)?(?:(?:episode|ep)[-_\s]*)?0*([0-9]+)(?:\s*集)?$`)

var productionEpisodeArchitectureColumns = [...]string{
	"集号", "剧情任务", "开场承接/起始状态", "目标与主要阻力", "关键选择/行动", "因果结果/代价",
	"信息/关系/情绪变化", "人物与资产状态变化", "结束状态/本集收束", "与下一集的承接", "节奏与内容覆盖",
}

const productionEpisodeArchitectureColumnCount = len(productionEpisodeArchitectureColumns)
const productionEpisodeArchitectureFieldRuneBudget = 96

func productionEpisodeArchitectureContract() string {
	return fmt.Sprintf("每行严格为%d列，顺序为：%s。斜线连接的内容属于同一列，尤其结果与代价必须同列，信息、关系与情绪变化必须同列；同一单元格内多条内容用分号，不再使用竖线分隔。只修正报错集的列边界，保留全部剧情和未报错行，不能删除内容凑列数。", productionEpisodeArchitectureColumnCount, strings.Join(productionEpisodeArchitectureColumns[:], " | "))
}

func productionPlanDocumentRuneLimit(m productionManifest, doc map[string]any, key string) int {
	limit := productionPlanDocumentMaxRunes
	if key != "story" || m.Plan == nil || m.Plan.StoryStructureVersion == 0 {
		return limit
	}
	frame := productionNode(doc, m.FrameID)
	parameters, _ := productionWorkflow(frame)["parameters"].(map[string]any)
	episodeCount := int(numberValue(parameters["episodeCount"], 0))
	if episodeCount < 1 {
		return limit
	}
	rows := min(episodeCount, 1000)
	return limit + rows*(productionEpisodeArchitectureColumnCount-1)*productionEpisodeArchitectureFieldRuneBudget
}

// productionPlanEpisodeArchitectureIssues validates the executable outline
// skeleton for new plan documents. It checks coverage and fields, not story
// quality; the latter remains a semantic review task.
func productionPlanEpisodeArchitectureIssues(m productionManifest, doc map[string]any, content string, schemaVersion int) []string {
	if m.Plan == nil || m.Plan.StoryStructureVersion == 0 || schemaVersion < 2 {
		return nil
	}
	frame := productionNode(doc, m.FrameID)
	parameters, _ := productionWorkflow(frame)["parameters"].(map[string]any)
	episodeCount := int(numberValue(parameters["episodeCount"], 0))
	if episodeCount < 1 {
		return []string{"无法从当前方案参数读取有效总集数，逐集骨架无法校验"}
	}
	body := productionPlanSectionBody("story", "", content, "episodeArchitecture", schemaVersion)
	seen := map[int]bool{}
	issues := []string{}
	invalidColumns := false
	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || !strings.ContainsAny(line, "|｜") {
			continue
		}
		line = strings.ReplaceAll(line, "｜", "|")
		line = strings.TrimPrefix(strings.TrimSuffix(line, "|"), "|")
		cells := strings.Split(line, "|")
		for i := range cells {
			cells[i] = strings.TrimSpace(cells[i])
		}
		match := productionEpisodeArchitectureID.FindStringSubmatch(cells[0])
		if match == nil {
			continue // Column headings and Markdown separators are not episode rows.
		}
		var episode int
		if _, err := fmt.Sscanf(match[1], "%d", &episode); err != nil || episode < 1 {
			issues = append(issues, "逐集规划行包含无效集号："+cells[0])
			continue
		}
		if episode > episodeCount {
			issues = append(issues, fmt.Sprintf("逐集规划包含超出当前计划总集数的第%d集", episode))
			continue
		}
		if seen[episode] {
			issues = append(issues, fmt.Sprintf("逐集规划第%d集重复", episode))
			continue
		}
		seen[episode] = true
		if len(cells) != productionEpisodeArchitectureColumnCount {
			invalidColumns = true
			issues = append(issues, fmt.Sprintf("逐集规划第%d集应有%d列（集号及10项规划字段），当前为%d列", episode, productionEpisodeArchitectureColumnCount, len(cells)))
			continue
		}
		for index, value := range cells[1:] {
			if value == "" || productionPlanPlaceholder(value) {
				issues = append(issues, fmt.Sprintf("逐集规划第%d集第%d项内容为空或仍是占位语", episode, index+1))
			}
		}
	}
	for episode := 1; episode <= episodeCount; episode++ {
		if !seen[episode] {
			issues = append(issues, fmt.Sprintf("逐集规划缺少第%d集", episode))
		}
	}
	if len(seen) == 0 {
		issues = append([]string{"未找到逐集规划行；请按 documentSchema 提供每集一行的结构化骨架"}, issues...)
	}
	if invalidColumns {
		issues = append(issues, productionEpisodeArchitectureContract())
	}
	return uniqueProductionContinuityIssues(issues)
}

// Stable selectors let repair progress distinguish rows and cells even when
// the safe message is edited or another row in the same table also fails.
func productionEpisodeArchitectureIssueField(issue string) string {
	lower := strings.ToLower(issue)
	if strings.Contains(lower, "缺少第") || strings.Contains(lower, "超出当前计划总集数的第") || strings.Contains(lower, "重复") {
		if index := strings.Index(issue, "第"); index >= 0 {
			rest := issue[index+len("第"):]
			end := strings.Index(rest, "集")
			if end > 0 {
				return "document.episodeArchitecture.episode[" + strings.TrimSpace(rest[:end]) + "]"
			}
		}
	}
	if strings.HasPrefix(issue, "逐集规划行包含无效集号：") {
		return "document.episodeArchitecture.invalid_episode_row[" + truncateRunes(strings.TrimPrefix(issue, "逐集规划行包含无效集号："), 40) + "]"
	}
	if strings.HasPrefix(issue, "逐集规划第") {
		rest := strings.TrimPrefix(issue, "逐集规划第")
		end := strings.Index(rest, "集")
		if end > 0 {
			selector := "document.episodeArchitecture.episode[" + strings.TrimSpace(rest[:end]) + "]"
			if index := strings.Index(issue, "第"); index >= 0 && strings.Contains(issue[end+len("集"):], "项内容为空") {
				tail := issue[end+len("集"):]
				fieldIndex := strings.Index(tail, "第")
				fieldEnd := strings.Index(tail, "项")
				if fieldIndex >= 0 && fieldEnd > fieldIndex {
					selector += ".column[" + strings.TrimSpace(tail[fieldIndex+len("第"):fieldEnd]) + "]"
				}
			}
			return selector
		}
	}
	if strings.Contains(issue, "列") {
		return "document.episodeArchitecture.columns"
	}
	return "document.episodeArchitecture.structure." + productionHash(issue)[:12]
}

func productionPlanPlaceholder(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(strings.Trim(value, "。.!！?？…")))
	switch normalized {
	case "待补充", "待完善", "待确认", "待定", "同上", "略", "不适用", "无", "todo", "tbd", "n/a":
		return true
	default:
		return false
	}
}
