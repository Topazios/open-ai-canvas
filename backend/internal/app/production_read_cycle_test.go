package app

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestProductionRuntimeReadCycleUsesDurableSuccessfulReceipts(t *testing.T) {
	for _, scenario := range []string{"cycle", "pagination", "different source", "different query", "failed tool", "checkpoint changed", "receipt replay", "resume", "journal pagination"} {
		t.Run(scenario, func(t *testing.T) {
			s, db, run := planFixture(t, 2)
			pageID := productionFirstPage(t, s, run.ID)
			productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": pageID}, false)
			execution, state := productionRuntimeState(t, s, run.ID)
			_, manifest, doc, err := productionLoad(s.repo, execution, &state)
			if err != nil {
				t.Fatal(err)
			}
			checkpoint, err := productionRuntimeCheckpoint(s.repo, execution, manifest)
			if err != nil {
				t.Fatal(err)
			}
			calls := make([]cloudAgentCall, 6)
			base := time.Now().Add(-time.Minute)
			for i := range calls {
				call := productionRuntimeCall("production_status")
				call.ID = fmt.Sprintf("read-loop-%d", i)
				if i%2 == 0 {
					call.Function.Name = "production_read"
					args, _ := json.Marshal(map[string]any{"pageId": pageID})
					call.Function.Arguments = string(args)
				}
				switch scenario {
				case "pagination":
					call.Function.Name, call.Function.Arguments = "production_status", fmt.Sprintf(`{"offset":%d}`, i*50)
				case "different source":
					call.Function.Name, call.Function.Arguments = "production_read", fmt.Sprintf(`{"pageId":"source-%d"}`, i)
				case "different query":
					call.Function.Name, call.Function.Arguments = "production_query", fmt.Sprintf(`{"assetKey":"asset-%d"}`, i)
				}
				calls[i] = call
				input, _ := json.Marshal(productionRuntimeStepInput{Checkpoint: checkpoint})
				if scenario == "checkpoint changed" {
					input = []byte(`{"productionCheckpoint":"previous-context-version"}`)
				}
				id := fmt.Sprintf("cycle-task-%d", i)
				task := model.Task{ID: id, UserID: "user", ProjectID: "agent-canvas", Operation: cloudAgentStepOperation, Type: "canvas_text", Status: model.TaskStatusRunning, InputJSON: string(input), CreatedAt: base.Add(time.Duration(i) * time.Second)}
				if err := db.Create(&task).Error; err != nil {
					t.Fatal(err)
				}
				if err := s.saveTaskCompletionWithinStorageQuota(&task, []byte(productionRuntimeResult(t, call)), nil, false); err != nil {
					t.Fatal(err)
				}
				state.TaskIDs = append(state.TaskIDs, id)
				kind := "tool_completed"
				if scenario == "failed tool" {
					kind = "tool_failed"
				}
				state.event(run.ID, kind, map[string]any{"callId": call.ID, "toolName": call.Function.Name, "arguments": call.Function.Arguments})
			}
			if scenario == "receipt replay" {
				state.TaskIDs = []string{"cycle-task-0", "cycle-task-1"}
			}
			if scenario == "resume" {
				state.event(run.ID, "production_control", map[string]any{"action": "resume"})
			}
			if scenario == "journal pagination" {
				for i := 0; i < 300; i++ {
					state.event(run.ID, "assistant_message", map[string]any{"messageId": fmt.Sprint(i), "text": "journal filler"})
				}
			}
			productionRuntimeMutate(t, s, run.ID, func(current *cloudAgentRuntime) { *current = state })
			_, state = productionRuntimeState(t, s, run.ID)
			recovery, err := productionRuntimeReadCycle(s.repo, "user", &state, checkpoint)
			if err != nil {
				t.Fatal(err)
			}
			want := scenario == "cycle" || scenario == "journal pagination"
			if (recovery != nil) != want {
				t.Fatalf("recovery=%v, want %v", recovery, want)
			}
			if !want {
				return
			}
			work, err := productionPlanContext(s.repo, execution, manifest, doc)
			if err != nil {
				t.Fatal(err)
			}
			canonical := canonicalAgentRequest{Tools: productionRuntimeTools(manifest, work), Messages: productionCheckpointMessages(nil, "write plan", work, "policy"), ToolChoice: "auto"}
			recovery, err = s.correctProductionRuntimeCycle("user", run.ID, &state, checkpoint, work, &canonical)
			if err != nil {
				t.Fatal(err)
			}
			productionRuntimeAssertTools(t, canonical.Tools, []string{"production_submit"})
			if canonical.ToolChoice != "required" {
				t.Fatal("corrective request must require the next productive action")
			}
			input, _ := json.Marshal(productionRuntimeStepInput{Checkpoint: checkpoint, Recovery: recovery})
			task := &model.Task{InputJSON: string(input)}
			if !productionRuntimeIgnoredRecovery(task, checkpoint, calls[:2]) || !productionRuntimeIgnoredRecovery(task, checkpoint, nil) {
				t.Fatal("same reads/prose must be rejected after correction")
			}
			if productionRuntimeIgnoredRecovery(task, checkpoint, []cloudAgentCall{productionRuntimeCall("production_submit")}) {
				t.Fatal("writing is progress")
			}
			if productionRuntimeIgnoredRecovery(task, "new-input-version", calls[:2]) {
				t.Fatal("new checkpoint must reset correction")
			}
		})
	}
}
