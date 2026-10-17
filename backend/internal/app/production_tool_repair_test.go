package app

import (
	"fmt"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestProductionToolRepairTracksIdenticalFailuresInsteadOfTotalErrors(t *testing.T) {
	state := &cloudAgentRuntime{}
	state.Request.Production = &ProductionAgentRequest{TargetNodeID: "target"}
	run := &model.CloudAgentExecution{ID: "run", Status: "running"}
	call := cloudAgentCall{ID: "invalid"}
	call.Function.Name = "production_submit"
	err := cloudAgentFieldError("document", "missing_sections", "声音字段未完整")
	for i := 0; i < 10; i++ {
		call.Function.Arguments = fmt.Sprintf(`{"key":"character-%d","document":{"sound":"修订%d"}}`, i/2, i)
		cloudAgentRecordToolResult(run, state, call, nil, err)
		if run.Status != "running" || state.ToolRepairs[call.Function.Name].Attempt != 1 {
			t.Fatal("different documents/corrections shared a cap", run, state.ToolRepairs)
		}
	}
	// A successful intervening production write also permits re-evaluation.
	state.ProductionProgressStep++
	cloudAgentRecordToolResult(run, state, call, nil, err)
	if state.ToolRepairs[call.Function.Name].Attempt != 1 {
		t.Fatal("progress did not reset identical error")
	}
	// Reformatting JSON is not a correction and cannot hide a repeated failure.
	call.Function.Arguments = ` { "document": {"sound":"修订9"}, "key":"character-4" } `
	for i := 1; i < cloudAgentToolAttemptLimit; i++ {
		cloudAgentRecordToolResult(run, state, call, nil, err)
	}
	if run.Status != "failed" || !strings.Contains(run.FailureMessage, "相同工具参数") || strings.Contains(run.FailureMessage, "额度") {
		t.Fatal(run)
	}
}

func TestProductionToolRepairSeparatesDifferentValidationErrors(t *testing.T) {
	state := &cloudAgentRuntime{}
	state.Request.Production = &ProductionAgentRequest{TargetNodeID: "target"}
	run := &model.CloudAgentExecution{ID: "run", Status: "running"}
	call := cloudAgentCall{ID: "invalid"}
	call.Function.Name, call.Function.Arguments = "production_submit", `{"key":"hero"}`
	for _, field := range []string{"voiceAccent", "voiceRange", "voicePrompt", "relationships"} {
		cloudAgentRecordToolResult(run, state, call, nil, cloudAgentFieldError("document."+field, "required", "请补齐："+field))
		if run.Status != "running" || state.ToolRepairs[call.Function.Name].Attempt != 1 {
			t.Fatal(run, state.ToolRepairs)
		}
	}
}
