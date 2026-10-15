package app

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type ReasoningEffort string

var claudeThinkingVersion = regexp.MustCompile(`claude-(?:[a-z]+-)?(\d+)(?:[-.](\d+))?`)
var geminiThinkingVersion = regexp.MustCompile(`gemini-(\d+)(?:\.\d+)?-`)

func usesClaudeAdaptiveThinking(model string) bool {
	match := claudeThinkingVersion.FindStringSubmatch(strings.ToLower(model))
	if len(match) < 3 {
		return false
	}
	major, _ := strconv.Atoi(match[1])
	minor, _ := strconv.Atoi(match[2])
	return major > 4 || (major == 4 && minor >= 6)
}

func geminiReasoningConfig(model string, effort ReasoningEffort) map[string]any {
	name := strings.ToLower(model)
	match := geminiThinkingVersion.FindStringSubmatch(name)
	major := 0
	if len(match) > 1 {
		major, _ = strconv.Atoi(match[1])
	}
	if major >= 3 || name == "gemini-flash-latest" || name == "gemini-flash-lite-latest" {
		level := effort.effective()
		// Gemini 3.0 Pro only exposes low/high. Its 3.1 successor also accepts medium.
		if strings.Contains(name, "gemini-3-pro") && level == ReasoningMedium {
			level = ReasoningHigh
		}
		return map[string]any{"thinkingLevel": strings.ToUpper(string(level))}
	}
	return map[string]any{"thinkingBudget": map[ReasoningEffort]int{ReasoningLow: 1024, ReasoningMedium: 4096, ReasoningHigh: 8192}[effort.effective()]}
}

const (
	ReasoningLow    ReasoningEffort = "low"
	ReasoningMedium ReasoningEffort = "medium"
	ReasoningHigh   ReasoningEffort = "high"
)

func (effort ReasoningEffort) valid() bool {
	return effort == "" || effort == ReasoningLow || effort == ReasoningMedium || effort == ReasoningHigh
}

func (effort ReasoningEffort) effective() ReasoningEffort {
	if effort == "" {
		return ReasoningMedium
	}
	return effort
}

func (effort *ReasoningEffort) UnmarshalJSON(data []byte) error {
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	candidate := ReasoningEffort(value)
	if !candidate.valid() {
		return fmt.Errorf("推理强度必须是 low、medium 或 high")
	}
	*effort = candidate
	return nil
}

// Explicit suppression is reserved for recovery/compaction and old runs with
// reasoning disabled. An omitted preference on a new text request means medium.
func agentReasoningOptions(effort ReasoningEffort, enabled bool) map[string]any {
	return map[string]any{"stream": true, "thinking": enabled, "reasoningEffort": effort.effective(), "reasoningDisabled": !enabled}
}

func workflowChildTextOptions(base map[string]any) map[string]any {
	options := map[string]any{"stream": true, "maxOutputTokens": 8192, "reasoningEffort": string(ReasoningMedium)}
	if parent, ok := base["textOptions"].(map[string]any); ok {
		for _, key := range []string{"reasoningEffort", "reasoningDisabled"} {
			if value, exists := parent[key]; exists {
				options[key] = value
			}
		}
	}
	return options
}
