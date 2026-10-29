package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestProductionValidationProgressRequiresDefectConvergence(t *testing.T) {
	a := cloudAgentValidationIssue{Field: "document.style", Issue: "invalid_section", Message: "错误标题甲"}
	b := cloudAgentValidationIssue{Field: "document.palette", Issue: "required", Message: "缺少色彩"}
	keys := productionValidationProblems([]cloudAgentValidationIssue{a, b}, "")
	a.Message = "错误标题乙"
	if productionHash(keys) != productionHash(productionValidationProblems([]cloudAgentValidationIssue{b, a, a}, "")) {
		t.Fatal("wording, duplicate diagnostics or order changed unresolved problem identity")
	}
	counts, repeated := productionTrackValidationProblems(keys, nil)
	if repeated != 1 {
		t.Fatal(repeated)
	}
	reduced := productionValidationProblems([]cloudAgentValidationIssue{a}, "")
	counts, repeated = productionTrackValidationProblems(reduced, counts)
	if repeated != 1 || len(counts) != 2 {
		t.Fatal("a resolved field was not progress", counts, repeated)
	}
	other := productionValidationProblems([]cloudAgentValidationIssue{b}, "")
	counts, _ = productionTrackValidationProblems(other, counts)
	counts, _ = productionTrackValidationProblems(reduced, counts)
	counts, _ = productionTrackValidationProblems(other, counts)
	_, repeated = productionTrackValidationProblems(reduced, counts)
	if repeated != cloudAgentToolAttemptLimit {
		t.Fatal("alternating issues reset correction allowance", repeated)
	}
	counts, _ = productionTrackValidationProblems(keys, nil)
	counts, _ = productionTrackValidationProblems(reduced, counts)
	counts, _ = productionTrackValidationProblems(keys, counts)
	counts, _ = productionTrackValidationProblems(reduced, counts)
	counts, _ = productionTrackValidationProblems(keys, counts)
	_, repeated = productionTrackValidationProblems(reduced, counts)
	if repeated != cloudAgentToolAttemptLimit {
		t.Fatal("reintroducing a resolved issue reset subset progress", repeated)
	}
	counts = nil
	for _, current := range [][]string{reduced, keys, other, keys, reduced, keys, other, keys} {
		counts, repeated = productionTrackValidationProblems(current, counts)
	}
	if repeated < cloudAgentToolAttemptLimit {
		t.Fatal("three-set oscillation reset progress", repeated)
	}
	var history []string
	counts = nil
	for i := 0; i < 40; i++ {
		counts, repeated = productionTrackValidationProblems([]string{fmt.Sprint(i)}, counts, &history)
		if repeated != 1 {
			t.Fatal("distinct fixes inherited a total cap")
		}
	}
	if len(history) != 32 || len(counts) != 32 {
		t.Fatal("recent correction history is not bounded", history, counts)
	}
}

func TestProductionParallelDifferentDefectsDoNotShareTotalValidationCap(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	for attempt := 0; attempt < productionParallelTransientRetries+2; attempt++ {
		task, _ := s.repo.Task(work.TaskID)
		task.Status = model.TaskStatusSucceeded
		if err := db.Save(task).Error; err != nil {
			t.Fatal(err)
		}
		failure := cloudAgentValidationErrors(
			cloudAgentFieldError(fmt.Sprintf("document.field%d", attempt), "required", "当前字段需要补齐"),
			cloudAgentFieldError(fmt.Sprintf("document.other%d", attempt), "invalid_section", "当前标题需要修正"),
		)
		if err := s.recordProductionParallelFailure("user", runID, work, task, failure, true); err != nil {
			t.Fatal(err)
		}
		_, state := productionRuntimeState(t, s, runID)
		work = state.ProductionParallel[work.Key]
		if work.Error != "" || work.TaskID != "" || len(work.ValidationIssues) != 2 {
			t.Fatal("different defects exhausted an unrelated total counter", work)
		}
		if attempt < productionParallelTransientRetries+1 {
			work = enqueueDocumentPart(t, s, runID, "visual")
			next, _ := s.repo.Task(work.TaskID)
			if !strings.Contains(next.InputJSON, "validationIssues") {
				t.Fatal("next correction omitted the complete issue list")
			}
		}
	}
}

func TestProductionParallelUnrelatedEditsDoNotResetUnresolvedDefects(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	for attempt := 1; attempt <= cloudAgentToolAttemptLimit; attempt++ {
		document := orderedPlanDocument("visual", "")
		document["_note"] = "不能丢弃的未归档要求。"
		document["style"] = fmt.Sprintf("第%d次改变无关的合法美术正文。", attempt)
		settleDocumentReply(t, s, db, runID, work, map[string]any{"key": work.Key, "name": work.Name, "document": document, "factIds": []string{}})
		_, state := productionRuntimeState(t, s, runID)
		work = state.ProductionParallel[work.Key]
		if work.RepeatedValidationFailures != attempt {
			t.Fatal("unrelated edits reset unresolved defects", work)
		}
		if attempt < cloudAgentToolAttemptLimit {
			if work.Error != "" {
				t.Fatal("stopped before correction allowance", work)
			}
			work = enqueueDocumentPart(t, s, runID, "visual")
		} else if work.Error == "" || work.Notice == nil || work.Notice.Severity != "warning" {
			t.Fatal("same unresolved defects did not stop as pending warning", work)
		}
	}
}

func TestProductionReadCycleUsesCompleteIssueSetsAndDetectsOscillation(t *testing.T) {
	for _, mode := range []string{"shrinking", "alternating", "subset oscillation", "three-set oscillation", "wording", "truncated report"} {
		t.Run(mode, func(t *testing.T) {
			s, db, run := planFixture(t, 2)
			_, state := productionRuntimeState(t, s, run.ID)
			checkpoint := "current-checkpoint"
			base := time.Now().Add(-time.Minute)
			for i := 0; i < 9; i++ {
				call := productionRuntimeCall("production_submit")
				call.ID = fmt.Sprintf("repair-call-%d", i)
				call.Function.Arguments = fmt.Sprintf(`{"document":{"unrelated":"revision %d"}}`, i)
				var issues []cloudAgentValidationIssue
				if mode == "shrinking" {
					for j := i; j < 10; j++ {
						issues = append(issues, cloudAgentValidationIssue{Field: fmt.Sprintf("document.field%d", j), Issue: "required", Message: "请补齐"})
					}
				} else {
					field := "document.style"
					if mode == "alternating" && i%2 == 1 {
						field = "document.palette"
					}
					issues = []cloudAgentValidationIssue{{Field: field, Issue: "invalid_section", Message: fmt.Sprintf("标题修订%d", i)}}
					if mode == "subset oscillation" && i%2 == 0 {
						issues = append(issues, cloudAgentValidationIssue{Field: "document.palette", Issue: "required", Message: "缺失色彩"})
					}
					if mode == "three-set oscillation" {
						if i%4 == 1 || i%4 == 3 {
							issues = append(issues, cloudAgentValidationIssue{Field: "document.palette", Issue: "required"})
						}
						if i%4 == 2 {
							issues = []cloudAgentValidationIssue{{Field: "document.palette", Issue: "required"}}
						}
					}
				}
				input, _ := json.Marshal(productionRuntimeStepInput{Checkpoint: checkpoint, Recovery: &productionRuntimeRecovery{RepairAttempts: 1, ValidationProblems: []string{"existing"}}})
				task := model.Task{ID: fmt.Sprintf("repair-step-%d", i), UserID: "user", ProjectID: "agent-canvas", Operation: cloudAgentStepOperation, Type: "canvas_text", Status: model.TaskStatusSucceeded, InputJSON: string(input), ResultJSON: productionRuntimeResult(t, call), CreatedAt: base.Add(time.Duration(i) * time.Second)}
				if err := db.Create(&task).Error; err != nil {
					t.Fatal(err)
				}
				state.TaskIDs = append(state.TaskIDs, task.ID)
				receipt := map[string]any{"validationIssues": issues, "reason": "invalid_tool_arguments", "requiredAction": "fix_arguments", "retryable": true}
				if mode == "truncated report" {
					receipt["validationProblemSignature"] = fmt.Sprintf("complete-set-%d", i)
				}
				state.event(run.ID, "production_validation", map[string]any{"callId": call.ID, "toolName": call.Function.Name, "result": receipt})
			}
			recovery, err := productionRuntimeReadCycle(s.repo, "user", &state, checkpoint)
			if mode == "shrinking" || mode == "truncated report" {
				if err != nil || recovery == nil || recovery.RepairAttempts != 1 {
					t.Fatal("shrinking issue sets hit a global repair cap", recovery, err)
				}
			} else if !errors.Is(err, errProductionRuntimeNoProgress) {
				t.Fatal("unresolved issue churn was accepted", recovery, err)
			}
		})
	}
}

func TestProductionCompactToolJournalRetainsBoundedValidationReport(t *testing.T) {
	var failures []error
	for i := 0; i < 200; i++ {
		failures = append(failures, cloudAgentFieldError(fmt.Sprintf("assets[%d].name", i), "required", strings.Repeat("需要补齐独立资产名称。", 8)))
	}
	result := map[string]any{"largeOtherResult": strings.Repeat("x", 40000), "retry": map[string]any{"terminal": false, "status": "retrying"}}
	cloudAgentValidationReceipt(result, cloudAgentValidationErrors(failures...))
	payload := map[string]any{"result": result}
	productionCompactToolJournal(productionRuntimeCall("production_plan_inventory"), result, payload)
	summary := payload["result"].(map[string]any)
	for _, key := range []string{"validationIssues", "validationIssueCount", "validationIssuesIncluded", "validationIssuesOmitted", "validationReportComplete", "validationScope", "validationProblemSignature", "retry"} {
		if _, exists := summary[key]; !exists {
			t.Fatal("compaction omitted validation contract", key)
		}
	}
	if summary["validationIssueCount"] != 200 || summary["validationReportComplete"] != false || summary["validationProblemSignature"] != result["validationProblemSignature"] {
		t.Fatal("partial diagnostics pretended to be complete", summary)
	}
	encoded, _ := json.Marshal(summary)
	if len(encoded) > 32768 {
		t.Fatal("compacted validation report exceeded event budget", len(encoded))
	}
}
