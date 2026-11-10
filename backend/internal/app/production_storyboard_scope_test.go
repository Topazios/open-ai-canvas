package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func adaptiveStoryboardFixture(t *testing.T) (*Service, string) {
	t.Helper()
	s, _, id := sceneStoryboardFixture(t, false)
	m, _, _ := storyboardState(t, s, id)
	m.Storyboard.AdaptiveWork = true
	scene := storyboardSceneByID(m, "S2")
	scene.Layout[0].TaskGroup, scene.Layout[1].TaskGroup = "a", "b"
	scene.Layout[1].DependsOn = []string{"S2-001"}
	raw, _ := json.Marshal(m)
	if err := s.repo.UpdateProductionAgentManifest("user", id, string(raw)); err != nil {
		t.Fatal(err)
	}
	return s, id
}

func TestStoryboardScopedOverflowKeepsOnlyOwnedValidatedShot(t *testing.T) {
	s, id := adaptiveStoryboardFixture(t)
	cancel, done := startParallel(t, s, id)
	state := waitParallel(t, s, id, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 3 })
	cancel()
	<-done
	work := state.ProductionParallel["S2"]
	task, call := sceneResult(t, s, id, work, 0)
	var args map[string]any
	_ = json.Unmarshal([]byte(call.Function.Arguments), &args)
	shots := args["shots"].([]any)
	shots[0].(map[string]any)["goal"] = "说出回归"
	shots[0].(map[string]any)["entry"] = "馆内"
	shots[0].(map[string]any)["exit"] = "对白结束"
	args["shots"] = append(shots, storyboardShot("S2", 2, 3, 3, 10))
	raw, _ := json.Marshal(args)
	call.Function.Arguments = string(raw)
	task.ResultJSON = productionRuntimeResult(t, call)
	if err := s.settleProductionParallel("user", id, work, task); err != nil {
		t.Fatal(err)
	}
	m, _, _ := storyboardState(t, s, id)
	scene := storyboardSceneByID(m, "S2")
	if len(scene.Shots) != 1 || scene.Shots[0].ID != "S2-001" || scene.Complete {
		t.Fatal("overflow wrote sibling or lost owned output")
	}
	_, after := productionRuntimeState(t, s, id)
	if after.ProductionParallel["S2-002"].TaskID != state.ProductionParallel["S2-002"].TaskID {
		t.Fatal("sibling assignment changed")
	}
	// Finishing a continuity predecessor must not invalidate an in-flight sibling.
	next := after.ProductionParallel["S2-002"]
	task, _ = sceneResult(t, s, id, next, 0)
	if err := s.settleProductionParallel("user", id, next, task); err != nil {
		t.Fatal(err)
	}
	m, _, _ = storyboardState(t, s, id)
	if !storyboardSceneByID(m, "S2").Complete {
		t.Fatal("sibling failed to settle after predecessor")
	}
}

func TestStoryboardScopedCallDoesNotAcceptForeignDuplicateOrChangedContract(t *testing.T) {
	s, id := adaptiveStoryboardFixture(t)
	m, doc, _ := storyboardState(t, s, id)
	work, scene := storyboardWorkGroup(m, "S2")
	for _, kind := range []string{"foreign", "duplicate", "invalid-item", "duration"} {
		t.Run(kind, func(t *testing.T) {
			shot := storyboardShot("S2", 1, 2, 2, 10)
			items := []any{shot}
			switch kind {
			case "foreign":
				items = append(items, storyboardShot("S1", 1, 1, 1, 10))
			case "duplicate":
				items = append(items, shot)
			case "invalid-item":
				items = append(items, "not-a-shot")
			case "duration":
				shot.Duration = 9.5
				items[0] = shot
			}
			call := productionRuntimeCall("production_storyboard_submit")
			raw, _ := json.Marshal(map[string]any{"sceneId": "S2", "offset": 0, "expectedHash": storyboardSubmissionHash(m, *scene), "complete": false, "shots": items})
			call.Function.Arguments = string(raw)
			_, err := storyboardScopeCall(m, work, call)
			if kind == "duration" {
				if err != nil {
					t.Fatal(err)
				}
				err = applyStoryboardExpansion(m, doc, "S2", shot)
				if err == nil || !strings.Contains(err.Error(), "duration=10") || !strings.Contains(err.Error(), "duration=9.5") {
					t.Fatal("missing exact timing correction", err)
				}
			} else if err == nil {
				t.Fatal("invalid ownership or item accepted")
			}
			if len(scene.Shots) != 0 {
				t.Fatal("invalid content was saved")
			}
		})
	}
}

func TestStoryboardScopedRepairContextAndSchema(t *testing.T) {
	s, id := adaptiveStoryboardFixture(t)
	run, state := productionRuntimeState(t, s, id)
	_, m, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		t.Fatal(err)
	}
	work, _ := storyboardWorkGroup(m, "S2-002")
	work.StoryboardDraft = json.RawMessage(`{"offset":0,"shots":[{"id":"S2-001","start":2,"end":2,"duration":10},{"id":"S2-002","start":3,"end":3,"duration":9.5}]}`)
	ctx, err := storyboardSceneContext(s.repo, run, m, doc, &work)
	if err != nil {
		t.Fatal(err)
	}
	if ctx["nextShot"] != "S2-002" || ctx["offset"] != 1 {
		t.Fatal("inherited episode cursor points at sibling", ctx["nextShot"])
	}
	draft := storyboardScopedDraft(m, work)
	if len(draft["shots"].([]map[string]any)) != 0 {
		t.Fatal("foreign or stale draft leaked into repair")
	}
	tools := productionRuntimeTools(m, ctx)
	storyboardScopeTools(tools, work, m)
	for _, tool := range tools {
		fn := tool["function"].(map[string]any)
		if fn["name"] != "production_storyboard_submit" {
			continue
		}
		props := fn["parameters"].(map[string]any)["properties"].(map[string]any)
		shots := props["shots"].(map[string]any)
		if shots["maxItems"] != 1 {
			t.Fatal("schema still invites whole-scene output")
		}
		ids := shots["items"].(map[string]any)["properties"].(map[string]any)["id"].(map[string]any)["enum"].([]string)
		if len(ids) != 1 || ids[0] != "S2-002" {
			t.Fatal(ids)
		}
		durations := shots["items"].(map[string]any)["properties"].(map[string]any)["duration"].(map[string]any)["enum"].([]float64)
		if len(durations) != 1 || durations[0] != 10 {
			t.Fatal("schema permits old timing", durations)
		}
	}
}

func TestStoryboardRetryDispatchesSiblingAgentsAndPreservesCompletedScene(t *testing.T) {
	s, id := adaptiveStoryboardFixture(t)
	cancel, done := startParallel(t, s, id)
	state := waitParallel(t, s, id, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 3 })
	cancel()
	<-done
	first := state.ProductionParallel["S1"]
	task, _ := sceneResult(t, s, id, first, 0)
	if err := s.settleProductionParallel("user", id, first, task); err != nil {
		t.Fatal(err)
	}
	if err := s.ControlProductionAgent("user", id, "pause"); err != nil {
		t.Fatal(err)
	}
	if err := s.ControlProductionAgent("user", id, "retry_main"); err != nil {
		t.Fatal(err)
	}
	cancel, done = startParallel(t, s, id)
	resumed := waitParallel(t, s, id, func(state cloudAgentRuntime) bool {
		return state.ProductionParallel["S2"].TaskID != "" && state.ProductionParallel["S2-002"].TaskID != ""
	})
	cancel()
	<-done
	if len(resumed.ProductionParallel) != 2 || resumed.ProductionParallel["S2"].TaskID == state.ProductionParallel["S2"].TaskID {
		t.Fatal("retry did not replace only unfinished assignments")
	}
	m, _, _ := storyboardState(t, s, id)
	if !storyboardSceneByID(m, "S1").Complete {
		t.Fatal("completed scene was redone")
	}
	for _, key := range []string{"S2-002", "S2"} {
		work := resumed.ProductionParallel[key]
		task, _ := sceneResult(t, s, id, work, 0)
		if err := s.settleProductionParallel("user", id, work, task); err != nil {
			t.Fatal(err)
		}
	}
	m, _, _ = storyboardState(t, s, id)
	if !storyboardSceneByID(m, "S2").Complete || m.Storyboard.ReviewHash != "" {
		t.Fatal("out-of-order commit failed or bypassed main review")
	}
}

func TestStoryboardContinuityDoesNotReleaseCrossSceneOrIncompleteContracts(t *testing.T) {
	s, id := adaptiveStoryboardFixture(t)
	m, _, _ := storyboardState(t, s, id)
	if !storyboardPlannedContinuity(m, "S2-002", "S2-001") {
		t.Fatal("complete adjacent plan was blocked")
	}
	if storyboardPlannedContinuity(m, "S2-002", "S1-001") {
		t.Fatal("cross-scene dependency released")
	}
	storyboardSceneByID(m, "S2").Layout[0].Exit = ""
	if storyboardPlannedContinuity(m, "S2-002", "S2-001") {
		t.Fatal("missing endpoint released")
	}
}
