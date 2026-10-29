package app

import (
	"fmt"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestProductionToolRepairTracksValidationFailuresWithinTheCurrentStep(t *testing.T) {
	state := &cloudAgentRuntime{}
	state.Request.Production = &ProductionAgentRequest{TargetNodeID: "target"}
	run := &model.CloudAgentExecution{ID: "run", Status: "running"}
	call := cloudAgentCall{ID: "invalid"}
	call.Function.Name = "production_submit"
	err := cloudAgentFieldError("document", "missing_sections", "声音字段未完整")
	for i := 0; i < cloudAgentToolAttemptLimit-1; i++ {
		call.ID = fmt.Sprintf("invalid-%d", i)
		call.Function.Arguments = fmt.Sprintf(`{"key":"character","document":{"sound":"修订%d"}}`, i)
		cloudAgentRecordToolResult(run, state, call, nil, err)
		if run.Status != "running" || state.ToolRepairs[call.Function.Name].Attempt != i+1 {
			t.Fatal("current-step validation attempt was not accumulated", run, state.ToolRepairs)
		}
	}
	// A successful production write advances the durable phase checkpoint.
	state.ProductionProgressStep++
	call.ID = "next-step"
	cloudAgentRecordToolResult(run, state, call, nil, err)
	if state.ToolRepairs[call.Function.Name].Attempt != 1 {
		t.Fatal("progress did not reset the validation budget")
	}
	// Different fields and documents within this step still share one budget.
	call.ID = "next-step-2"
	call.Function.Arguments = ` { "document": {"sound":"改写后的内容"}, "key":"character" } `
	for i := 1; i < cloudAgentToolAttemptLimit; i++ {
		cloudAgentRecordToolResult(run, state, call, nil, err)
	}
	if run.Status != "waiting_user" || run.FailureMessage != "" || state.LastError != "" {
		t.Fatal(run)
	}
	last := state.Events[len(state.Events)-1]
	if last.Type != "production_control" || last.Payload["action"] != "needs_revision" || !strings.Contains(stringValue(last.Payload["text"]), "完整问题清单") {
		t.Fatal("production validation exhaustion did not become one current-item warning", last)
	}
	for _, event := range state.Events {
		if event.Type == "run_failed" {
			t.Fatal("local production validation was recorded as a failed run", event)
		}
	}
}

func TestProductionToolRepairAccumulatesValidationErrorsForSameProductionItem(t *testing.T) {
	state := &cloudAgentRuntime{}
	state.Request.Production = &ProductionAgentRequest{TargetNodeID: "target"}
	run := &model.CloudAgentExecution{ID: "run", Status: "running"}
	call := cloudAgentCall{ID: "invalid"}
	call.Function.Name, call.Function.Arguments = "production_submit", `{"key":"hero"}`
	for attempt, field := range []string{"voiceAccent", "voiceRange", "voicePrompt"} {
		cloudAgentRecordToolResult(run, state, call, nil, cloudAgentFieldError("document."+field, "required", "请补齐："+field))
		if attempt < cloudAgentToolAttemptLimit-1 && (run.Status != "running" || state.ToolRepairs[call.Function.Name].Attempt != attempt+1) {
			t.Fatal(run, state.ToolRepairs)
		}
	}
	if run.Status != "waiting_user" || run.FailureMessage != "" || state.LastError != "" || state.ToolRepairs[call.Function.Name].Attempt != cloudAgentToolAttemptLimit {
		t.Fatal("different validation fields bypassed the current item attempt budget", run, state.ToolRepairs)
	}
	needsRevision := 0
	for _, event := range state.Events {
		if event.Type == "run_failed" {
			t.Fatal("local production validation was recorded as a failed run", event)
		}
		if event.Type == "production_control" && event.Payload["action"] == "needs_revision" {
			needsRevision++
		}
	}
	if needsRevision != 1 {
		t.Fatalf("expected one aggregated needs_revision warning, got %d", needsRevision)
	}

	// A separate asset in the same phase receives its own bounded repair group.
	state, run = &cloudAgentRuntime{Request: state.Request, Step: 12, ProductionProgressStep: 12}, &model.CloudAgentExecution{ID: "run", Status: "running"}
	for attempt, key := range []string{"one", "two", "three"} {
		call.ID = key
		call.Function.Arguments = fmt.Sprintf(`{"key":%q}`, key)
		cloudAgentRecordToolResult(run, state, call, nil, cloudAgentFieldError("document.voice", "required", "请补齐"))
		if attempt == 0 && (run.Status != "running" || state.ToolRepairs[call.Function.Name].Attempt != 1) {
			t.Fatal("separate production items should not share repair allowance", run, state.ToolRepairs)
		}
	}
	if run.Status == "failed" || run.Status == "waiting_user" {
		t.Fatal("separate production items exhausted each other’s allowance", run)
	}
}
