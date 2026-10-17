package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func productionContextTool(name, id, result string) []map[string]any {
	return []map[string]any{{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{"id": id, "function": map[string]any{"name": name, "arguments": "{}"}}}}, {"role": "tool", "tool_call_id": id, "content": result}}
}
func TestProductionContextDropsCompletedBodiesKeepsRulesAndToolPairs(t *testing.T) {
	messages := []map[string]any{{"role": "system", "content": "system policy"}, {"role": "user", "content": "run"}}
	messages = append(messages, productionContextTool("production_read", "r", `{"pageId":"rule","step":"assets.style","text":"keep hard rules"}`)...)
	messages = append(messages, productionContextTool("production_read", "b", `{"pageId":"body","step":"story.body","text":"OLD_BODY"}`)...)
	messages = append(messages, productionContextTool("production_facts", "f", `{"saved":true}`)...)
	messages = append(messages, productionContextTool("production_query", "q", `{"facts":["CURRENT_FACT"]}`)...)
	result := productionCheckpointMessages(messages, "run", nil, "system policy")
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), "OLD_BODY") || !strings.Contains(string(encoded), "keep hard rules") || !strings.Contains(string(encoded), "CURRENT_FACT") || result[0]["role"] != "system" {
		t.Fatal(string(encoded))
	}
	canonical := canonicalAgentRequest{Messages: result, Tools: productionAgentTools(), ToolChoice: "auto", SystemPrompt: "system policy"}
	if _, err := expandCanonicalAgentRequest(&canonical, providerConfig{}, false); err != nil {
		t.Fatal(err)
	}
}
func TestProductionStoryboardContextRetainsOnlyCurrentToolGroup(t *testing.T) {
	messages := []map[string]any{{"role": "system", "content": "system policy"}, {"role": "user", "content": "OLD_BODY"}}
	messages = append(messages, productionContextTool("production_storyboard_read", "read", `{"text":"needed source"}`)...)
	result := productionCheckpointMessages(messages, "run", map[string]any{"phase": "review"}, "current storyboard policy")
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), "OLD_BODY") || !strings.Contains(string(encoded), "needed source") || result[0]["role"] != "system" {
		t.Fatal(string(encoded))
	}
	if result[0]["content"] != "current storyboard policy" || strings.Contains(string(encoded), "system policy") {
		t.Fatal("stale runtime policy retained", string(encoded))
	}
}

func TestProductionContextKeepsPlanIndexWithoutAccumulatingDesignBodies(t *testing.T) {
	messages := []map[string]any{{"role": "user", "content": "run"}}
	messages = append(messages, productionContextTool("production_read", "plan", `{"pageId":"character-plan","step":"story.plan","planAsset":{"key":"C001","name":"林岚","kind":"character","episodes":[1]},"text":"LONG_CHARACTER_DESIGN"}`)...)
	messages = append(messages, productionContextTool("production_facts", "facts", `{"saved":true}`)...)
	messages = append(messages, productionContextTool("production_query", "current", `{"facts":["CURRENT_FACT"]}`)...)
	result := productionCheckpointMessages(messages, "run", nil, "policy")
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), "LONG_CHARACTER_DESIGN") || !strings.Contains(string(encoded), "character-plan") || !strings.Contains(string(encoded), "C001") || !strings.Contains(string(encoded), "CURRENT_FACT") {
		t.Fatal(string(encoded))
	}
}
