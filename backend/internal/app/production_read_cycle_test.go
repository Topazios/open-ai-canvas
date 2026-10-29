package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestProductionRuntimeReadCycleUsesDurableSuccessfulReceipts(t *testing.T) {
	for _, scenario := range []string{"cycle", "pagination", "different source", "different query", "failed tool", "missing receipts", "mixed receipts", "successful retry", "checkpoint changed", "receipt replay", "resume", "journal pagination"} {
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
				if scenario == "failed tool" || (scenario == "mixed receipts" && i%2 == 0) || (scenario == "successful retry" && i < 5) {
					kind = "tool_failed"
				}
				if scenario != "missing receipts" && !(scenario == "mixed receipts" && i == 3) {
					state.event(run.ID, kind, map[string]any{"callId": call.ID, "toolName": call.Function.Name, "arguments": call.Function.Arguments})
				}
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
			want := scenario == "cycle" || scenario == "journal pagination" || scenario == "failed tool" || scenario == "missing receipts" || scenario == "mixed receipts"
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
			if canonical.ToolChoice != "auto" {
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

func TestProductionRuntimeCorrectedWriteRequiresReceiptAndBoundsArgumentRepairs(t *testing.T) {
	for _, scenario := range []string{"repair and save", "changing invalid arguments", "exhausted repairs", "missing receipt", "nonrepairable failure"} {
		t.Run(scenario, func(t *testing.T) {
			s, db, run := planFixture(t, 2)
			productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
			execution, state := productionRuntimeState(t, s, run.ID)
			_, manifest, _, err := productionLoad(s.repo, execution, &state)
			if err != nil {
				t.Fatal(err)
			}
			checkpoint, err := productionRuntimeCheckpoint(s.repo, execution, manifest)
			if err != nil {
				t.Fatal(err)
			}
			// Simulate the observed model successes whose read calls never reached the
			// executor. They cannot keep resetting no-progress detection.
			for i := 0; i < 4; i++ {
				call := productionRuntimeCall("production_status")
				call.ID = fmt.Sprintf("skipped-read-%d", i)
				input, _ := json.Marshal(productionRuntimeStepInput{Checkpoint: checkpoint})
				task := model.Task{ID: fmt.Sprintf("skipped-task-%d", i), UserID: "user", ProjectID: "agent-canvas", Operation: cloudAgentStepOperation, Type: "canvas_text", Status: model.TaskStatusSucceeded, InputJSON: string(input), ResultJSON: productionRuntimeResult(t, call)}
				if err := db.Create(&task).Error; err != nil {
					t.Fatal(err)
				}
				state.TaskIDs = append(state.TaskIDs, task.ID)
			}
			productionRuntimeMutate(t, s, run.ID, func(current *cloudAgentRuntime) { *current = state })
			task, done := productionRuntimeStart(t, s, run.ID, []map[string]any{{"role": "user", "content": "advance the plan"}})
			var input productionRuntimeStepInput
			if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil || input.Recovery == nil || input.RequiredTool != "production_submit" {
				t.Fatalf("correction did not require the productive tool: %+v, %v", input, err)
			}
			if scenario == "exhausted repairs" {
				input.Recovery.RepairAttempts = cloudAgentToolAttemptLimit
				encoded, _ := json.Marshal(input)
				if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("input_json", string(encoded)).Error; err != nil {
					t.Fatal(err)
				}
			}
			call := productionRuntimeCall("production_submit")
			call.Function.Arguments = `{"key":"story","name":"story","document":{},"factIds":[]}`
			if got := productionRuntimeFinish(t, db, task.ID, done, call); got.err != nil {
				t.Fatal(got.err)
			}
			if scenario != "missing receipt" {
				result, err := s.executeCloudAgentRuntimeTool(context.Background(), "user", run.ID, call)
				if err != nil || result.(map[string]any)["isError"] != true {
					t.Fatalf("invalid document did not return its validation failure: %v %v", result, err)
				}
				if scenario == "nonrepairable failure" {
					productionRuntimeMutate(t, s, run.ID, func(state *cloudAgentRuntime) {
						state.event(run.ID, "tool_failed", map[string]any{"callId": call.ID, "toolName": call.Function.Name, "text": "保存失败", "result": map[string]any{"reason": "forbidden", "retryable": false}})
					})
				}
			}
			if scenario == "repair and save" {
				next, finished := productionRuntimeStart(t, s, run.ID, []map[string]any{{"role": "user", "content": "fix the rejected document"}})
				var correction productionRuntimeStepInput
				if err := json.Unmarshal([]byte(next.InputJSON), &correction); err != nil || correction.Recovery == nil || correction.Recovery.RepairAttempts != 1 || correction.RequiredTool != "production_submit" {
					t.Fatalf("repairable validation failure was not given bounded correction: %+v %v", correction, err)
				}
				call.ID = "corrected-submit"
				args, _ := json.Marshal(map[string]any{"key": "story", "name": "故事总纲", "document": orderedPlanDocument("story", ""), "factIds": []string{}})
				call.Function.Arguments = string(args)
				if got := productionRuntimeFinish(t, db, next.ID, finished, call); got.err != nil {
					t.Fatal(got.err)
				}
				result, err := s.executeCloudAgentRuntimeTool(context.Background(), "user", run.ID, call)
				if err != nil || result.(map[string]any)["isError"] == true || len(mustPlanArtifacts(t, s, run.ID)) != 1 {
					t.Fatalf("corrected document was not saved: %v %v", result, err)
				}
				return
			}
			if scenario == "changing invalid arguments" {
				for attempt := 1; attempt < cloudAgentToolAttemptLimit-1; attempt++ {
					next, finished := productionRuntimeStart(t, s, run.ID, []map[string]any{{"role": "user", "content": "correct the rejected fields"}})
					var correction productionRuntimeStepInput
					if err := json.Unmarshal([]byte(next.InputJSON), &correction); err != nil || correction.Recovery == nil || correction.Recovery.RepairAttempts != attempt {
						t.Fatalf("correction allowance was reset: %+v %v", correction, err)
					}
					call.ID = fmt.Sprintf("invalid-correction-%d", attempt)
					call.Function.Arguments = fmt.Sprintf(`{"key":"story","name":"故事总纲","document":{},"factIds":["revision-%d"]}`, attempt)
					if got := productionRuntimeFinish(t, db, next.ID, finished, call); got.err != nil {
						t.Fatal(got.err)
					}
					if _, err := s.executeCloudAgentRuntimeTool(context.Background(), "user", run.ID, call); err != nil {
						t.Fatal(err)
					}
				}
			}
			var before int64
			if err := db.Model(&model.Task{}).Count(&before).Error; err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, retryable, err := s.runCloudAgentModelStep(ctx, "user", run.ID, []map[string]any{{"role": "user", "content": "continue after rejection"}}, "off")
			if !errors.Is(err, errProductionRuntimeNoProgress) || retryable {
				t.Fatalf("failed corrective write scheduled another model call: %v %v", retryable, err)
			}
			stored, failed := productionRuntimeState(t, s, run.ID)
			if stored.Status != "waiting_user" || stored.FailureMessage != "" || failed.LastError != "" || failed.ActiveTaskID != "" {
				t.Fatalf("local validation became a run failure: %s %s", stored.Status, stored.FailureMessage)
			}
			foundNotice := false
			for _, event := range failed.Events {
				if event.Type == "run_failed" {
					t.Fatal("local validation emitted a run failure")
				}
				if event.Type == "production_control" && event.Payload["action"] == "needs_revision" {
					foundNotice = true
					if scenario != "missing receipt" && !strings.Contains(stringValue(event.Payload["text"]), "当前制作步骤") {
						t.Fatal("revision notice lost its current-step diagnostic", event.Payload)
					}
				}
			}
			if !foundNotice {
				t.Fatal("local validation did not emit a revision notice")
			}
			var after int64
			if err := db.Model(&model.Task{}).Count(&after).Error; err != nil || after != before {
				t.Fatalf("failure enqueued another task: before=%d after=%d err=%v", before, after, err)
			}
		})
	}
}

func TestProductionRuntimePlanFeedbackSeparatesSourceAndDocumentIdentity(t *testing.T) {
	s, _, run := planFixture(t, 2)
	page := productionFirstPage(t, s, run.ID)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": page}, false)
	story := submitOrderedPlan(t, s, run.ID, "story", "", "故事总纲")
	invalid := productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": "story"}, true)
	if invalid["reason"] != "invalid_tool_arguments" || invalid["field"] != "pageId" || !strings.Contains(stringValue(invalid["error"]), "assetKey") {
		t.Fatal("source identity error lacks an actionable document lookup", invalid)
	}
	query := productionCall(t, s, run.ID, "production_query", map[string]any{"assetKey": "story"}, false)
	if stringValue(query["content"]) == "" || query["expectedHash"] != story["hash"] {
		t.Fatal("saved documents cannot be read by their own key", query)
	}
	asset := productionPlanAsset{Key: "C001", Kind: "character", Name: "原始角色名", Episodes: []int{1, 2}, Purpose: "主视角", PlannedRange: "前两集"}
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{StoryHash: stringValue(story["hash"]), Assets: []productionPlanAsset{asset}}, false)
	m, doc, _ := orderedPlanState(t, s, run.ID)
	execution, _ := productionRuntimeState(t, s, run.ID)
	work, err := productionPlanContext(s.repo, execution, m, doc)
	if err != nil {
		t.Fatal(err)
	}
	index := work["registeredAssets"].([]map[string]any)
	encoded, _ := json.Marshal(index[0]["episodes"])
	if string(encoded) != "[1,2]" {
		t.Fatal("registered episode range missing from the checkpoint", index)
	}
	for _, tool := range productionRuntimeTools(m, work) {
		fn := tool["function"].(map[string]any)
		if fn["name"] == "production_read" {
			properties := fn["parameters"].(map[string]any)["properties"].(map[string]any)
			allowed := productionIDs(properties["pageId"].(map[string]any)["enum"])
			if len(allowed) != 1 || allowed[0] != page {
				t.Fatal("source schema accepts document keys", allowed)
			}
		}
	}
	asset.Name = "被改动的角色名"
	invalid = productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{StoryHash: stringValue(story["hash"]), Assets: []productionPlanAsset{asset}}, true)
	if invalid["field"] != "assets[0]" || invalid["issue"] != "registered_identity_changed" || !strings.Contains(stringValue(invalid["error"]), "原始角色名") {
		t.Fatal("registration failure lost the valid identity", invalid)
	}
}
