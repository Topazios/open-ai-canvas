package app

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestProductionDocumentOutputBudgetHonorsPolicyWithoutInventingLargerLimit(t *testing.T) {
	for _, cap := range []int{0, 2048, 65536} {
		s, _, run := planFixture(t, 5)
		policy := defaultRuntimePolicy()
		policy.Task.AgentStepMaxOutputTokens = cap
		if _, err := s.UpdateRuntimePolicySetting(&model.User{ID: "admin", Role: model.UserRoleAdmin}, policy); err != nil {
			t.Fatal(err)
		}
		productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
		work := enqueueDocumentPart(t, s, run.ID, "story")
		task, err := s.repo.Task(work.TaskID)
		if err != nil {
			t.Fatal(err)
		}
		want := cap
		if got := stepTaskTextOptions(t, s, task)["maxOutputTokens"]; got != float64(want) {
			t.Fatalf("policy %d: document output budget = %v, want %d", cap, got, want)
		}
	}
}

func TestProductionAutomaticRetryKeepsAcceptedChaptersAndThinkingOff(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	failDocumentPart(t, s, db, runID, work)
	work = enqueueDocumentPart(t, s, runID, "visual")
	finishDocumentPart(t, s, db, runID, work)
	_, state := productionRuntimeState(t, s, runID)
	before := state.ProductionParallel["visual"]
	if len(before.DocumentParts.Fields) == 0 {
		t.Fatal("fixture did not stage chapters")
	}
	mutateParallelState(t, s, runID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		item := state.ProductionParallel["visual"]
		item.QuietHold, item.Error = true, "output incomplete"
		state.ProductionParallel["visual"] = item
	})
	after := escalateItem(t, s, runID, "visual")
	if productionHash(after.DocumentParts) != productionHash(before.DocumentParts) || !after.DisableThinking || after.AutoRetryRounds != 1 || after.QuietHold || after.Error != "" {
		t.Fatalf("automatic round lost progress or recovery settings: %+v", after)
	}
}

func TestProductionExhaustedStoryBecomesTerminalWithAccurateWarning(t *testing.T) {
	s, _, run := planFixture(t, 5)
	message := "故事总纲的章节 facts 达到输出上限，已停止自动重试"
	mutateParallelState(t, s, run.ID, func(current *model.CloudAgentExecution, state *cloudAgentRuntime) {
		current.Status = "running"
		state.ProductionParallel["story"] = productionParallelWork{
			Key: "story", Name: "故事总纲", QuietHold: true, Error: message, AutoRetryRounds: productionParallelAutoRetryRounds,
			Notice: &model.TaskExecutionDiagnostic{Severity: "warning", ErrorSource: "content", Phase: "content", Code: providerOutputLimitCode, SafeMessage: message, Outcome: "incomplete"},
		}
	})
	s.failPiRunner(run.ID, "user", BadAuthRequest(message))
	stored, state := productionRuntimeState(t, s, run.ID)
	if stored.Status != "failed" || !strings.Contains(stored.FailureMessage, "facts") {
		t.Fatalf("exhausted story left recoverable running state: %s %s", stored.Status, stored.FailureMessage)
	}
	count := len(state.Events)
	s.failPiRunner(run.ID, "user", BadAuthRequest(message))
	_, state = productionRuntimeState(t, s, run.ID)
	if len(state.Events) != count {
		t.Fatal("terminal callback emitted another failure")
	}
	progress := s.productionAgentProgress("user", run.ID, &state)
	if len(progress.ParallelItems) != 1 {
		t.Fatal("missing failed item")
	}
	item := progress.ParallelItems[0]
	if item.Message != message || item.Code != providerOutputLimitCode || len(item.ValidationIssues) != 0 {
		t.Fatalf("output cap was misreported as local validation: %+v", item)
	}
}
