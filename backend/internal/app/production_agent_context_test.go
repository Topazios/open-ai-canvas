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

func TestStoryboardProviderToolsFollowCheckpointWithoutInvalidatingRestoredCalls(t *testing.T) {
	manifest := productionManifest{Storyboard: &productionStoryboard{}}
	for _, tc := range []struct {
		phase, next string
		names       []string
	}{
		{"brief", "production_storyboard_brief", []string{"production_storyboard_brief"}},
		{"plan", "production_storyboard_plan", []string{"production_storyboard_plan"}},
		{"layout", "production_storyboard_layout", []string{"production_storyboard_layout"}},
		{"expand", "production_storyboard_expand", []string{"production_storyboard_expand"}},
		{"scene", "production_storyboard_submit", []string{"production_storyboard_submit", "production_storyboard_read", "production_storyboard_reset"}},
		{"review", "production_storyboard_review", []string{"production_storyboard_review", "production_storyboard_read"}},
	} {
		t.Run(tc.phase, func(t *testing.T) {
			work := map[string]any{"phase": tc.phase, "nextTool": tc.next}
			durable := productionRuntimeTools(manifest, work)
			request := canonicalAgentRequest{Tools: durable, ToolChoice: "auto"}
			productionConstrainStoryboard(work, &request)
			productionRuntimeAssertTools(t, request.Tools, tc.names)
			if request.ToolChoice != "required" {
				t.Fatal("checkpoint must require work instead of an introductory response")
			}
			call := cloudAgentCall{}
			call.Function.Name = "production_storyboard_context"
			if productionRuntimeUnknownCall(durable, []cloudAgentCall{call}) {
				t.Fatal("a previously authorized in-flight status read cannot be invalidated")
			}
			productionRuntimeAssertTools(t, durable, productionRuntimeStoryboardNames)
		})
	}
}
