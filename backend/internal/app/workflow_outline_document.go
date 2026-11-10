package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// The model supplies content only; headings, field order and paragraph layout
// belong to the renderer, including when independently generated ranges merge.
type outlineEpisodeDocument struct {
	Episode    int    `json:"episode"`
	Title      string `json:"title"`
	Opening    string `json:"opening"`
	Conflict   string `json:"conflict"`
	Change     string `json:"change"`
	Clues      string `json:"clues"`
	Ending     string `json:"ending"`
	Continuity string `json:"continuity"`
}

var outlineDocumentLabels = [...]string{
	"开场承接与目标", "冲突与关键行动", "结果与情绪变化",
	"伏笔与回收", "集尾与下集承接", "资产与连续性",
}

func (episode outlineEpisodeDocument) fields() []string {
	return []string{episode.Opening, episode.Conflict, episode.Change, episode.Clues, episode.Ending, episode.Continuity}
}

const outlineDocumentInstruction = `本轮仅返回一个JSON对象，不输出Markdown文稿、表格、列表或开场说明，程序会统一排版：{"episodes":[{"episode":1,"title":"本集标题","opening":"承接前集的起始状态、开场钩子与本集目标","conflict":"核心冲突、关键行动与事件因果","change":"行动结果、人物状态及情绪变化","clues":"具体伏笔的铺设、揭示或回收","ending":"集尾状态、钩子及下集承接；终集写既定收束","continuity":"本集实际人物、场景、关键道具的现有编码及必要时间、知情范围、物品交接连续性"}]}。episode使用本批真实集号并升序，不从1重新编号；title及六项内容均为非空纯文本字符串，不在字段内添加标题、项目符号或重复字段标签。每集通常约250–400字，以完整交代因果为准，不写长篇对白、场次正文、镜头表或资产档案。没有新增伏笔或资产时如实说明，不虚构内容补字段；未知资产编码不可编造。JSON只是内部传输格式，最终交付由程序生成一份统一六项结构的Markdown集纲。`

func renderStructuredOutlineRange(text string, start, end int) (string, error) {
	text = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), "\uFEFF"))
	text = outlineJSONWithoutPreamble(text)
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if char, length, language := outlineFence(lines[0]); length >= 3 && (language == "" || language == "json") {
		closing, n, tail := outlineFence(lines[len(lines)-1])
		if len(lines) < 3 || closing != char || n < length || tail != "" {
			return "", fmt.Errorf("第 %d–%d 集结构化集纲的JSON围栏未闭合，原始返回已保留", start, end)
		}
		text = strings.TrimSpace(strings.Join(lines[1:len(lines)-1], "\n"))
	}
	var document struct {
		Episodes []outlineEpisodeDocument `json:"episodes"`
	}
	if err := decodeOutlineJSON(text, &document); err != nil {
		return "", fmt.Errorf("第 %d–%d 集未返回完整的结构化集纲JSON，请按固定字段返回；原始返回已保留", start, end)
	}
	if len(document.Episodes) != end-start+1 {
		return "", fmt.Errorf("第 %d–%d 集结果不完整：结构化集纲收到 %d/%d 集，原始返回已保留", start, end, len(document.Episodes), end-start+1)
	}
	parts := make([]string, len(document.Episodes))
	for i, episode := range document.Episodes {
		if episode.Episode != start+i {
			return "", fmt.Errorf("结构化集纲集号缺失、重复、越界或乱序：期望第 %d 集，实际第 %d 集；未自动重排剧情", start+i, episode.Episode)
		}
		if strings.TrimSpace(episode.Title) == "" {
			return "", fmt.Errorf("第 %d 集缺少本集标题，原始返回已保留", episode.Episode)
		}
		fields := episode.fields()
		paragraphs := []string{fmt.Sprintf("## 第 %d 集｜%s", episode.Episode, outlinePlainText(episode.Title))}
		size := 0
		for j, field := range fields {
			if strings.TrimSpace(field) == "" {
				return "", fmt.Errorf("第 %d 集缺少“%s”，未补造剧情或标记完成；原始返回已保留", episode.Episode, outlineDocumentLabels[j])
			}
			size += utf8.RuneCountInString(strings.Join(strings.Fields(field), " "))
			paragraphs = append(paragraphs, "**"+outlineDocumentLabels[j]+"：** "+outlinePlainText(field))
		}
		if size < 40 {
			return "", fmt.Errorf("第 %d 集内容不完整，请补齐实际事件及因果，原始返回已保留", episode.Episode)
		}
		parts[i] = strings.Join(paragraphs, "\n\n")
	}
	return strings.Join(parts, "\n\n"), nil
}

func outlineJSONWithoutPreamble(text string) string {
	start := strings.IndexAny(text, "{[")
	if start <= 0 || text[start] != '{' {
		return text
	}
	prefix := strings.TrimSpace(text[:start])
	// Do not discard an earlier JSON value, container or quoted document. Only
	// introductory prose before the single object is transport formatting.
	if strings.ContainsAny(prefix, "}]\"") || json.Valid([]byte(prefix)) {
		return text
	}
	lines := strings.Split(prefix, "\n")
	opening := ""
	for i, line := range lines {
		_, length, language := outlineFence(line)
		if length < 3 {
			continue
		}
		if opening != "" || i != len(lines)-1 || (language != "" && language != "json") {
			return text
		}
		opening = strings.TrimSpace(line)
	}
	if opening != "" {
		return opening + "\n" + text[start:]
	}
	return text[start:]
}

// Only remove punctuation the JSON parser has identified as invalid. Quoted
// content, keys and values stay byte-for-byte intact; missing data is not filled.
func decodeOutlineJSON(text string, target any) error {
	for corrections := 0; ; corrections++ {
		err := json.Unmarshal([]byte(text), target)
		var syntax *json.SyntaxError
		if err == nil || corrections >= 16 || !errors.As(err, &syntax) {
			return err
		}
		corrected, ok := repairOutlineJSONPunctuation(text, int(syntax.Offset)-1)
		if !ok {
			return err
		}
		text = corrected
	}
}

func repairOutlineJSONPunctuation(text string, offset int) (string, bool) {
	if offset < 0 || offset >= len(text) {
		return "", false
	}
	var stack []byte
	quoted, escaped := false, false
	previous := -1
	for i := 0; i < offset; i++ {
		char := text[i]
		if quoted {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				quoted, previous = false, i
			}
			continue
		}
		switch char {
		case ' ', '\t', '\r', '\n':
			continue
		case '"':
			quoted = true
		case '{':
			stack = append(stack, '}')
		case '[':
			stack = append(stack, ']')
		case '}', ']':
			if len(stack) == 0 || stack[len(stack)-1] != char {
				return "", false
			}
			stack = stack[:len(stack)-1]
		}
		previous = i
	}
	if quoted || previous < 0 {
		return "", false
	}
	char := text[offset]
	expected := byte(0)
	if len(stack) > 0 {
		expected = stack[len(stack)-1]
	}
	if (char == '}' || char == ']') && char == expected && text[previous] == ',' {
		return text[:previous] + text[previous+1:], true
	}
	next := offset + 1
	for next < len(text) && strings.ContainsRune(" \t\r\n", rune(text[next])) {
		next++
	}
	if (char == '}' || char == ']') && char == text[previous] && char != expected &&
		((expected == 0 && next == len(text)) || (expected != 0 && next < len(text) && (text[next] == expected || text[next] == ','))) {
		return text[:offset] + text[offset+1:], true
	}
	return "", false
}

var outlineMarkdownEscapes = strings.NewReplacer(
	"\\", "\\\\", "&", "&amp;", "<", "&lt;", ">", "&gt;",
	"*", "\\*", "`", "\\`", "[", "\\[", "]", "\\]", "#", "\\#", "|", "\\|", "~", "\\~",
)

func outlinePlainText(value string) string {
	return outlineMarkdownEscapes.Replace(strings.Join(strings.Fields(value), " "))
}

func validateUniformOutlineRange(text string, start, end int) error {
	if err := validateOutlineRange(text, start, end); err != nil {
		return err
	}
	// Every episode has exactly one heading and six labelled paragraphs. The
	// values are single-line escaped text, so they cannot add sections or fields.
	paragraphs := strings.Split(text, "\n\n")
	if len(paragraphs) != (end-start+1)*(len(outlineDocumentLabels)+1) {
		return fmt.Errorf("集纲合并格式不一致：每集必须包含标题及六项固定内容")
	}
	for i, paragraph := range paragraphs {
		field := i % (len(outlineDocumentLabels) + 1)
		if field == 0 {
			expected := fmt.Sprintf("## 第 %d 集｜", start+i/(len(outlineDocumentLabels)+1))
			if !strings.HasPrefix(paragraph, expected) {
				return fmt.Errorf("集纲合并标题格式不一致：期望%s标题", expected)
			}
		} else if !strings.HasPrefix(paragraph, "**"+outlineDocumentLabels[field-1]+"：** ") || strings.ContainsAny(paragraph, "\r\n") {
			return fmt.Errorf("集纲合并字段格式不一致：期望“%s”单独成段", outlineDocumentLabels[field-1])
		}
	}
	return nil
}
