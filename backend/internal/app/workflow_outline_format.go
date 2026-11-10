package app

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

var outlineEpisodeTitle = regexp.MustCompile(`#{1,6}[ \t]+第[ \t]*([0-9]+)[ \t]*集([^\n]*)`)

type outlineEpisodeSection struct {
	episode int
	heading string
	lines   []string
}

func validateOutlineRange(text string, start, end int) error {
	_, err := normalizeOutlineRange(text, start, end)
	return err
}

// Repair presentation, not coverage: only explicit episode headings define
// sections. Never infer episode numbers, split combined episodes or invent text.
func normalizeOutlineRange(text string, start, end int) (string, error) {
	text = strings.TrimSpace(strings.TrimPrefix(strings.ReplaceAll(text, "\r\n", "\n"), "\uFEFF"))
	lines := strings.Split(text, "\n")
	// A single Markdown code wrapper is transport formatting. Embedded example
	// fences remain intact and their headings never count as delivered episodes.
	if char, length, language := outlineFence(lines[0]); length >= 3 && (language == "" || language == "md" || language == "markdown" || language == "text") {
		for i := 1; i < len(lines); i++ {
			closing, n, tail := outlineFence(lines[i])
			if closing == char && n >= length && tail == "" {
				if i == len(lines)-1 {
					lines = lines[1:i]
				}
				break
			}
		}
	}
	var sections []outlineEpisodeSection
	var fence byte
	fenceLength := 0
	for _, line := range lines {
		char, length, tail := outlineFence(line)
		if length >= 3 && (fence == 0 || (char == fence && length >= fenceLength && tail == "")) {
			if fence == 0 {
				fence, fenceLength = char, length
			} else {
				fence, fenceLength = 0, 0
			}
			if len(sections) > 0 {
				sections[len(sections)-1].lines = append(sections[len(sections)-1].lines, line)
			}
			continue
		}
		if fence == 0 {
			match := outlineEpisodeTitle.FindStringSubmatchIndex(line)
			if match != nil && (match[0] == 0 || line[match[0]-1] != '#') &&
				(strings.TrimSpace(line[:match[0]]) == "" || len(sections) == 0) {
				number, err := strconv.Atoi(line[match[2]:match[3]])
				if err != nil {
					return "", fmt.Errorf("集纲输出包含无效集号：%s", line[match[2]:match[3]])
				}
				sections = append(sections, outlineEpisodeSection{episode: number, heading: fmt.Sprintf("## 第 %d 集%s", number, strings.TrimRight(line[match[4]:match[5]], " \t"))})
				continue
			}
		}
		if len(sections) > 0 {
			sections[len(sections)-1].lines = append(sections[len(sections)-1].lines, line)
		}
	}
	if fence != 0 {
		return "", fmt.Errorf("第 %d–%d 集集纲输出的代码围栏未闭合，无法核对集号；原始返回已保留", start, end)
	}
	seen := map[int]int{}
	for _, section := range sections {
		seen[section.episode]++
	}
	var issues []string
	for episode := start; episode <= end; episode++ {
		if seen[episode] == 0 {
			issues = append(issues, fmt.Sprintf("缺少第 %d 集", episode))
		}
	}
	for _, section := range sections {
		if section.episode < start || section.episode > end {
			issues = append(issues, fmt.Sprintf("第 %d 集超出本批范围", section.episode))
		} else if seen[section.episode] > 1 {
			issues = append(issues, fmt.Sprintf("第 %d 集重复", section.episode))
			seen[section.episode] = 1
		}
	}
	if len(issues) > 0 || len(sections) != end-start+1 {
		return "", fmt.Errorf("第 %d–%d 集结果不完整（集纲输出校验）：%s；识别到 %d/%d 个分集标题，原始返回已保留", start, end, strings.Join(issues, "；"), len(sections), end-start+1)
	}
	parts := make([]string, len(sections))
	for i, section := range sections {
		if section.episode != start+i {
			return "", fmt.Errorf("集纲输出集号乱序：期望第 %d 集，实际第 %d 集；未自动重排剧情", start+i, section.episode)
		}
		body := strings.TrimSpace(strings.Join(section.lines, "\n"))
		if utf8.RuneCountInString(body) < 40 {
			return "", fmt.Errorf("第 %d 集只有标题或内容不完整（集纲输出），未标记完成", section.episode)
		}
		parts[i] = section.heading + "\n" + body
	}
	return strings.Join(parts, "\n\n"), nil
}

func outlineFence(line string) (byte, int, string) {
	line = strings.TrimSpace(line)
	if len(line) == 0 || (line[0] != '`' && line[0] != '~') {
		return 0, 0, ""
	}
	n := 0
	for n < len(line) && line[n] == line[0] {
		n++
	}
	return line[0], n, strings.TrimSpace(line[n:])
}
