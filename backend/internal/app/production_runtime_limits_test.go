package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProductionArgumentLimitsAreConsistentAndScoped(t *testing.T) {
	call := cloudAgentCall{ID: "large-document"}
	call.Function.Name = "production_submit"
	encoded, _ := json.Marshal(map[string]any{"document": map[string]string{"plot": strings.Repeat("剧情", 6000)}})
	call.Function.Arguments = string(encoded)
	if err := validateCloudAgentCalls([]cloudAgentCall{call}, true); err != nil {
		t.Fatal(err)
	}
	if err := validateCloudAgentCalls([]cloudAgentCall{call}); err == nil {
		t.Fatal("ordinary agent limit was relaxed")
	}
	call.Function.Name = "canvas_apply_ops"
	if err := validateCloudAgentCalls([]cloudAgentCall{call}, true); err == nil {
		t.Fatal("unrelated tool limit was relaxed")
	}
	call.Function.Name = "production_submit"
	call.Function.Arguments = `{"value":"` + strings.Repeat("x", productionToolArgumentsMaxBytes) + `"}`
	if err := validateCloudAgentCalls([]cloudAgentCall{call}, true); err == nil {
		t.Fatal("unbounded tool arguments accepted")
	}
}

func TestProductionLargeJournalKeepsReceiptAndFullModelResult(t *testing.T) {
	state := &cloudAgentRuntime{}
	state.Request.Production = &ProductionAgentRequest{TargetNodeID: "target"}
	call := cloudAgentCall{ID: "large-read"}
	call.Function.Name = "production_read"
	call.Function.Arguments = `{"pageId":"episode-1","content":"` + strings.Repeat("x", 10000) + `"}`
	content := strings.Repeat("正文", 30000)
	result := map[string]any{"text": content, "pageId": "episode-1", "factsReady": false}
	cloudAgentToolResult("run", state, call, result, nil)
	encoded, _ := json.Marshal(state.Events[0].Payload)
	if len(encoded) > 8192 || strings.Contains(string(encoded), content) {
		t.Fatal("journal duplicates large document")
	}
	if !strings.Contains(string(encoded), "episode-1") {
		t.Fatal("journal lost source receipt")
	}
	var modelResult map[string]any
	if err := json.Unmarshal([]byte(stringValue(state.Canonical.Messages[0]["content"])), &modelResult); err != nil || modelResult["text"] != content {
		t.Fatal("model/tool response was truncated", err)
	}
}
