package app

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestProductionBoundSubmissionOmitsCopiedMetadataAndSurvivesRestart(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	task, _ := s.repo.Task(work.TaskID)
	var input map[string]any
	_ = json.Unmarshal([]byte(task.InputJSON), &input)
	canonical := stateCanonicalFromInput(input)
	parameters := canonical.Tools[0]["function"].(map[string]any)["parameters"].(map[string]any)
	properties := parameters["properties"].(map[string]any)
	for _, field := range []string{"key", "name", "factIds", "expectedHash"} {
		if _, exists := properties[field]; exists {
			t.Fatalf("model was asked to copy server-owned %s", field)
		}
	}
	if !work.ServerBoundArguments || work.TargetHash == nil {
		t.Fatal("queued work did not retain its binding contract")
	}
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel[work.Key]
	settleDocumentReply(t, s, db, runID, work, map[string]any{"document": orderedPlanDocument(work.Key, "")})
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, work.Key) {
		t.Fatal("content-only reply did not pass normal save validation after restart")
	}
	task, _ = s.repo.Task(work.TaskID)
	if task.Status != model.TaskStatusSucceeded || strings.Contains(task.ResultJSON, "expectedHash") {
		t.Fatal("binding changed the original upstream receipt")
	}
}

func TestProductionBoundSubmissionUsesCheckpointIdentityAndPreservesContent(t *testing.T) {
	hash := "target-revision"
	for _, key := range []string{"visual", "direction", "character", "environment", "prop", "sound"} {
		work := productionParallelWork{Key: key, Name: "任意名称 / Any title", TargetHash: &hash, ServerBoundArguments: true}
		call := productionRuntimeCall("production_submit")
		call.Function.Arguments = `{"document":{"facts":"原文与原有风格保持不变"},"design":{"sounds":["voice"]}}`
		bound, err := productionBindDocumentCall(work, call)
		if err != nil || productionParallelCallError(work, bound, "production_submit") != nil {
			t.Fatalf("generic identity binding failed for %s: %v", key, err)
		}
		var args map[string]json.RawMessage
		_ = json.Unmarshal([]byte(bound.Function.Arguments), &args)
		if string(args["document"]) != `{"facts":"原文与原有风格保持不变"}` || string(args["design"]) != `{"sounds":["voice"]}` {
			t.Fatal("binding rewrote authored content or design")
		}
		call.Function.Arguments = `{"key":"another-item","document":{"facts":"原稿"}}`
		bound, err = productionBindDocumentCall(work, call)
		if err != nil || productionParallelCallError(work, bound, "production_submit") != nil {
			t.Fatalf("checkpoint identity did not replace stale model metadata: %v", err)
		}
		_ = json.Unmarshal([]byte(bound.Function.Arguments), &args)
		if string(args["key"]) != `"`+key+`"` || string(args["name"]) != `"`+work.Name+`"` || string(args["expectedHash"]) != `"`+hash+`"` || string(args["factIds"]) != `[]` {
			t.Fatalf("server-owned arguments were not canonicalized: %s", bound.Function.Arguments)
		}
		if !strings.Contains(string(args["document"]), `"原稿"`) {
			t.Fatal("binding changed the model-authored document")
		}
	}
	legacy := productionParallelWork{Key: "visual", Name: "任意名称", TargetHash: &hash}
	call := productionRuntimeCall("production_submit")
	call.Function.Arguments = `{"document":{"facts":"原稿"}}`
	bound, err := productionBindDocumentCall(legacy, call)
	if err != nil || bound.Function.Arguments != call.Function.Arguments || productionParallelCallError(legacy, bound, "production_submit") == nil {
		t.Fatal("old in-flight contract was silently upgraded")
	}
}

func TestProductionBoundSubmissionStillValidatesAndRetainsRejectedDraft(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	document := orderedPlanDocument(work.Key, "")
	document["style"] = "## 非法层级\n必须保留的原稿"
	before := productionHash(mustPlanArtifacts(t, s, runID))
	settleDocumentReply(t, s, db, runID, work, map[string]any{"document": document})
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel[work.Key]
	if work.DocumentParts == nil || work.DocumentParts.RepairFields["style"] != document["style"] || productionHash(mustPlanArtifacts(t, s, runID)) != before {
		t.Fatal("content-only reply bypassed validation or lost the rejected draft")
	}
}

func TestProductionValidationSignatureTracksCorrectedArguments(t *testing.T) {
	work := productionParallelWork{Key: "any-document"}
	failure := cloudAgentFieldError("document", "unknown_fields", "需要整理额外字段")
	makeTask := func(raw string) *model.Task {
		call := productionRuntimeCall("production_submit")
		call.Function.Arguments = raw
		return &model.Task{ResultJSON: productionRuntimeResult(t, call)}
	}
	a := productionValidationFailureSignature(work, failure, makeTask(`{"document":{"a":"原稿","extra":"待整理"}}`))
	b := productionValidationFailureSignature(work, failure, makeTask(`{ "document": { "extra": "待整理", "a": "原稿" } }`))
	c := productionValidationFailureSignature(work, failure, makeTask(`{"document":{"a":"原稿","corrected":"已整理第一项"}}`))
	if a != b || a == c {
		t.Fatal("JSON formatting changed retry identity, or corrected arguments were treated as identical")
	}
}
