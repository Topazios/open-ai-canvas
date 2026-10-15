package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestProductionAgentNoTaskBudgetStillBillsAndChecksBalance(t *testing.T) {
	for _, scenario := range []string{"production", "ordinary", "empty-wallet"} {
		t.Run(scenario, func(t *testing.T) {
			s, db, view := productionFixture(t)
			run, _ := s.repo.CloudAgent("user", view.ID)
			state, _ := cloudAgentDecode(run)
			state.Request.Budget.MaxCredits = 0
			if scenario == "ordinary" {
				state.Request.Production = nil
			}
			if scenario == "empty-wallet" {
				if err := db.Model(&model.CreditAccount{}).Where("user_id = ?", "user").Update("available_microcredits", 0).Error; err != nil {
					t.Fatal(err)
				}
			}
			req := creationTextRequest()
			req.ProjectID, req.Operation = "agent-canvas", cloudAgentStepOperation
			req.Input["agentRequests"] = map[string]any{"canonical": state.Canonical}
			err := s.enqueueCloudAgentTask(run, &state, req, nil)
			if scenario != "production" {
				if err == nil {
					t.Fatal("account or ordinary budget bypassed")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			task, err := s.repo.TaskForUser("user", state.ActiveTaskID)
			if err != nil || task.BillingOrderID == "" || task.AuthorizedChargeMicrocredits != 100 {
				t.Fatal("production step became free", task, err)
			}
		})
	}
}

func TestProductionAgentRequestAllowsNoBudgetOnlyForProduction(t *testing.T) {
	req := agentTestRequest()
	req.PermissionMode = "auto"
	req.Production = &ProductionAgentRequest{TargetNodeID: "target"}
	req.Budget.MaxSteps, req.Budget.MaxCredits = 0, 0
	if err := validateCloudAgentRequest(&req); err != nil {
		t.Fatal(err)
	}
	state := cloudAgentRuntime{Request: req, Step: 10001, ProductionStepLimit: 120}
	if cloudAgentStepBudgetExhausted(&state) {
		t.Fatal("legacy limit stopped production")
	}
	req.Production = nil
	if err := validateCloudAgentRequest(&req); err == nil {
		t.Fatal("ordinary budget validation removed")
	}
}

func TestProductionAgentCanContinuePastLegacyNoProgressWindow(t *testing.T) {
	req := agentTestRequest()
	req.Production = &ProductionAgentRequest{TargetNodeID: "target"}
	state := cloudAgentRuntime{Request: req, Step: 97, ProductionProgressStep: 85}
	if cloudAgentStepBudgetExhausted(&state) {
		t.Fatal("production step budget must remain unlimited")
	}
	// The old scheduler stopped this state at step 97. The production path now
	// relies on persisted nextAction/coverage checks instead of that fixed gate.
	if state.Step-state.ProductionProgressStep < 12 {
		t.Fatal("test does not cover the retired no-progress window")
	}
}

func TestProductionAgentQueryProgressAndContinuationCursor(t *testing.T) {
	s, _, run := productionFixture(t)
	page := productionFirstPage(t, s, run.ID)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": page}, false)
	facts := []workflowFact{}
	for i := 0; i < 100; i++ {
		facts = append(facts, workflowFact{Kind: "character", Name: "林岚", Description: fmt.Sprintf("事实%d", i), Evidence: "林岚提着旧相机走进照相馆。"})
	}
	productionCall(t, s, run.ID, "production_facts", map[string]any{"pageId": page, "facts": facts}, false)
	setStep := func(step int) {
		execution, _ := s.repo.CloudAgent("user", run.ID)
		if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
			state, _ := cloudAgentDecode(current)
			state.Step = step
			return cloudAgentSave(current, &state)
		}); err != nil {
			t.Fatal(err)
		}
	}
	offset := 0
	step := 0
	for {
		step++
		setStep(step)
		result := productionCall(t, s, run.ID, "production_query", map[string]any{"kind": "character", "offset": offset}, false)
		batch, ok := result["facts"].([]any)
		if !ok || len(batch) == 0 || len(batch) > productionFactQueryMaxItems {
			t.Fatalf("unexpected query batch: %#v", result)
		}
		execution, _ := s.repo.CloudAgent("user", run.ID)
		state, _ := cloudAgentDecode(execution)
		if state.ProductionProgressStep != step {
			t.Fatal("new query page not progress")
		}
		nextAction := result["nextAction"].(map[string]any)
		if nextAction["tool"] == "production_check" {
			break
		}
		nextOffset := int(result["nextOffset"].(float64))
		if nextOffset <= offset {
			t.Fatalf("cursor did not advance: %d -> %d", offset, nextOffset)
		}
		offset = nextOffset
	}
	job, _ := s.repo.ProductionAgentJob("user", run.ID)
	var manifest productionManifest
	if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.QueryCursors["character"] != 100 || len(manifest.Queried) != 0 {
		t.Fatalf("facts query state was not compacted: %#v", manifest)
	}
	setStep(step + 1)
	productionCall(t, s, run.ID, "production_query", map[string]any{"kind": "character", "offset": 0}, false)
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	if state.ProductionProgressStep != step {
		t.Fatal("repeated query falsely counted as progress")
	}
}

func TestProductionAgentCoverageFinishesWithoutAnotherModelCall(t *testing.T) {
	s, db, run := productionFixture(t)
	id := productionExtractFixture(t, s, run.ID)
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "林岚", "name": "林岚", "document": productionTestDocument(), "factIds": []string{id}}, false)
	productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	var before, after int64
	db.Model(&model.Task{}).Count(&before)
	result, retryable, err := s.runCloudAgentModelStep(context.Background(), "user", run.ID, []map[string]any{{"role": "user", "content": "继续"}}, "medium")
	db.Model(&model.Task{}).Count(&after)
	if err != nil || retryable || before != after {
		t.Fatal("completion dispatched another model", err)
	}
	if !strings.Contains(result.(map[string]any)["text"].(string), "覆盖检查通过") {
		t.Fatal(result)
	}
}

func TestProductionAgentFactsRepairIsActionableAndAtomic(t *testing.T) {
	s, _, run := productionFixture(t)
	page := productionFirstPage(t, s, run.ID)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": page}, false)
	facts := []workflowFact{{Kind: "character", Name: "林岚", Description: "回到照相馆", Evidence: "林岚提着旧相机走进照相馆。"}, {Kind: "environment", Name: "照相馆", Description: "地点", Evidence: "这是另一个页面的句子"}}
	failure := productionCall(t, s, run.ID, "production_facts", map[string]any{"pageId": page, "facts": facts}, true)
	if failure["requiredAction"] != "fix_arguments" || !strings.Contains(stringValue(failure["error"]), "第 2") {
		t.Fatalf("unactionable feedback: %#v", failure)
	}
	stored, _ := s.repo.ProductionAgentPage("user", page)
	if stored.Processed {
		t.Fatal("invalid page partially committed")
	}
	facts[1].Evidence = facts[0].Evidence
	result := productionCall(t, s, run.ID, "production_facts", map[string]any{"pageId": page, "facts": facts}, false)
	next := result["nextAction"].(map[string]any)
	if next["tool"] != "production_query" {
		t.Fatal(next)
	}
	stored, _ = s.repo.ProductionAgentPage("user", page)
	before := stored.FactsJSON
	productionCall(t, s, run.ID, "production_facts", map[string]any{"pageId": page, "facts": []workflowFact{}}, false)
	stored, _ = s.repo.ProductionAgentPage("user", page)
	if stored.FactsJSON != before {
		t.Fatal("replay overwrote saved facts")
	}
}

func TestProductionAgentContinuationUsesCompletionInsteadOfLegacyBudget(t *testing.T) {
	s, _, run := productionFixture(t)
	productionExtractFixture(t, s, run.ID)
	execution, _ := s.repo.CloudAgent("user", run.ID)
	if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, _ := cloudAgentDecode(current)
		state.Step = 40
		current.Status = "failed"
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ControlProductionAgent("other", run.ID, "resume", 100); err == nil {
		t.Fatal("foreign resume")
	}
	for i := 0; i < 2; i++ {
		if err := s.ControlProductionAgent("user", run.ID, "resume"); err != nil {
			t.Fatal(err)
		}
	}
	execution, _ = s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	if state.Step != 40 || state.Request.Budget.MaxSteps != 40 || productionStepLimit(&state) != 0 || cloudAgentStepBudgetExhausted(&state) {
		t.Fatal("budget reset or double extension", state.Step, state.ProductionStepLimit)
	}
	if state.ProductionProgressStep != 40 {
		t.Fatal("continuation retained old no-progress window")
	}
	view, err := s.CloudAgentRun("user", run.ID)
	if err != nil || view.Production.ProcessedPages != 1 || view.Production.MaxSteps != 0 {
		t.Fatal("progress not retained", err)
	}
}

func TestProductionAgentRepairAdvancesNextUnprocessedPage(t *testing.T) {
	s, _, run := productionFixture(t, strings.Repeat("林岚走进照相馆。\n", 700))
	job, _ := s.repo.ProductionAgentJob("user", run.ID)
	var manifest productionManifest
	_ = json.Unmarshal([]byte(job.ManifestJSON), &manifest)
	pages := manifest.Sources[0].Pages
	for _, id := range pages {
		call, err := s.productionRepairCall("user", run.ID, "fixture")
		if err != nil || call.Function.Name != "production_read" || !strings.Contains(call.Function.Arguments, id) {
			t.Fatal("repair did not advance", call, err)
		}
		productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": id}, false)
		productionCall(t, s, run.ID, "production_facts", map[string]any{"pageId": id, "facts": []workflowFact{{Kind: "character", Name: "林岚", Description: "走进照相馆", Evidence: "林岚走进照相馆。"}}}, false)
	}
	call, err := s.productionRepairCall("user", run.ID, "fixture")
	if err != nil || call.Function.Name != "production_query" {
		t.Fatal("facts phase did not complete", err)
	}
}

func TestProductionAgentNoProgressDoesNotUseLegacyGuard(t *testing.T) {
	s, _, run := productionFixture(t)
	execution, _ := s.repo.CloudAgent("user", run.ID)
	if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, _ := cloudAgentDecode(current)
		state.Step = 12
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	execution, _ = s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	if cloudAgentStepBudgetExhausted(&state) {
		t.Fatal("legacy no-progress window still acts as a production budget")
	}
	call, err := s.productionRepairCall("user", run.ID, "fixture")
	if err != nil || call.Function.Name != "production_read" {
		t.Fatal("production continuation did not use persisted next action", call, err)
	}
}

func TestProductionAgentJournalEarlierPagesAreComplete(t *testing.T) {
	s, _, run := productionFixture(t)
	growAgentJournal(t, s, run.ID, 650)
	view, err := s.CloudAgentRun("user", run.ID, CloudAgentRunViewOptions{EventLimit: 100})
	if err != nil {
		t.Fatal(err)
	}
	count := len(view.Events)
	first := view.Events[0].Seq
	for first > 1 {
		older, err := s.CloudAgentRun("user", run.ID, CloudAgentRunViewOptions{BeforeSeq: first, EventLimit: 100})
		if err != nil || len(older.Events) == 0 {
			t.Fatal("missing history", first, err)
		}
		if older.Events[len(older.Events)-1].Seq != first-1 {
			t.Fatal("journal gap")
		}
		count += len(older.Events)
		first = older.Events[0].Seq
	}
	if count != 650 {
		t.Fatal("incomplete journal", count)
	}
	if _, err := s.CloudAgentRun("other", run.ID, CloudAgentRunViewOptions{BeforeSeq: 100}); err == nil {
		t.Fatal("foreign journal exposed")
	}
}
