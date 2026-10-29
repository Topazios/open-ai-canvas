package app

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestProductionParallelLocalValidationKeepsExecutionSuccessAndRecovers(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	run, state := productionRuntimeState(t, s, runID)
	m, doc, artifacts := orderedPlanState(t, s, runID)
	work := productionParallelReady(m, doc, artifacts)[0]
	if err := s.enqueueProductionParallel(run, &state, m, doc, artifacts, work); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	work = state.ProductionParallel[work.Key]
	fields := orderedPlanDocument(work.Key, "")
	fields["unsupported"] = "需要合并到合法章节的内容"
	args, _ := json.Marshal(map[string]any{"key": work.Key, "name": work.Name, "factIds": []string{}, "expectedHash": "", "document": fields})
	call := productionRuntimeCall("production_submit")
	call.Function.Arguments = string(args)
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": productionRuntimeResult(t, call)}).Error; err != nil {
		t.Fatal(err)
	}
	task, _ := s.repo.Task(work.TaskID)
	if err := s.settleProductionParallel("user", runID, work, task); err != nil {
		t.Fatal(err)
	}
	run, state = productionRuntimeState(t, s, runID)
	work = state.ProductionParallel[work.Key]
	if work.ValidationRepair == nil || work.ValidationRepair.Attempt != 1 || work.Error != "" {
		t.Fatalf("local correction was not checkpointed: %+v", work)
	}
	groupID := work.ValidationRepair.GroupID
	modelSuccess, validationPending := false, false
	for _, event := range state.Events {
		if stringValue(event.Payload["taskId"]) != task.ID {
			continue
		}
		if event.Type == "production_model_completed" {
			if stringValue(event.Payload["status"]) != string(model.TaskStatusSucceeded) {
				t.Fatalf("local validation changed execution success: %+v", event.Payload)
			}
			modelSuccess = true
		}
		if event.Type == "production_validation" && event.Payload["phase"] == "validation" && stringValue(event.Payload["retry"].(map[string]any)["status"]) == "retrying" {
			retry, _ := event.Payload["retry"].(map[string]any)
			if event.Payload["errorSource"] != "application" || retry["groupId"] != groupID || retry["status"] != "retrying" || retry["terminal"] != false {
				t.Fatalf("missing local correction facts: %+v", event.Payload)
			}
			validationPending = true
		}
	}
	if !modelSuccess || !validationPending {
		t.Fatalf("missing execution/correction events: success=%v pending=%v", modelSuccess, validationPending)
	}
	storedTask, _ := s.repo.Task(task.ID)
	if storedTask.Status != model.TaskStatusSucceeded || storedTask.Error != "" {
		t.Fatalf("local validation mutated provider task: %+v", storedTask)
	}
	// Reload the durable checkpoint before dispatching the correction.
	m, doc, artifacts = orderedPlanState(t, s, runID)
	if err := s.enqueueProductionParallel(run, &state, m, doc, artifacts, work); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	work = state.ProductionParallel[work.Key]
	completeParallel(t, db, work)
	task, _ = s.repo.Task(work.TaskID)
	if err := s.settleProductionParallel("user", runID, work, task); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	for _, event := range state.Events {
		if event.Type != "production_validation" || event.Payload["phase"] != "validation" {
			continue
		}
		retry, _ := event.Payload["retry"].(map[string]any)
		if retry["groupId"] == groupID && retry["status"] == "recovered" && retry["terminal"] == false {
			return
		}
	}
	t.Fatal("saved correction did not recover its original validation group")
}

func TestProductionParallelProviderFailureRemainsFailedWithoutLocalRepair(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	run, state := productionRuntimeState(t, s, runID)
	m, doc, artifacts := orderedPlanState(t, s, runID)
	work := productionParallelReady(m, doc, artifacts)[0]
	if err := s.enqueueProductionParallel(run, &state, m, doc, artifacts, work); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	work = state.ProductionParallel[work.Key]
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "上游连接中断"}).Error; err != nil {
		t.Fatal(err)
	}
	task, _ := s.repo.Task(work.TaskID)
	if err := s.settleProductionParallel("user", runID, work, task); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	for _, event := range state.Events {
		if event.Payload["taskId"] != task.ID {
			continue
		}
		if event.Payload["phase"] == "validation" {
			t.Fatalf("provider failure was relabeled as local validation: %+v", event)
		}
		if event.Type == "production_model_completed" && stringValue(event.Payload["status"]) == string(model.TaskStatusFailed) {
			return
		}
	}
	t.Fatal("provider failure lost its failed execution event")
}

func TestProductionParallelLocalValidationExhaustionRemainsApplicationFailure(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	m, doc, artifacts := orderedPlanState(t, s, runID)
	work := productionParallelReady(m, doc, artifacts)[0]
	for attempt := 1; attempt <= cloudAgentToolAttemptLimit; attempt++ {
		run, state := productionRuntimeState(t, s, runID)
		if previous, ok := state.ProductionParallel[work.Key]; ok {
			work = previous
		}
		if err := s.enqueueProductionParallel(run, &state, m, doc, artifacts, work); err != nil {
			t.Fatal(err)
		}
		_, state = productionRuntimeState(t, s, runID)
		work = state.ProductionParallel[work.Key]
		if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded}).Error; err != nil {
			t.Fatal(err)
		}
		task, _ := s.repo.Task(work.TaskID)
		failure := cloudAgentFieldError("document.prompt", "invalid_section", "字段正文不能使用二级标题")
		if err := s.recordProductionParallelFailure("user", runID, work, task, failure, true); err != nil {
			t.Fatal(err)
		}
	}
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel[work.Key]
	if work.Error == "" || work.ValidationRepair == nil {
		t.Fatalf("exhaustion did not retain local correction evidence: %+v", work)
	}
	for i := len(state.Events) - 1; i >= 0; i-- {
		event := state.Events[i]
		if event.Type != "production_validation" || event.Payload["phase"] != "validation" {
			continue
		}
		retry, _ := event.Payload["retry"].(map[string]any)
		if event.Payload["errorSource"] != "application" || retry["status"] != "exhausted" || retry["terminal"] != true {
			t.Fatalf("exhaustion was not classified as local validation: %+v", event.Payload)
		}
		return
	}
	t.Fatal("exhausted local correction event is missing")
}

func TestProductionParallelLocalValidationRecoversOnlyAfterCompleteDocumentSave(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ForceThinkingOff = true })
	work := enqueueDocumentPart(t, s, runID, "visual")
	failDocumentPart(t, s, db, runID, work)
	work = enqueueDocumentPart(t, s, runID, "visual")
	if work.DocumentParts == nil || len(work.DocumentParts.Pending) < 2 {
		t.Fatalf("output-limit recovery did not create multiple batches: %+v", work.DocumentParts)
	}
	settleDocumentReply(t, s, db, runID, work, map[string]any{
		"key": work.Key, "name": work.Name, "factIds": []string{}, "expectedHash": "",
		"document": map[string]string{"unsupported": "本批不允许的字段"},
	})
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if work.ValidationRepair == nil {
		t.Fatal("rejected batch did not retain its validation group")
	}
	groupID := work.ValidationRepair.GroupID
	work = enqueueDocumentPart(t, s, runID, "visual")
	finishDocumentPart(t, s, db, runID, work)
	_, state = productionRuntimeState(t, s, runID)
	work, pending := state.ProductionParallel["visual"]
	if !pending || work.DocumentParts == nil || len(work.DocumentParts.Fields) == 0 || work.ValidationRepair == nil || work.ValidationRepair.GroupID != groupID {
		t.Fatalf("staged chapters prematurely closed the validation group: %+v", work)
	}
	for _, event := range state.Events {
		retry, _ := event.Payload["retry"].(map[string]any)
		if event.Type == "production_validation" && event.Payload["phase"] == "validation" && retry["status"] == "recovered" {
			t.Fatalf("staged chapters emitted recovery before full validation: %+v", event)
		}
	}
	for batch := 0; batch < 64 && pending; batch++ {
		work = enqueueDocumentPart(t, s, runID, "visual")
		finishDocumentPart(t, s, db, runID, work)
		_, state = productionRuntimeState(t, s, runID)
		_, pending = state.ProductionParallel["visual"]
	}
	if pending {
		t.Fatal("remaining document batches did not finish")
	}
	m, doc, artifacts := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, artifacts, "visual") {
		t.Fatal("complete merged document did not pass final validation and save")
	}
	recovered := 0
	for _, event := range state.Events {
		if event.Type != "production_validation" || event.Payload["phase"] != "validation" {
			continue
		}
		retry, _ := event.Payload["retry"].(map[string]any)
		if retry["groupId"] == groupID && retry["status"] == "recovered" {
			recovered++
		}
	}
	if recovered != 1 {
		t.Fatalf("full document save must recover its original group exactly once, got %d", recovered)
	}
}
