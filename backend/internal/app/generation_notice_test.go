package app

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestGenerationNoticeSeparatesContentAndLocalProcessingFromProviderFailure(t *testing.T) {
	for _, tc := range []struct {
		name, phase, outcome, source, delivery string
		cause                                  error
	}{
		{"output_budget", "execution", "accepted", "content", "incomplete", errProviderOutputLimit},
		{"invalid_response", "execution", "accepted", "content", "incomplete", providerResponseDecodeError{Err: errors.New("响应结构不完整")}},
		{"postprocess", "postprocess", "accepted", "application", "not_saved", errors.New("转换未完成")},
		{"storage", "result_persistence", "accepted", "application", "not_saved", errors.New("保存未完成")},
		{"not_sent", "execution", "not_submitted", "application", "not_submitted", errors.New("本地准入待处理")},
		{"preparation_reconcile", "preparation", "unknown", "application", "needs_attention", errors.New("提交记录待核对")},
		{"provider_http", "execution", "accepted", "upstream", "", providerHTTPError{StatusCode: 502, Body: "output_limit_exceeded"}},
		{"provider_payload", "execution", "accepted", "upstream", "", providerPayloadError{message: "API explicitly rejected"}},
		{"unknown", "execution", "unknown", "unknown", "needs_attention", errors.New("unclassified interruption")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			task := &model.Task{ID: "task", Status: model.TaskStatusFailed, Error: "安全提示"}
			recordTaskDiagnostic(task, tc.phase, "provider_execution_failed", tc.outcome, "inspect_execution", tc.cause)
			stored := task.ExecutionDiagnosticJSON
			diagnostic := taskExecutionDiagnostic(task)
			wantWarning := tc.source != "upstream"
			if diagnostic.ErrorSource != tc.source || diagnostic.Outcome != tc.delivery || (diagnostic.Severity == "warning") != wantWarning {
				t.Fatalf("incorrect notice: %+v", diagnostic)
			}
			payload := productionModelCompletedPayload(task, 1, "尚未交付")
			if payload["status"] != model.TaskStatusFailed || (payload["severity"] == "warning") != wantWarning || task.ExecutionDiagnosticJSON != stored {
				t.Fatal("notice hid the scheduler stop, lost severity, or changed the receipt", payload)
			}
		})
	}
}

func TestGenerationToolNoticePreservesExecutionReceipt(t *testing.T) {
	for _, class := range []string{cloudAgentToolErrorSchemaError, cloudAgentToolErrorUnknown, cloudAgentToolErrorExecution, cloudAgentToolErrorUpstream} {
		payload := map[string]any{"phase": "completion", "outcome": "accepted", "taskSubmitted": true}
		generationToolNotice(payload, class)
		if payload["phase"] != "completion" || payload["outcome"] != "accepted" || payload["taskSubmitted"] != true {
			t.Fatal("presentation changed execution safety receipt", payload)
		}
		if class == cloudAgentToolErrorUnknown && payload["errorSource"] != "unknown" {
			t.Fatal("unknown error was attributed to application", payload)
		}
		if class == cloudAgentToolErrorUpstream && payload["severity"] != nil {
			t.Fatal("upstream failure was downgraded", payload)
		}
	}
}

func TestGenerationNoticeProviderExplicitFailurePrecedesContentWarning(t *testing.T) {
	for _, tc := range []struct {
		name, frame string
		upstream    bool
	}{
		{"api_error", "data: {\"error\":{\"code\":\"output_limit_exceeded\",\"message\":\"rejected\"}}\n\n", true},
		{"sse_error", "event: error\ndata: {}\n\n", true},
		{"sse_error_empty", "event: error\ndata:\n\n", true},
		{"sse_error_invalid_json", "event: error\ndata: unavailable\n\n", true},
		{"response_failed", "event: response.failed\ndata: {\"response\":{\"status\":\"failed\"}}\n\n", true},
		{"incomplete", "event: response.incomplete\ndata: {\"response\":{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}}\n\n", false},
		{"other_incomplete", "event: response.incomplete\ndata: {\"response\":{\"status\":\"incomplete\"}}\n\n", false},
		{"invalid_json", "data: {\n\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parser := newStreamingAgentParser("responses", nil)
			parser.consume("text/event-stream", []byte(tc.frame))
			parser.flush()
			_, err := parser.result()
			if err == nil {
				t.Fatal("incomplete response was accepted")
			}
			class, _, _ := cloudAgentToolErrorClass(CloudAgentRequest{}, cloudAgentCall{}, err, true)
			if (class == cloudAgentToolErrorUpstream) != tc.upstream {
				t.Fatalf("class=%s err=%v", class, err)
			}
			task := &model.Task{Status: model.TaskStatusFailed}
			recordTaskDiagnostic(task, "execution", "provider_execution_failed", "unknown", "inspect", err)
			if (taskExecutionDiagnostic(task).Severity == "error") != tc.upstream {
				t.Fatal(taskExecutionDiagnostic(task))
			}
		})
	}
}

func TestGenerationNoticeHistoricalEventsAreOwnerRunScopedAndReadOnly(t *testing.T) {
	s, db, run := planFixture(t, 2)
	for _, task := range []model.Task{
		{ID: "own", UserID: "user", AgentRunID: run.ID, Status: model.TaskStatusFailed, Error: errProviderOutputLimit.Error()},
		{ID: "foreign", UserID: "other", AgentRunID: run.ID, Status: model.TaskStatusFailed, Error: errProviderOutputLimit.Error()},
		{ID: "other-run", UserID: "user", AgentRunID: "another", Status: model.TaskStatusFailed, Error: errProviderOutputLimit.Error()},
		{ID: "unknown", UserID: "user", AgentRunID: run.ID, Status: model.TaskStatusFailed, Error: "unclassified failure"},
	} {
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}
	events := []CloudAgentEvent{}
	for index, id := range []string{"own", "foreign", "other-run", "unknown"} {
		events = append(events, CloudAgentEvent{RunID: run.ID, Seq: index + 1, Type: "production_model_completed", Payload: map[string]any{"taskId": id, "status": "failed"}})
	}
	original, _ := json.Marshal(events)
	copyEvents := append([]CloudAgentEvent{}, events...)
	s.decorateGenerationEventNotices("user", run.ID, copyEvents)
	if copyEvents[0].Payload["severity"] != "warning" || copyEvents[0].Payload["outcome"] != "incomplete" {
		t.Fatal(copyEvents[0])
	}
	for _, event := range copyEvents[1:] {
		if event.Payload["severity"] != nil {
			t.Fatal("unmatched receipt was reclassified", event)
		}
	}
	after, _ := json.Marshal(events)
	if string(original) != string(after) {
		t.Fatal("read projection mutated checkpoint events")
	}
}

func TestGenerationNoticeParallelExhaustionRemainsWarningAndDoesNotSave(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	task, _ := s.repo.Task(work.TaskID)
	task.Status = model.TaskStatusSucceeded
	if err := db.Save(task).Error; err != nil {
		t.Fatal(err)
	}
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel[work.Key]
	work.ValidationAttempts = productionParallelTransientRetries
	failure := cloudAgentFieldError("document", "unknown_fields", "待修正文稿字段")
	work.ValidationProblems = productionValidationProblems(cloudAgentValidationIssues(failure), "")
	work.ValidationProblemCounts = map[string]int{productionHash(work.ValidationProblems): cloudAgentToolAttemptLimit - 1}
	state.ProductionParallel[work.Key] = work
	run, _ := s.repo.CloudAgent("user", runID)
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.recordProductionParallelFailure("user", runID, work, task, failure, true); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	saved := state.ProductionParallel[work.Key]
	if saved.Error == "" || saved.Notice == nil || saved.Notice.Severity != "warning" {
		t.Fatal("correction exhaustion lost warning or incomplete state", saved)
	}
	last := state.Events[len(state.Events)-1]
	if last.Payload["severity"] != "warning" || last.Payload["retry"].(map[string]any)["status"] != "exhausted" {
		t.Fatal(last)
	}
	for _, event := range state.Events {
		if event.Type == "tool_completed" && event.Payload["phase"] == "validation" {
			t.Fatal("incomplete content falsely recovered")
		}
	}
	s.failPiRunner(runID, "user", errors.New("文稿尚未完成"))
	_, state = productionRuntimeState(t, s, runID)
	for _, event := range state.Events {
		if event.Type == "run_failed" {
			last = event
		}
	}
	if last.Type != "run_failed" || last.Payload["severity"] != "warning" || last.Payload["outcome"] != "needs_revision" {
		t.Fatal(last)
	}
	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := creationDocument(canvas.PayloadJSON)
	meta := productionNode(doc, "target")["metadata"].(map[string]any)
	if meta["status"] != "idle" || meta["taskStage"] != "制作 Agent 待处理" || meta["errorDetails"] != nil {
		t.Fatal("content warning was projected as a red failed node", meta)
	}
	notice, _ := meta["generationWarning"].(map[string]any)
	if notice["severity"] != "warning" || notice["outcome"] != "needs_revision" {
		t.Fatal(notice)
	}
}

func TestGenerationNoticeAnalyticsDoesNotCountWarningsAsFailureOrCompletion(t *testing.T) {
	logs := []model.ApiCallLog{
		{Status: model.ApiCallStatusSucceeded, StatusCode: 200, CreatedAt: time.Now()},
		{Status: model.ApiCallStatusFailed, StatusCode: 502, Error: "gateway"},
		{Status: model.ApiCallStatusFailed, StatusCode: 200, ProviderStatus: "incomplete", ErrorCode: providerOutputLimitCode},
		{Status: model.ApiCallStatusWarning, StatusCode: 0, ErrorSource: "application"},
	}
	if successRateLogs(logs) != 50 || len(buildAnalyticsFailures(logs)) != 1 {
		t.Fatal("warnings counted as generated successes or failures")
	}
}

func TestGenerationNoticeHistoricalRuntimeStopsWithoutTaskRemainReadOnlyWarnings(t *testing.T) {
	s, _, run := planFixture(t, 2)
	events := []CloudAgentEvent{
		{RunID: run.ID, Seq: 1, Type: "run_failed", Payload: map[string]any{"reason": "production_no_progress", "error": "旧调度停止"}},
		{RunID: run.ID, Seq: 2, Type: "run_failed", Payload: map[string]any{"reason": "unknown_reason"}},
		{RunID: run.ID, Seq: 3, Type: "run_failed", Payload: map[string]any{"reason": "production_no_progress", "severity": "error", "errorSource": "upstream"}},
		{RunID: "other-run", Seq: 4, Type: "run_failed", Payload: map[string]any{"reason": "production_no_progress"}},
		{RunID: run.ID, Seq: 5, Type: "run_failed", Payload: map[string]any{"reason": "production_no_progress", "errorSource": "network"}},
	}
	before, _ := json.Marshal(events)
	projected := append([]CloudAgentEvent{}, events...)
	s.decorateGenerationEventNotices("user", run.ID, projected)
	if projected[0].Payload["severity"] != "warning" || projected[0].Payload["errorSource"] != "application" {
		t.Fatal("old successful-model scheduler stop remained an error", projected[0])
	}
	for i := 1; i < len(events); i++ {
		want, _ := json.Marshal(events[i])
		got, _ := json.Marshal(projected[i])
		if string(want) != string(got) {
			t.Fatal("unproven or explicit failure was downgraded", projected[i])
		}
	}
	after, _ := json.Marshal(events)
	if string(before) != string(after) {
		t.Fatal("read projection changed historical checkpoint")
	}
	state := cloudAgentRuntime{Events: events[:1]}
	if notice := generationRunWarning(s.repo, &state, run.ID); notice["severity"] != "warning" {
		t.Fatal("top-level run detail lost historical warning", notice)
	}
	state.Events = append(state.Events, CloudAgentEvent{RunID: run.ID, Seq: 6, Type: "run_completed", Payload: map[string]any{}})
	if notice := generationRunWarning(s.repo, &state, run.ID); notice != nil {
		t.Fatal("new successful terminal inherited stale warning", notice)
	}
}
