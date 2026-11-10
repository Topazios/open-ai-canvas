package app

import (
	"fmt"
	"strconv"
	"strings"
)

// Published episode cards are already the adopted spine. Keep their exact
// narrative and asset references instead of summarizing and regenerating them.
func outlineSourceContext(units []workflowTextUnit, count int) (string, []string, error) {
	sections := map[string]string{}
	for _, version := range []int{2, 3, 4} {
		for _, section := range productionPlanDocumentSectionsForSchema("story", "", version) {
			if section.Key == "episodeArchitecture" || section.Key == "coreAssets" {
				sections[section.Title] = section.Key
			}
		}
	}
	var parts []string
	for _, unit := range units {
		parts = append(parts, unit.Text)
	}
	var global []string
	rows := make([]string, count)
	section, header := "", ""
	columns, found := 0, false
	var fence byte
	fenceLength := 0
	for _, raw := range strings.Split(strings.Join(parts, "\n"), "\n") {
		line := strings.TrimSpace(raw)
		if len(line) > 0 && (line[0] == '`' || line[0] == '~') {
			length := 0
			for length < len(line) && line[length] == line[0] {
				length++
			}
			if fence == 0 && length >= 3 {
				fence, fenceLength = line[0], length
			} else if line[0] == fence && length >= fenceLength && strings.TrimSpace(line[length:]) == "" {
				fence, fenceLength = 0, 0
			}
			if section == "" {
				global = append(global, raw)
			}
			continue
		}
		if fence == 0 && (strings.HasPrefix(line, "## ") || strings.HasPrefix(line, "# ")) {
			title := strings.TrimSpace(strings.TrimRight(strings.TrimLeft(line, "#"), "#"))
			section = sections[title]
			if section == "episodeArchitecture" {
				found, header, columns = true, "", 0
			}
		}
		if section == "" {
			global = append(global, raw)
			continue
		}
		if section != "episodeArchitecture" || fence != 0 || !strings.HasPrefix(line, "|") {
			continue
		}
		cells := strings.Split(strings.Trim(line, "|"), "|")
		for i := range cells {
			cells[i] = strings.TrimSpace(cells[i])
		}
		if cells[0] == "集号" {
			header, columns = line, len(cells)
			continue
		}
		match := productionEpisodeArchitectureID.FindStringSubmatch(cells[0])
		if match == nil {
			continue
		}
		episode, err := strconv.Atoi(match[1])
		if err != nil || episode < 1 || episode > count {
			return "", nil, fmt.Errorf("总纲逐集骨架包含超出本次 1–%d 集范围的集号：%s，请核对总集数", count, cells[0])
		}
		if rows[episode-1] != "" {
			return "", nil, fmt.Errorf("总纲逐集骨架第 %d 集重复，请核对当前来源", episode)
		}
		if columns < 4 || len(cells) != columns {
			return "", nil, fmt.Errorf("总纲逐集骨架第 %d 集列数不完整，请补齐原表后重新生成集纲", episode)
		}
		for _, cell := range cells[1:4] {
			if strings.TrimSpace(cell) == "" {
				return "", nil, fmt.Errorf("总纲逐集骨架第 %d 集叙事要点为空，请补齐后重新生成集纲", episode)
			}
		}
		rows[episode-1] = header + "\n" + line
	}
	if !found {
		return strings.Join(global, "\n"), nil, nil
	}
	for i, row := range rows {
		if row == "" {
			return "", nil, fmt.Errorf("总纲逐集骨架缺少第 %d 集，请补齐来源或核对本次总集数；未重新付费规划全剧", i+1)
		}
	}
	return strings.Join(global, "\n"), rows, nil
}
