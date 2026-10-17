package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

var productionRuntimePlanNames = []string{"production_status", "production_read", "production_query", "production_submit", "production_check", "production_plan_inventory"}
var productionRuntimeAssetNames = []string{"production_status", "production_read", "production_query", "production_submit", "production_check", "production_facts"}
var productionRuntimeStoryboardNames = []string{"production_storyboard_context", "production_storyboard_brief", "production_storyboard_plan", "production_storyboard_submit", "production_storyboard_reset", "production_storyboard_review", "production_storyboard_read"}

func productionRuntimeAssertTools(t *testing.T, tools []map[string]any, expected []string) {
	t.Helper()
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		fn, _ := tool["function"].(map[string]any)
		names = append(names, stringValue(fn["name"]))
	}
	want := append([]string(nil), expected...)
	sort.Strings(names)
	sort.Strings(want)
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("actual canonical tools = %v; want %v", names, want)
	}
}

func productionRuntimeState(t *testing.T, s *Service, runID string) (*model.CloudAgentExecution, cloudAgentRuntime) {
	t.Helper()
	run, err := s.repo.CloudAgent("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		t.Fatal(err)
	}
	return run, state
}

func productionRuntimeMutate(t *testing.T, s *Service, runID string, update func(*cloudAgentRuntime)) {
	t.Helper()
	run, state := productionRuntimeState(t, s, runID)
	update(&state)
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
}

func productionRuntimeTestModelKey(t *testing.T, s *Service, runID string, messages []map[string]any) string {
	t.Helper()
	run, state := productionRuntimeState(t, s, runID)
	_, manifest, _, err := productionLoad(s.repo, run, &state)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint, err := productionRuntimeCheckpoint(s.repo, run, manifest)
	if err != nil {
		t.Fatal(err)
	}
	return productionRuntimeModelKey(messages, "off", nil, checkpoint)
}

func productionRuntimeCall(name string) cloudAgentCall {
	call := cloudAgentCall{ID: "runtime-test-call-" + name}
	call.Function.Name, call.Function.Arguments = name, "{}"
	return call
}

func productionRuntimeResult(t *testing.T, calls ...cloudAgentCall) string {
	t.Helper()
	data, err := json.Marshal(map[string]any{"text": "", "toolCalls": calls})
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func productionRuntimePayload(messages []map[string]any) map[string]json.RawMessage {
	encoded, _ := json.Marshal(messages)
	// Restored runtime registries must not poison the provider request.
	return map[string]json.RawMessage{"messages": encoded, "thinkingLevel": json.RawMessage(`"off"`), "tools": json.RawMessage(`[{"name":"production_poison","parameters":{"type":"object"}}]`)}
}

type productionRuntimeOutcome struct {
	result any
	err    error
}

// Exercise the real bridge and enqueue path without starting a worker or making
// an upstream request. Tests complete only their temporary database task.
func productionRuntimeStart(t *testing.T, s *Service, runID string, messages []map[string]any) (*model.Task, <-chan productionRuntimeOutcome) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	done := make(chan productionRuntimeOutcome, 1)
	finished := make(chan struct{})
	t.Cleanup(func() { cancel(); <-finished })
	go func() {
		defer close(finished)
		result, err := s.cloudAgentPiModel(ctx, "user", runID, productionRuntimePayload(messages))
		done <- productionRuntimeOutcome{result, err}
	}()
	for {
		_, state := productionRuntimeState(t, s, runID)
		if state.ActiveTaskID != "" {
			task, err := s.repo.Task(state.ActiveTaskID)
			if err != nil {
				t.Fatal(err)
			}
			return task, done
		}
		select {
		case got := <-done:
			t.Fatalf("bridge returned before scheduling: %v", got.err)
		case <-ctx.Done():
			t.Fatal("model task was not scheduled")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func productionRuntimeFinish(t *testing.T, db *gorm.DB, taskID string, done <-chan productionRuntimeOutcome, calls ...cloudAgentCall) productionRuntimeOutcome {
	t.Helper()
	if err := db.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": productionRuntimeResult(t, calls...)}).Error; err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-done:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not finish the simulated model result")
		return productionRuntimeOutcome{}
	}
}

func TestProductionRuntimeCanonicalToolsFollowManifest(t *testing.T) {
	fixtures := []struct {
		name    string
		fixture func(*testing.T) (*Service, *gorm.DB, *CloudAgentRun)
		tools   []string
		call    string
	}{
		{"plan v1", func(t *testing.T) (*Service, *gorm.DB, *CloudAgentRun) { return planFixture(t) }, productionRuntimePlanNames, "production_status"},
		{"plan v2", func(t *testing.T) (*Service, *gorm.DB, *CloudAgentRun) { return planFixture(t, 2) }, productionRuntimePlanNames, "production_status"},
		{"storyboard", storyboardFixture, productionRuntimeStoryboardNames, "production_storyboard_context"},
		{"assets", func(t *testing.T) (*Service, *gorm.DB, *CloudAgentRun) { return productionFixture(t) }, productionRuntimeAssetNames, "production_status"},
	}
	for _, fixture := range fixtures {
		for _, mode := range []string{"new task", "active task", "receipt replay"} {
			t.Run(fixture.name+"/"+mode, func(t *testing.T) {
				s, db, run := fixture.fixture(t)
				messages := []map[string]any{{"role": "user", "content": "continue production"}}
				call := productionRuntimeCall(fixture.call)
				key := productionRuntimeTestModelKey(t, s, run.ID, messages)
				if mode != "new task" {
					if err := db.Create(&model.Task{ID: "saved-runtime-step", UserID: "user", ProjectID: "agent-canvas", Type: "canvas_text", Status: model.TaskStatusSucceeded, ResultJSON: productionRuntimeResult(t, call)}).Error; err != nil {
						t.Fatal(err)
					}
				}
				productionRuntimeMutate(t, s, run.ID, func(state *cloudAgentRuntime) {
					state.Canonical.Tools = runtimeToolSchemas([]map[string]any{{"name": "production_poison"}})
					if mode != "new task" {
						state.TaskIDs = append(state.TaskIDs, "saved-runtime-step")
					}
					if mode == "active task" {
						state.ActiveTaskID = "saved-runtime-step"
					} else if mode == "receipt replay" {
						state.ProductionModelReceipts = map[string]string{key: "saved-runtime-step"}
					}
				})
				var before int64
				if err := db.Model(&model.Task{}).Count(&before).Error; err != nil {
					t.Fatal(err)
				}
				if mode == "new task" {
					task, done := productionRuntimeStart(t, s, run.ID, messages)
					var input map[string]any
					if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
						t.Fatal(err)
					}
					canonical := stateCanonicalFromInput(input)
					productionRuntimeAssertTools(t, canonical.Tools, fixture.tools)
					if got := productionRuntimeFinish(t, db, task.ID, done, call); got.err != nil {
						t.Fatal(got.err)
					}
				} else {
					ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
					defer cancel()
					if _, err := s.cloudAgentPiModel(ctx, "user", run.ID, productionRuntimePayload(messages)); err != nil {
						t.Fatal(err)
					}
				}
				_, state := productionRuntimeState(t, s, run.ID)
				productionRuntimeAssertTools(t, state.Canonical.Tools, fixture.tools)
				var after int64
				if err := db.Model(&model.Task{}).Count(&after).Error; err != nil {
					t.Fatal(err)
				}
				want := before
				if mode == "new task" {
					want++
				}
				if after != want {
					t.Fatalf("task count = %d; want %d", after, want)
				}
			})
		}
	}
}

func TestProductionRuntimeUnknownToolFailsOnceAndResumes(t *testing.T) {
	for _, name := range []string{"production_unknown", "production_storyboard_context", "production_facts", "canvas_get_state"} {
		t.Run(name, func(t *testing.T) {
			s, db, run := planFixture(t)
			productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
			productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "story", "document": planDocument("story"), "factIds": []string{}}, false)
			artifacts, err := s.repo.ProductionAgentArtifacts("user", run.ID)
			if err != nil || len(artifacts) != 1 {
				t.Fatalf("prepare artifact: %v, %v", artifacts, err)
			}
			messages := []map[string]any{{"role": "user", "content": "continue production"}}
			task, done := productionRuntimeStart(t, s, run.ID, messages)
			_, before := productionRuntimeState(t, s, run.ID)
			var accountBefore model.CreditAccount
			if err := db.First(&accountBefore, "user_id = ?", "user").Error; err != nil {
				t.Fatal(err)
			}
			// A valid call in the same batch must not escape the invalid-batch guard.
			got := productionRuntimeFinish(t, db, task.ID, done, productionRuntimeCall("production_status"), productionRuntimeCall(name))
			if !errors.Is(got.err, errProductionRuntimeUnknownTool) || got.result != nil {
				t.Fatalf("unsupported result was not rejected: %+v", got)
			}
			stored, failed := productionRuntimeState(t, s, run.ID)
			if stored.Status != "failed" || failed.ActiveTaskID != "" || failed.LastError != errProductionRuntimeUnknownTool.Error() {
				t.Fatalf("not a recoverable failure: status=%s active=%s error=%s", stored.Status, failed.ActiveTaskID, failed.LastError)
			}
			failures := 0
			for _, event := range failed.Events {
				if event.Type == "run_failed" && event.Payload["reason"] == "unknown_production_tool" {
					failures++
				}
			}
			if failures != 1 {
				t.Fatalf("got %d failure events; want one", failures)
			}
			for _, receipt := range failed.ProductionModelReceipts {
				if receipt == task.ID {
					t.Fatal("unusable response would be replayed on resume")
				}
			}
			if failed.Step != before.Step || failed.Request.Budget != before.Request.Budget {
				t.Fatal("failure changed steps or budget")
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if _, err := s.cloudAgentPiModel(ctx, "user", run.ID, productionRuntimePayload(messages)); err == nil {
				t.Fatal("failed run accepted another model request")
			}
			var tasks int64
			if err := db.Model(&model.Task{}).Count(&tasks).Error; err != nil || tasks != 2 {
				t.Fatalf("unknown tool scheduled another model step: count=%d err=%v", tasks, err)
			}
			var accountAfter model.CreditAccount
			if err := db.First(&accountAfter, "user_id = ?", "user").Error; err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(accountBefore, accountAfter) {
				t.Fatal("failure altered billing")
			}
			completed, err := s.repo.Task(task.ID)
			if err != nil || completed.Status != model.TaskStatusSucceeded {
				t.Fatalf("failure changed successful model task: %v %v", completed, err)
			}
			if err := s.ControlProductionAgent("user", run.ID, "resume"); err != nil {
				t.Fatal(err)
			}
			stored, _ = productionRuntimeState(t, s, run.ID)
			if stored.Status != "running" || stored.FailureMessage != "" {
				t.Fatal("existing resume control could not recover the run")
			}
			afterArtifacts, err := s.repo.ProductionAgentArtifacts("user", run.ID)
			if err != nil || !reflect.DeepEqual(artifacts, afterArtifacts) {
				t.Fatalf("saved work changed: %v", err)
			}
			// Reuse the same input to prove the rejected receipt was invalidated.
			nextTask, nextDone := productionRuntimeStart(t, s, run.ID, messages)
			if nextTask.ID == task.ID {
				t.Fatal("resume reused an unsupported result")
			}
			if got := productionRuntimeFinish(t, db, nextTask.ID, nextDone, productionRuntimeCall("production_status")); got.err != nil {
				t.Fatalf("resumed model boundary failed: %v", got.err)
			}
		})
	}
}

func TestProductionRuntimeStaleUnknownToolStopsBeforeEnqueue(t *testing.T) {
	s, db, run := planFixture(t)
	messages := []map[string]any{
		{"role": "user", "content": "continue production"},
		{"role": "assistant", "content": []any{map[string]any{"type": "toolCall", "id": "stale-call", "name": "production_unknown", "arguments": map[string]any{}}}},
		{"role": "toolResult", "toolCallId": "stale-call", "content": []any{map[string]any{"type": "text", "text": "unknown tool"}}},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, retryable, err := s.runCloudAgentModelStep(ctx, "user", run.ID, messages, "off")
	if !errors.Is(err, errProductionRuntimeUnknownTool) || retryable {
		t.Fatalf("stale unknown call: retryable=%v err=%v", retryable, err)
	}
	var tasks int64
	if err := db.Model(&model.Task{}).Count(&tasks).Error; err != nil || tasks != 1 {
		t.Fatalf("stale tool failure enqueued an explanation: count=%d err=%v", tasks, err)
	}
	if err := s.ControlProductionAgent("user", run.ID, "resume"); err != nil {
		t.Fatal(err)
	}
	messages = append(messages, map[string]any{"role": "user", "content": "resume from saved progress"})
	task, done := productionRuntimeStart(t, s, run.ID, messages)
	if got := productionRuntimeFinish(t, db, task.ID, done, productionRuntimeCall("production_status")); got.err != nil {
		t.Fatal(got.err)
	}
}

func TestProductionRuntimePlanV2ScopesCanonicalSubmitSchema(t *testing.T) {
	s, db, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	task, done := productionRuntimeStart(t, s, run.ID, []map[string]any{{"role": "user", "content": "write the current document"}})
	var input map[string]any
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	canonical := stateCanonicalFromInput(input)
	productionRuntimeAssertTools(t, canonical.Tools, productionRuntimePlanNames)
	found := false
	for _, tool := range canonical.Tools {
		fn, _ := tool["function"].(map[string]any)
		if fn["name"] != "production_submit" {
			continue
		}
		found = true
		parameters := fn["parameters"].(map[string]any)
		properties := parameters["properties"].(map[string]any)
		key := properties["key"].(map[string]any)
		if !reflect.DeepEqual(productionIDs(key["enum"]), []string{"story"}) {
			t.Fatalf("current nextAction key did not reach model schema: %#v", key)
		}
		document := properties["document"].(map[string]any)
		required := productionIDs(document["required"])
		want := []string{"facts", "premise", "motivation", "world", "worldRules", "conflict", "plot", "arcs", "characterArcs", "relationships", "ending", "foreshadowing", "continuity", "uncertainties"}
		sort.Strings(required)
		sort.Strings(want)
		if !reflect.DeepEqual(required, want) || document["additionalProperties"] != false {
			t.Fatalf("story schema was not scoped: %#v", document)
		}
	}
	if !found {
		t.Fatal("missing production_submit")
	}
	if got := productionRuntimeFinish(t, db, task.ID, done, productionRuntimeCall("production_status")); got.err != nil {
		t.Fatal(got.err)
	}
}

func TestProductionRuntimeRejectsUnsupportedResumedResult(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(map[bool]string{false: "receipt", true: "active"}[active], func(t *testing.T) {
			s, db, run := planFixture(t)
			messages := []map[string]any{{"role": "user", "content": "resume production"}}
			key := productionRuntimeTestModelKey(t, s, run.ID, messages)
			if err := db.Create(&model.Task{ID: "stale-runtime-step", UserID: "user", ProjectID: "agent-canvas", Type: "canvas_text", Status: model.TaskStatusSucceeded, ResultJSON: productionRuntimeResult(t, productionRuntimeCall("production_storyboard_context"))}).Error; err != nil {
				t.Fatal(err)
			}
			productionRuntimeMutate(t, s, run.ID, func(state *cloudAgentRuntime) {
				state.Canonical.Tools = storyboardTools()
				state.TaskIDs = append(state.TaskIDs, "stale-runtime-step")
				state.ProductionModelReceipts = map[string]string{key: "stale-runtime-step"}
				if active {
					state.ActiveTaskID = "stale-runtime-step"
					// Exercise the active branch independently of receipt lookup.
					state.ProductionModelReceipts = map[string]string{"older-request": "stale-runtime-step"}
				}
			})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_, retryable, err := s.runCloudAgentModelStep(ctx, "user", run.ID, messages, "off")
			if !errors.Is(err, errProductionRuntimeUnknownTool) || retryable {
				t.Fatalf("stale result accepted or retried: retry=%v err=%v", retryable, err)
			}
			stored, state := productionRuntimeState(t, s, run.ID)
			productionRuntimeAssertTools(t, state.Canonical.Tools, productionRuntimePlanNames)
			if stored.Status != "failed" || state.ActiveTaskID != "" || len(state.ProductionModelReceipts) != 0 {
				t.Fatalf("stale replay was not released: status=%s active=%s receipts=%v", stored.Status, state.ActiveTaskID, state.ProductionModelReceipts)
			}
			var tasks int64
			if err := db.Model(&model.Task{}).Count(&tasks).Error; err != nil || tasks != 2 {
				t.Fatalf("stale result created another task: count=%d err=%v", tasks, err)
			}
		})
	}
}

func TestProductionRuntimeBlockedPlanDoesNotEnqueue(t *testing.T) {
	for _, change := range []string{"edited", "moved", "deleted"} {
		t.Run(change, func(t *testing.T) {
			s, db, run := planFixture(t, 2)
			productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
			document := map[string]string{}
			for _, section := range productionPlanDocumentSections("story", "") {
				document[section.Key] = "Detailed production design for " + section.Key
			}
			receipt := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "story", "document": document, "factIds": []string{}}, false)
			nodeID := stringValue(receipt["nodeId"])
			productionEditCanvas(t, s, db, func(doc map[string]any) {
				node := productionNode(doc, nodeID)
				switch change {
				case "edited":
					node["metadata"].(map[string]any)["content"] = "Manual revision must survive"
				case "moved":
					node["parentId"] = "bodies"
				case "deleted":
					nodes := []map[string]any{}
					for _, candidate := range creationMaps(doc["nodes"]) {
						if candidate["id"] != nodeID {
							nodes = append(nodes, candidate)
						}
					}
					doc["nodes"] = nodes
				}
			})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_, retryable, err := s.runCloudAgentModelStep(ctx, "user", run.ID, []map[string]any{{"role": "user", "content": "continue"}}, "off")
			if !errors.Is(err, errProductionRuntimePlanBlocked) || retryable {
				t.Fatalf("blocked plan must fail without model retry: retry=%v err=%v", retryable, err)
			}
			stored, _ := productionRuntimeState(t, s, run.ID)
			if stored.Status != "failed" {
				t.Fatalf("blocked run status = %s", stored.Status)
			}
			var tasks int64
			if err := db.Model(&model.Task{}).Count(&tasks).Error; err != nil || tasks != 1 {
				t.Fatalf("blocked plan enqueued a model task: count=%d err=%v", tasks, err)
			}
			canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
			if err != nil {
				t.Fatal(err)
			}
			doc, err := creationDocument(canvas.PayloadJSON)
			if err != nil {
				t.Fatal(err)
			}
			node := productionNode(doc, nodeID)
			if change == "deleted" && node != nil {
				t.Fatal("deleted document was recreated")
			}
			if change == "moved" && node["parentId"] != "bodies" {
				t.Fatal("moved document was reparented")
			}
			if change == "edited" && node["metadata"].(map[string]any)["content"] != "Manual revision must survive" {
				t.Fatal("manual revision was overwritten")
			}
		})
	}
}

func productionRuntimeFinishText(t *testing.T, db *gorm.DB, taskID string, done <-chan productionRuntimeOutcome, text string) productionRuntimeOutcome {
	t.Helper()
	result, err := json.Marshal(map[string]any{"text": text, "toolCalls": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": string(result)}).Error; err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-done:
		return got
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not finish text-only response")
		return productionRuntimeOutcome{}
	}
}

func TestProductionRuntimeReceiptTracksDurableProgress(t *testing.T) {
	s, db, run := planFixture(t)
	messages := []map[string]any{{"role": "user", "content": "continue production"}}
	first, firstDone := productionRuntimeStart(t, s, run.ID, messages)
	if got := productionRuntimeFinish(t, db, first.ID, firstDone, productionRuntimeCall("production_status")); got.err != nil {
		t.Fatal(got.err)
	}
	// The exact same input/checkpoint must replay without enqueuing.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := s.cloudAgentPiModel(ctx, "user", run.ID, productionRuntimePayload(messages)); err != nil {
		t.Fatal(err)
	}
	var before int64
	if err := db.Model(&model.Task{}).Count(&before).Error; err != nil || before != 2 {
		t.Fatalf("same checkpoint did not replay: count=%d err=%v", before, err)
	}
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	second, secondDone := productionRuntimeStart(t, s, run.ID, messages)
	if second.ID == first.ID {
		t.Fatal("read progress replayed a stale model result")
	}
	if got := productionRuntimeFinish(t, db, second.ID, secondDone, productionRuntimeCall("production_status")); got.err != nil {
		t.Fatal(got.err)
	}
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "story", "document": planDocument("story"), "factIds": []string{}}, false)
	third, thirdDone := productionRuntimeStart(t, s, run.ID, messages)
	if third.ID == second.ID || third.ID == first.ID {
		t.Fatal("saved artifact replayed a stale model result")
	}
	if got := productionRuntimeFinish(t, db, third.ID, thirdDone, productionRuntimeCall("production_status")); got.err != nil {
		t.Fatal(got.err)
	}
}

func TestProductionRuntimeActiveTaskPrecedesNewCheckpointReceipt(t *testing.T) {
	s, db, run := planFixture(t)
	messages := []map[string]any{{"role": "user", "content": "continue production"}}
	for _, taskID := range []string{"active-model", "old-receipt"} {
		call := productionRuntimeCall("production_status")
		call.ID = taskID
		if err := db.Create(&model.Task{ID: taskID, UserID: "user", ProjectID: "agent-canvas", Type: "canvas_text", Status: model.TaskStatusSucceeded, ResultJSON: productionRuntimeResult(t, call)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	key := productionRuntimeTestModelKey(t, s, run.ID, messages)
	productionRuntimeMutate(t, s, run.ID, func(state *cloudAgentRuntime) {
		state.TaskIDs = append(state.TaskIDs, "active-model", "old-receipt")
		state.ActiveTaskID = "active-model"
		state.ProductionModelKey = "original-active-key"
		state.ProductionModelReceipts = map[string]string{key: "old-receipt"}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, _, err := s.runCloudAgentModelStep(ctx, "user", run.ID, messages, "off")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	var response struct {
		ToolCalls []struct {
			ID string `json:"id"`
		} `json:"toolCalls"`
	}
	if err := json.Unmarshal(encoded, &response); err != nil || len(response.ToolCalls) != 1 || response.ToolCalls[0].ID != "active-model" {
		t.Fatalf("active task was replaced by a receipt: %s err=%v", encoded, err)
	}
}

func TestProductionRuntimeResumeKeepsSuccessfulModelReceipt(t *testing.T) {
	s, db, run := planFixture(t, 2)
	messages := []map[string]any{{"role": "user", "content": "continue current plan"}}
	task, done := productionRuntimeStart(t, s, run.ID, messages)
	if got := productionRuntimeFinish(t, db, task.ID, done, productionRuntimeCall("production_status")); got.err != nil {
		t.Fatal(got.err)
	}
	_, beforeResume := productionRuntimeState(t, s, run.ID)
	productionRuntimeMutate(t, s, run.ID, func(state *cloudAgentRuntime) {
		state.event(run.ID, "production_control", map[string]any{"action": "resume"})
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := s.cloudAgentPiModel(ctx, "user", run.ID, productionRuntimePayload(messages)); err != nil {
		t.Fatalf("resuming must reuse an already successful response: %v", err)
	}
	_, state := productionRuntimeState(t, s, run.ID)
	if !reflect.DeepEqual(state.TaskIDs, beforeResume.TaskIDs) {
		t.Fatal("resume created an unnecessary paid model step", state.TaskIDs)
	}
}

func TestProductionRuntimeRepeatedProseCorrectsBeforeStopping(t *testing.T) {
	for _, change := range []string{"none", "read", "valid tool", "different text"} {
		t.Run(change, func(t *testing.T) {
			s, db, run := planFixture(t)
			firstMessages := []map[string]any{{"role": "user", "content": "first request"}}
			first, done := productionRuntimeStart(t, s, run.ID, firstMessages)
			if got := productionRuntimeFinishText(t, db, first.ID, done, "I will continue the work."); got.err != nil {
				t.Fatal(got.err)
			}
			// Receipt replay of the first prose response must not trigger the guard.
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if _, err := s.cloudAgentPiModel(ctx, "user", run.ID, productionRuntimePayload(firstMessages)); err != nil {
				t.Fatalf("receipt counted as a repeated model response: %v", err)
			}
			text := "I will continue the work."
			switch change {
			case "read":
				productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
			case "valid tool":
				middle, middleDone := productionRuntimeStart(t, s, run.ID, []map[string]any{{"role": "user", "content": "use a tool"}})
				if got := productionRuntimeFinish(t, db, middle.ID, middleDone, productionRuntimeCall("production_status")); got.err != nil {
					t.Fatal(got.err)
				}
			case "different text":
				text = "A different response."
			}
			// A fresh service proves detection is based on durable records.
			restarted := &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
			second, secondDone := productionRuntimeStart(t, restarted, run.ID, []map[string]any{{"role": "user", "content": "second request"}})
			got := productionRuntimeFinishText(t, db, second.ID, secondDone, text)
			if got.err != nil {
				t.Fatalf("response failed before corrective request: %v", got.err)
			}
			if change == "none" {
				for i := 0; i < 2; i++ {
					step, finished := productionRuntimeStart(t, restarted, run.ID, []map[string]any{{"role": "user", "content": fmt.Sprintf("continue %d", i)}})
					if response := productionRuntimeFinishText(t, db, step.ID, finished, fmt.Sprintf("I will start the plan now, version %d.", i)); response.err != nil {
						t.Fatal(response.err)
					}
				}
				step, finished := productionRuntimeStart(t, restarted, run.ID, []map[string]any{{"role": "user", "content": "execute the next step"}})
				var input productionRuntimeStepInput
				if err := json.Unmarshal([]byte(step.InputJSON), &input); err != nil || input.Recovery == nil {
					t.Fatal("repeated paraphrases must receive corrective context", err)
				}
				got = productionRuntimeFinishText(t, db, step.ID, finished, "I will start by reading the source again.")
				if !errors.Is(got.err, errProductionRuntimeNoProgress) || got.result != nil {
					t.Fatalf("ignored corrective instruction did not stop: %+v", got)
				}
				stored, state := productionRuntimeState(t, s, run.ID)
				if stored.Status != "failed" || state.ActiveTaskID != "" {
					t.Fatalf("no-progress failure state: %s %s", stored.Status, state.ActiveTaskID)
				}
				if err := s.ControlProductionAgent("user", run.ID, "resume"); err != nil {
					t.Fatal(err)
				}
			} else if got.err != nil {
				t.Fatalf("productive or changed response rejected: %v", got.err)
			}
		})
	}
}
