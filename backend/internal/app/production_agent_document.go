package app

import (
	"strings"
)

type productionDocumentSection struct{ Key, Title string }

func productionDocumentSections(category, key string) []productionDocumentSection {
	if category == "bible" && key == "settings" {
		return []productionDocumentSection{{"facts", "正文设定依据"}, {"design", "统一故事设定"}, {"continuity", "连续性规则"}, {"uncertainties", "冲突与设计说明"}}
	}
	if category == "bible" && key == "style" {
		return []productionDocumentSection{{"facts", "正文风格依据"}, {"design", "统一视觉风格"}, {"sound", "声音美学"}, {"prompt", "风格提示词"}, {"negativePrompt", "负面约束"}, {"continuity", "一致性规则"}, {"uncertainties", "冲突与设计说明"}}
	}
	if category == "bible" {
		section, _ := productionBibleSectionFor(key)
		fields := []productionDocumentSection{{"facts", "正文依据"}, {"design", section.Name}}
		if key == "sound" || key == "performance" {
			fields = append(fields, productionDocumentSection{"sound", "声音设计"})
		}
		if key != "story_continuity" {
			fields = append(fields, productionDocumentSection{"prompt", "制作提示词"}, productionDocumentSection{"negativePrompt", "负面约束"})
		}
		return append(fields, productionDocumentSection{"continuity", "连续性规则"}, productionDocumentSection{"uncertainties", "冲突与设计说明"})
	}
	sound := map[string]string{"characters": "角色声音", "environments": "环境声音", "props": "道具声音", "special": "标志声音"}[category]
	return []productionDocumentSection{{"facts", "身份与正文依据"}, {"design", "固定特征与制作设计"}, {"variants", "状态变体"}, {"sound", sound}, {"prompt", "生成提示词"}, {"negativePrompt", "负面约束"}, {"continuity", "跨集连续性"}, {"uncertainties", "冲突与设计说明"}}
}

func productionRenderDocument(category, key string, document map[string]string) (string, error) {
	sections := []string{}
	missing := []string{}
	for _, section := range productionDocumentSections(category, key) {
		value := strings.TrimSpace(document[section.Key])
		if value == "" {
			missing = append(missing, section.Key+"（"+section.Title+"）")
		}
		sections = append(sections, "## "+section.Title+"\n"+value)
	}
	if len(missing) > 0 {
		return "", cloudAgentFieldError("document", "missing_sections", "补齐 document 字段后重新 production_submit："+strings.Join(missing, "、")+"。没有正文依据的制作细节给出明确标注的设计建议；无变体或冲突时说明无，不要空填或要求用户先确认。")
	}
	return strings.Join(sections, "\n\n"), nil
}

// Older runs may already contain prose-only artifacts. Keep their contents,
// but return specific repair work instead of treating fact links as quality.
func productionDocumentMissing(category, key, content string) []string {
	values := map[string]string{}
	current := ""
	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(line, "## ") {
			current = strings.TrimSpace(strings.TrimPrefix(line, "## "))
		} else if current != "" {
			values[current] += strings.TrimSpace(line)
		}
	}
	missing := []string{}
	for _, section := range productionDocumentSections(category, key) {
		if values[section.Title] == "" {
			missing = append(missing, section.Key)
		}
	}
	return missing
}
