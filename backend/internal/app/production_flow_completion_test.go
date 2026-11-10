package app

import (
	"encoding/json"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestProductionFlowRetryWindowTracksProgressAndGrowingScope(t *testing.T) {
	var c productionFlowControl
	c.initialize("story", "v1", 32, 1)
	if c.RetryBudget != 6 {
		t.Fatal(c)
	}
	c.initialize("story", "v1", 32, 120)
	if c.RetryBudget != 24 {
		t.Fatal("budget frozen at initial global step", c)
	}
	for episode := 0; episode < 120; episode++ {
		if !c.retry() {
			t.Fatal("successful long work exhausted lifetime budget", episode, c)
		}
		c.accepted(32)
	}
	if c.TotalRetries != 120 || c.RetrySpent != 0 {
		t.Fatal("progress erased audit history", c)
	}
	for round := 0; round < 3; round++ {
		if !c.recover(time.Now()) {
			t.Fatal("early recovery limit")
		}
	}
	if c.recover(time.Now()) {
		t.Fatal("unbounded recovery without progress")
	}
}

func TestProductionFlowFreshWorkIsNotBlockedByPriorRetrySpend(t *testing.T) {
	s, _, id := flowFixture(t)
	g, _ := flowGraph(t, s, id, "story")
	mutateParallelState(t, s, id, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.ProductionFlowControl = productionFlowControl{Scope: "story:" + g.Source, Window: 8, RetrySpent: 6, RetryBudget: 6}
	})
	run, state := productionRuntimeState(t, s, id)
	if _, err := s.claimProductionFlow(run, &state, "fresh-admission"); err != nil {
		t.Fatal(err)
	}
	run, state = productionRuntimeState(t, s, id)
	m, doc, rows := orderedPlanState(t, s, id)
	before := len(state.TaskIDs)
	if changed, err := s.advanceProductionFlow(run, &state, m, doc, rows, "story"); err != nil || !changed {
		t.Fatal(changed, err)
	}
	run, state = productionRuntimeState(t, s, id)
	if run.Status != "running" || len(state.TaskIDs) != before+1 || state.ProductionFlowControl.RetrySpent != 6 {
		t.Fatal("fresh request consumed retry budget or paused", run.Status, state.ProductionFlowControl)
	}
}

func TestProductionFlowLongRunRepairsAndPublishesWithoutManualContinue(t *testing.T) {
	s, db, id := flowFixture(t, 120)
	if err := db.Model(&model.CreditAccount{}).Where("user_id = ?", "user").Update("available_microcredits", int64(1_000_000_000)).Error; err != nil {
		t.Fatal(err)
	}
	flowGraph(t, s, id, "story")
	repaired := 0
	for turn := 0; turn < 600; turn++ {
		run, state := productionRuntimeState(t, s, id)
		if state.ProductionPaused || run.Status != "running" {
			t.Fatal("long work required manual continue", turn, run.Status, run.FailureMessage)
		}
		if _, err := s.claimProductionFlow(run, &state, "long-run"); err != nil {
			t.Fatal(err)
		}
		run, state = productionRuntimeState(t, s, id)
		m, doc, artifacts := orderedPlanState(t, s, id)
		if productionPlanArtifactValid(m, doc, artifacts, "story") {
			if repaired < 15 || state.ProductionFlowControl.TotalRetries < 15 || state.ProductionFlowControl.ManualRounds != 0 {
				t.Fatal("fixture did not exceed old retry limit", repaired, state.ProductionFlowControl)
			}
			return
		}
		if _, err := s.advanceProductionFlow(run, &state, m, doc, artifacts, "story"); err != nil {
			t.Fatal(turn, err)
		}
		g, _ := flowGraph(t, s, id, "story")
		for _, unit := range g.Units {
			if unit.Status != "running" {
				continue
			}
			task, err := s.repo.TaskForUser("user", unit.TaskID)
			if err != nil {
				t.Fatal(err)
			}
			if cloudAgentTaskTerminal(task.Status) {
				continue
			}
			reply := flowReply(unit)
			if unit.Stage == "arcs" {
				reply = map[string]any{"arcs": []productionFlowArc{{Title: "调查", Start: 1, End: 120, Entry: "发现相机", Goal: "找到家人", Events: "调查线索", Exit: "与家人团聚", Threads: "相机来源"}}}
			}
			if unit.Stage == "cards" {
				rows := reply.(map[string]any)["episodes"].([]any)
				if unit.Attempts == 1 {
					for _, row := range rows {
						delete(row.(map[string]any), "outcome")
					}
				} else {
					repaired++
				}
			}
			call := cloudAgentCall{}
			call.Function.Name, call.Function.Arguments = productionFlowTool, productionFlowJSON(reply)
			task.Status, task.ResultJSON = model.TaskStatusSucceeded, productionFlowJSON(map[string]any{"toolCalls": []cloudAgentCall{call}})
			if err := db.Save(task).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Fatal("long flow did not publish")
}

func TestProductionFlowRecoveryCheckpointSurvivesReload(t *testing.T) {
	c := productionFlowControl{Scope: "story:v1", Window: 8, RetrySpent: 6, RetryBudget: 6, TotalRetries: 30}
	if !c.recover(time.Now()) {
		t.Fatal(c)
	}
	var loaded productionFlowControl
	if err := json.Unmarshal([]byte(productionFlowJSON(c)), &loaded); err != nil {
		t.Fatal(err)
	}
	if loaded.RecoveryRounds != 1 || loaded.TotalRetries != 30 || loaded.limit(8, time.Now()) != 0 {
		t.Fatal("restart bypassed recovery fence", loaded)
	}
}
