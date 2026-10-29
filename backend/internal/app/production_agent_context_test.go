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

func TestProductionPlanContextRetainsLatestFailureUntilSaved(t *testing.T) {
	work := map[string]any{"nextAction": map[string]any{"key": "story", "tool": "production_submit"}}
	messages := []map[string]any{{"role": "user", "content": "OLD_HISTORY"}}
	messages = append(messages, productionContextTool("production_submit", "old", `{"error":"OLD_ERROR"}`)...)
	messages = append(messages, productionContextTool("production_submit", "latest", `{"error":"CURRENT_RELATIONSHIP_ERROR","field":"document.relationships"}`)...)
	result := productionCheckpointMessages(messages, "write plan", work, "policy")
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), "OLD_HISTORY") || strings.Contains(string(encoded), "OLD_ERROR") || !strings.Contains(string(encoded), "CURRENT_RELATIONSHIP_ERROR") || len(result) != 4 {
		t.Fatal("latest failure lost or historical failures accumulated", string(encoded))
	}
	canonical := canonicalAgentRequest{Messages: result, Tools: productionAgentTools(), ToolChoice: "auto", SystemPrompt: "policy"}
	if _, err := expandCanonicalAgentRequest(&canonical, providerConfig{}, false); err != nil {
		t.Fatal("retained failure broke tool call/result pairing", err)
	}
	messages = append(messages, productionContextTool("production_submit", "saved", `{"nodeId":"saved-node"}`)...)
	result = productionCheckpointMessages(messages, "write plan", work, "policy")
	encoded, _ = json.Marshal(result)
	if len(result) != 2 || strings.Contains(string(encoded), "CURRENT_RELATIONSHIP_ERROR") {
		t.Fatal("successful save retained obsolete errors", string(encoded))
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

func TestProductionPlanContextKeepsWriteFailureAcrossSuccessfulReads(t *testing.T) {
	work := map[string]any{"nextAction": map[string]any{"tool": "production_plan_inventory"}}
	messages := productionContextTool("production_plan_inventory", "rejected", `{"error":"REGISTERED_IDENTITY_CHANGED","field":"assets.name"}`)
	messages = append(messages, productionContextTool("production_status", "status", `{"nextAction":{"tool":"production_plan_inventory"}}`)...)
	messages = append(messages, productionContextTool("production_query", "query", `{"facts":[]}`)...)
	result := productionCheckpointMessages(messages, "register assets", work, "policy")
	encoded, _ := json.Marshal(result)
	if len(result) != 4 || !strings.Contains(string(encoded), "REGISTERED_IDENTITY_CHANGED") || strings.Contains(string(encoded), `"tool_call_id":"status"`) {
		t.Fatal("successful discovery erased the actionable write error", string(encoded))
	}
	canonical := canonicalAgentRequest{Messages: result, Tools: productionAgentTools(), ToolChoice: "auto", SystemPrompt: "policy"}
	if _, err := expandCanonicalAgentRequest(&canonical, providerConfig{}, false); err != nil {
		t.Fatal("retained failure broke tool pairing", err)
	}
	messages = append(messages, productionContextTool("production_plan_inventory", "saved", `{"registeredAssets":[]}`)...)
	messages = append(messages, productionContextTool("production_status", "after", `{"nextAction":{"tool":"production_submit"}}`)...)
	encoded, _ = json.Marshal(productionCheckpointMessages(messages, "continue", work, "policy"))
	if strings.Contains(string(encoded), "REGISTERED_IDENTITY_CHANGED") {
		t.Fatal("saved progress retained an obsolete error", string(encoded))
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
			if request.ToolChoice != "auto" {
				t.Fatal("checkpoint must support automatic tool selection for reasoning models")
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

func TestPlanProviderToolsFollowEveryDurablePhase(t *testing.T) {
	for _, tc := range []struct{ phase, tool, key string }{
		{"input", "production_read", ""},
		{"story", "production_submit", "story"},
		{"inventory", "production_plan_inventory", ""},
		{"standards", "production_submit", "visual"},
		{"standards", "production_submit", "direction"},
		{"generation", "production_submit", "generation"},
		{"assets", "production_submit", "asset"},
		{"validation", "production_check", ""},
	} {
		t.Run(tc.phase+tc.key, func(t *testing.T) {
			work := map[string]any{"nextAction": map[string]any{"phase": tc.phase, "tool": tc.tool, "key": tc.key}}
			manifest := productionManifest{Plan: &productionPlan{Version: 4}}
			durable := productionRuntimeTools(manifest, work)
			canonical := canonicalAgentRequest{Tools: durable, ToolChoice: "auto"}
			if required := productionConstrainPlan(work, &canonical); required != tc.tool || canonical.ToolChoice != "auto" {
				t.Fatalf("phase permits non-action: %s %+v", required, canonical)
			}
			productionRuntimeAssertTools(t, canonical.Tools, []string{tc.tool})
			if productionRuntimeUnknownCall(durable, []cloudAgentCall{productionRuntimeCall("production_status")}) {
				t.Fatal("narrowing provider tools invalidated an authorized receipt")
			}
			if tc.tool == "production_submit" {
				fn := canonical.Tools[0]["function"].(map[string]any)
				fields := fn["parameters"].(map[string]any)["properties"].(map[string]any)["document"].(map[string]any)["properties"].(map[string]any)
				for key, field := range fields {
					if !strings.Contains(field.(map[string]any)["description"].(string), "不得包含一级或二级") {
						t.Fatal("format validation absent from field contract", key)
					}
				}
			}
		})
	}
}

func TestPlanContextDoesNotReintroducePreviousPhaseFailure(t *testing.T) {
	for _, next := range []map[string]any{
		{"phase": "inventory", "tool": "production_plan_inventory"},
		{"phase": "standards", "tool": "production_submit", "key": "visual"},
	} {
		messages := productionContextTool("production_submit", "old-story", `{"error":"OBSOLETE_STORY_ERROR"}`)
		messages[0]["tool_calls"].([]any)[0].(map[string]any)["function"].(map[string]any)["arguments"] = `{"key":"story"}`
		messages = append(messages, productionContextTool("production_status", "status", `{"nextAction":{}}`)...)
		out := productionCheckpointMessages(messages, "continue", map[string]any{"nextAction": next}, "policy")
		if len(out) != 2 {
			t.Fatalf("obsolete write leaked across phase: %+v", out)
		}
	}
	work := map[string]any{"nextAction": map[string]any{"phase": "story", "tool": "production_submit", "key": "story"}}
	messages := productionContextTool("production_submit", "current", `{"error":"CURRENT_ERROR"}`)
	messages[0]["tool_calls"].([]any)[0].(map[string]any)["function"].(map[string]any)["arguments"] = `{"key":"story"}`
	if out := productionCheckpointMessages(messages, "continue", work, "policy"); len(out) != 4 {
		t.Fatal("current phase lost actionable failure", out)
	}
}
