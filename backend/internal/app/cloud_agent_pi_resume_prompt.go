package app

import (
	"encoding/json"
	"strings"
)

const cloudAgentPiContinuePrompt = "沿用本会话已有的上下文与工具结果继续当前作业，只处理尚未完成的部分，不重复已经完成的操作。"

// cloudAgentPiResumePrompt 选择恢复会话时追加的 user 消息。
// 显式恢复提示词优先；没有时，如果原始任务提示词已经在会话里，就不再原样追加一遍，
// 否则每次恢复都会在会话尾部堆叠一条相同的 user 消息。
func cloudAgentPiResumePrompt(resumePrompt, originalPrompt, sessionJSONL string) string {
	if strings.TrimSpace(resumePrompt) != "" {
		return resumePrompt
	}
	if strings.TrimSpace(originalPrompt) == "" {
		return cloudAgentPiContinuePrompt
	}
	if cloudAgentPiSessionHasUserPrompt(sessionJSONL, originalPrompt) {
		return cloudAgentPiContinuePrompt
	}
	return originalPrompt
}

func cloudAgentPiSessionHasUserPrompt(sessionJSONL, prompt string) bool {
	want := strings.TrimSpace(prompt)
	for _, line := range strings.Split(sessionJSONL, "\n") {
		line = strings.TrimSpace(line)
		// 先用子串快速排除，避免对每一行都做 JSON 解析。
		if line == "" || !strings.Contains(line, `"user"`) {
			continue
		}
		var entry struct {
			Type    string `json:"type"`
			Message struct {
				Role    string          `json:"role"`
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(line), &entry) != nil || entry.Type != "message" || entry.Message.Role != "user" {
			continue
		}
		if strings.TrimSpace(cloudAgentPiMessageText(entry.Message.Content)) == want {
			return true
		}
	}
	return false
}

func cloudAgentPiMessageText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) != nil {
		return ""
	}
	var out strings.Builder
	for _, part := range parts {
		if part.Type == "text" {
			out.WriteString(part.Text)
		}
	}
	return out.String()
}
