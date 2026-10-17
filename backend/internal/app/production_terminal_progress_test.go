package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func completeProductionModelThroughStorage(t *testing.T, s *Service, task *model.Task, done <-chan productionRuntimeOutcome, calls ...cloudAgentCall) productionRuntimeOutcome {
	t.Helper()
	if err := s.saveTaskCompletionWithinStorageQuota(task, []byte(productionRuntimeResult(t, calls...)), nil, false); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-done:
		return got
	case <-time.After(5 * time.Second):
		t.Fatal("model completion did not reach orchestration")
		return productionRuntimeOutcome{}
	}
}

func TestProductionCompletionKeepsPrivateProgressButDropsRequest(t *testing.T) {
	s, db, _ := planFixture(t, 2)
	task := model.Task{ID: "compact-production", UserID: "user", Type: "canvas_text", Operation: cloudAgentStepOperation, Status: model.TaskStatusRunning,
		InputJSON: `{"mode":"text","prompt":"private-body","config":{"apiKey":"private-key"},"agentRequests":{"canonical":{"systemPrompt":"private-policy"}},"productionCheckpoint":"checkpoint-hash","productionRecovery":{"reads":{"read-hash":true}},"productionRequiredTool":"production_submit"}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.saveTaskCompletionWithinStorageQuota(&task, []byte(`{"text":"done"}`), nil, false); err != nil {
		t.Fatal(err)
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	var progress productionRuntimeStepInput
	if err := json.Unmarshal([]byte(stored.InputJSON), &progress); err != nil {
		t.Fatal(err)
	}
	if progress.Checkpoint != "checkpoint-hash" || progress.Recovery == nil || !progress.Recovery.Reads["read-hash"] || progress.RequiredTool != "production_submit" {
		t.Fatalf("lost checkpoint: %+v", progress)
	}
	if strings.Contains(stored.InputJSON, "private-") {
		t.Fatal("terminal storage retained original request")
	}
	if completedTaskInputJSON(*stored) != stored.InputJSON {
		t.Fatal("recompaction after restart dropped progress")
	}
	public := taskForOutput(*stored)
	if public.InputJSON != `{"mode":"text"}` {
		t.Fatalf("internal progress exposed: %s", public.InputJSON)
	}
	stored.Operation = ""
	if completedTaskInputJSON(*stored) != public.InputJSON {
		t.Fatal("ordinary task retained production-only state")
	}
}

func TestProductionCompletedReadLoopCorrectsThenStops(t *testing.T) {
	s, _, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	for i := 0; i < 4; i++ {
		messages := []map[string]any{{"role": "user", "content": fmt.Sprintf("continue %d", i)}}
		task, done := productionRuntimeStart(t, s, run.ID, messages)
		if got := completeProductionModelThroughStorage(t, s, task, done); got.err != nil {
			t.Fatal(got.err)
		}
	}
	task, done := productionRuntimeStart(t, s, run.ID, []map[string]any{{"role": "user", "content": "continue after repeated explanations"}})
	var input map[string]any
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	canonical := stateCanonicalFromInput(input)
	productionRuntimeAssertTools(t, canonical.Tools, []string{"production_submit"})
	if canonical.ToolChoice != "required" || input["productionRecovery"] == nil {
		t.Fatal("missing corrective request")
	}
	if got := completeProductionModelThroughStorage(t, s, task, done); got.err == nil {
		t.Fatal("ignored correction continued looping")
	}
	latest, state := productionRuntimeState(t, s, run.ID)
	if latest.Status != "failed" || state.ActiveTaskID != "" {
		t.Fatal("loop did not stop cleanly")
	}
	before := len(state.TaskIDs)
	if err := s.ControlProductionAgent("user", run.ID, "resume"); err != nil {
		t.Fatal(err)
	}
	_, resumed := productionRuntimeState(t, s, run.ID)
	if len(resumed.TaskIDs) != before {
		t.Fatal("resume recreated model requests")
	}
}

func TestProductionFinalDraftCannotReturnToInspection(t *testing.T) {
	for _, response := range []string{"prose", "query", "submit"} {
		t.Run(response, func(t *testing.T) {
			s, _, runID := parallelPlanFixture(t)
			submitOrderedPlan(t, s, runID, "visual", "", "视觉规范")
			submitOrderedPlan(t, s, runID, "direction", "", "导演规范")
			for _, kind := range []string{"character", "sound", "environment", "prop", "special"} {
				submitOrderedPlan(t, s, runID, kind, kind, "测试"+kind)
			}
			task, done := productionRuntimeStart(t, s, runID, []map[string]any{{"role": "user", "content": "complete the final generation standard"}})
			var input map[string]any
			if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
				t.Fatal(err)
			}
			canonical := stateCanonicalFromInput(input)
			productionRuntimeAssertTools(t, canonical.Tools, []string{"production_submit"})
			if canonical.ToolChoice != "required" || input["productionRequiredTool"] != "production_submit" {
				t.Fatal("final draft still permits inspection")
			}
			var calls []cloudAgentCall
			if response == "query" {
				calls = []cloudAgentCall{productionRuntimeCall("production_status")}
			}
			if response == "submit" {
				call := productionRuntimeCall("production_submit")
				args, _ := json.Marshal(map[string]any{"key": "generation", "name": "生成与一致性规范", "document": orderedPlanDocument("generation", ""), "factIds": []string{}})
				call.Function.Arguments = string(args)
				calls = []cloudAgentCall{call}
			}
			got := completeProductionModelThroughStorage(t, s, task, done, calls...)
			if response != "submit" {
				if got.err == nil {
					t.Fatal("non-writing response accepted")
				}
				latest, _ := productionRuntimeState(t, s, runID)
				if latest.Status != "failed" {
					t.Fatal("failed output kept running")
				}
				if err := s.ControlProductionAgent("user", runID, "resume"); err != nil {
					t.Fatal(err)
				}
				return
			}
			if got.err != nil {
				t.Fatal(got.err)
			}
			productionCall(t, s, runID, "production_submit", map[string]any{"key": "generation", "name": "生成与一致性规范", "document": orderedPlanDocument("generation", ""), "factIds": []string{}}, false)
			_, beforeCheck := productionRuntimeState(t, s, runID)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			validation, err := s.cloudAgentPiModel(ctx, "user", runID, productionRuntimePayload([]map[string]any{{"role": "user", "content": "validate completion"}}))
			if err != nil {
				t.Fatal(err)
			}
			checkCalls := validation.(map[string]any)["toolCalls"].([]map[string]any)
			if len(checkCalls) != 1 || checkCalls[0]["name"] != "production_check" {
				t.Fatal("final validation was not scheduled directly")
			}
			report := productionCall(t, s, runID, "production_check", map[string]any{}, false)
			if report["valid"] != true {
				t.Fatal(report)
			}
			if _, err := s.cloudAgentPiModel(ctx, "user", runID, productionRuntimePayload([]map[string]any{{"role": "user", "content": "finish"}})); err != nil {
				t.Fatal(err)
			}
			_, afterCheck := productionRuntimeState(t, s, runID)
			if len(afterCheck.TaskIDs) != len(beforeCheck.TaskIDs) {
				t.Fatal("validation/completion caused another model request")
			}
		})
	}
}
