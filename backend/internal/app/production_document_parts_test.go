package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func enqueueDocumentPart(t *testing.T, s *Service, runID, key string) productionParallelWork {
	t.Helper()
	run, state := productionRuntimeState(t, s, runID)
	m, doc, rows := orderedPlanState(t, s, runID)
	work := state.ProductionParallel[key]
	if work.Key == "" {
		section, _ := planSection(key)
		work = productionParallelWork{Key: key, Name: section.Title, Dependencies: productionParallelDependencyHash(m, rows, key)}
	}
	if err := s.enqueueProductionParallel(run, &state, m, doc, rows, work); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	return state.ProductionParallel[key]
}

func failDocumentPart(t *testing.T, s *Service, db *gorm.DB, runID string, work productionParallelWork) {
	t.Helper()
	// Deliberately retain invalid truncated JSON: it must never be parsed as a
	// complete document just because the provider returned HTTP 200.
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusFailed, "error": errProviderOutputLimit.Error(), "result_json": `{"toolCalls":[{"function":{"arguments":"truncated`}).Error; err != nil {
		t.Fatal(err)
	}
	task, _ := s.repo.Task(work.TaskID)
	if err := s.settleProductionParallel("user", runID, work, task); err != nil {
		t.Fatal(err)
	}
}

func finishDocumentPart(t *testing.T, s *Service, db *gorm.DB, runID string, work productionParallelWork) {
	t.Helper()
	m, _, _ := orderedPlanState(t, s, runID)
	fields := map[string]string{}
	for _, section := range productionPlanDocumentSectionsForSchema(work.Key, productionPlanKind(m, work.Key), work.DocumentParts.SchemaVersion) {
		if cloudAgentContainsString(work.DocumentParts.Pending[0], section.Key) {
			fields[section.Key] = section.Title + "：明确的制作设计；与选题和本版规范一致。"
		}
	}
	args := map[string]any{"key": work.Key, "name": work.Name, "document": fields, "factIds": []string{}, "expectedHash": work.DocumentParts.ExpectedHash}
	call := productionRuntimeCall("production_submit")
	encoded, _ := json.Marshal(args)
	call.Function.Arguments = string(encoded)
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": productionRuntimeResult(t, call)}).Error; err != nil {
		t.Fatal(err)
	}
	task, _ := s.repo.Task(work.TaskID)
	if err := s.settleProductionParallel("user", runID, work, task); err != nil {
		t.Fatal(err)
	}
}

func TestProductionDocumentPartsRecoverParallelAndRestart(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ForceThinkingOff = true; state.OutputLimitEscalated = 1 })
	visual := enqueueDocumentPart(t, s, runID, "visual")
	direction := enqueueDocumentPart(t, s, runID, "direction")
	original, _ := s.repo.Task(visual.TaskID)
	budget := stepTaskTextOptions(t, s, original)["maxOutputTokens"]
	failDocumentPart(t, s, db, runID, visual)
	completeParallel(t, db, direction)
	task, _ := s.repo.Task(direction.TaskID)
	if err := s.settleProductionParallel("user", runID, direction, task); err != nil {
		t.Fatal(err)
	}
	before := productionHash(mustPlanArtifacts(t, s, runID))
	work := enqueueDocumentPart(t, s, runID, "visual")
	task, _ = s.repo.Task(work.TaskID)
	var input map[string]any
	_ = json.Unmarshal([]byte(task.InputJSON), &input)
	canonical := stateCanonicalFromInput(input)
	parameters := canonical.Tools[0]["function"].(map[string]any)["parameters"].(map[string]any)
	properties := parameters["properties"].(map[string]any)
	fields := properties["document"].(map[string]any)["properties"].(map[string]any)
	if len(fields) != len(work.DocumentParts.Pending[0]) || canonical.ToolChoice != "auto" || stepTaskTextOptions(t, s, task)["maxOutputTokens"] != budget {
		t.Fatal("part request changed the budget, tool choice or field contract")
	}
	finishDocumentPart(t, s, db, runID, work)
	_, state := productionRuntimeState(t, s, runID)
	if len(state.ProductionParallel["visual"].DocumentParts.Fields) != len(fields) || productionHash(mustPlanArtifacts(t, s, runID)) != before {
		t.Fatal("incomplete document was exposed as an artifact or checkpoint lost")
	}
	// A completed batch survives a service boundary, without regenerating it.
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	work = enqueueDocumentPart(t, s, runID, "visual")
	for _, field := range work.DocumentParts.Pending[0] {
		if _, exists := work.DocumentParts.Fields[field]; exists {
			t.Fatal("saved field requested again")
		}
	}
	finishDocumentPart(t, s, db, runID, work)
	task, _ = s.repo.Task(work.TaskID)
	if err := s.settleProductionParallel("user", runID, work, task); !errors.Is(err, repository.ErrCreationConflict) {
		t.Fatalf("duplicate receipt was not rejected: %v", err)
	}
	m, doc, rows := orderedPlanState(t, s, runID)
	if len(rows) != 4 || !productionPlanArtifactValid(m, doc, rows, "visual") || !productionPlanArtifactValid(m, doc, rows, "direction") {
		t.Fatal("merged document failed the ordinary plan validator")
	}
	submitOrderedPlan(t, s, runID, "generation", "", "生成规范")
	if report := productionCall(t, s, runID, "production_check", map[string]any{}, false); report["valid"] != true {
		t.Fatal(report)
	}
	_, state = productionRuntimeState(t, s, runID)
	if len(state.ProductionParallel) != 0 || !agentHasEventWithReason(state, "model_failure_recovered", "production_document_output_limit") {
		t.Fatal("split work or recovery explanation was lost")
	}
}

func TestProductionDocumentPartsAdaptiveSplitStopsAtOneField(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ForceThinkingOff = true })
	work := enqueueDocumentPart(t, s, runID, "visual")
	failDocumentPart(t, s, db, runID, work)
	work = enqueueDocumentPart(t, s, runID, "visual")
	finishDocumentPart(t, s, db, runID, work)
	_, state := productionRuntimeState(t, s, runID)
	saved := productionHash(state.ProductionParallel["visual"].DocumentParts.Fields)
	for attempt := 0; attempt < 6; attempt++ {
		work = enqueueDocumentPart(t, s, runID, "visual")
		count := len(work.DocumentParts.Pending[0])
		failDocumentPart(t, s, db, runID, work)
		_, state = productionRuntimeState(t, s, runID)
		work = state.ProductionParallel["visual"]
		if productionHash(work.DocumentParts.Fields) != saved {
			t.Fatal("adaptive split discarded saved chapters")
		}
		if count == 1 {
			if !strings.Contains(work.Error, work.DocumentParts.Pending[0][0]) || !strings.Contains(work.Error, "停止自动重试") || work.TaskID == "" {
				t.Fatalf("unbounded or unexplained single-field failure: %+v", work)
			}
			return
		}
		if work.Error != "" || len(work.DocumentParts.Pending[0]) >= count {
			t.Fatalf("failed batch was not reduced: %+v", work)
		}
	}
	t.Fatal("split did not converge")
}

func TestProductionDocumentPartsSerialBridgeRecovery(t *testing.T) {
	s, db, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	productionRuntimeMutate(t, s, run.ID, func(state *cloudAgentRuntime) { state.OutputLimitEscalated = 1; state.ForceThinkingOff = true })
	first, done := productionRuntimeStart(t, s, run.ID, []map[string]any{{"role": "user", "content": "continue production"}})
	if err := db.Model(&model.Task{}).Where("id = ?", first.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "error": errProviderOutputLimit.Error()}).Error; err != nil {
		t.Fatal(err)
	}
	for batch := 0; batch < 2; batch++ {
		state := waitParallel(t, s, run.ID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["story"].TaskID != "" })
		work := state.ProductionParallel["story"]
		if state.ActiveTaskID != "" || work.DocumentParts == nil {
			t.Fatal("serial retry failed to hand off to section scheduler")
		}
		finishDocumentPart(t, s, db, run.ID, work)
	}
	select {
	case result := <-done:
		if result.err != nil {
			t.Fatal(result.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bridge did not return after completing the split document")
	}
	m, doc, rows := orderedPlanState(t, s, run.ID)
	if len(rows) != 1 || !productionPlanArtifactValid(m, doc, rows, "story") {
		t.Fatal("story was not committed through the normal full validator")
	}
}

func TestProductionDocumentPartsRejectInvalidBatchAndChangedVersions(t *testing.T) {
	s, _, runID := parallelPlanFixture(t)
	m, doc, rows := orderedPlanState(t, s, runID)
	base := productionParallelWork{Key: "visual", Name: "视觉与美术规范", Dependencies: productionParallelDependencyHash(m, rows, "visual")}
	if err := productionSplitDocumentParts(m, doc, rows, &base); err != nil {
		t.Fatal(err)
	}
	for _, variant := range []string{"missing", "unknown", "placeholder", "heading", "fence", "emptyFence", "extraArgument", "design", "hash", "facts", "targetVersion", "templateVersion", "dependencyVersion"} {
		t.Run(variant, func(t *testing.T) {
			encoded, _ := json.Marshal(base)
			var work productionParallelWork
			_ = json.Unmarshal(encoded, &work)
			fields := map[string]string{}
			for _, field := range work.DocumentParts.Pending[0] {
				fields[field] = "具体制作要求"
			}
			first := work.DocumentParts.Pending[0][0]
			args := map[string]any{"key": work.Key, "name": work.Name, "document": fields, "factIds": []string{}}
			switch variant {
			case "missing":
				delete(fields, first)
			case "unknown":
				delete(fields, first)
				fields["unknown"] = "不能丢弃的内容"
			case "placeholder":
				fields[first] = "待补充"
			case "heading":
				fields[first] = "## 越级标题\n具体内容"
			case "fence":
				fields[first] = "```text\n未闭合"
			case "emptyFence":
				fields[first] = "```\n```"
			case "extraArgument":
				args["unknown"] = "不能静默丢弃"
			case "design":
				args["design"] = map[string]any{}
			case "hash":
				args["expectedHash"] = "stale"
			case "facts":
				args["factIds"] = []string{"not-a-plan-fact"}
			case "targetVersion":
				work.DocumentParts.ExpectedHash = "stale"
			case "templateVersion":
				work.DocumentParts.SchemaVersion++
			case "dependencyVersion":
				work.Dependencies = "stale"
			}
			call := productionRuntimeCall("production_submit")
			encoded, _ = json.Marshal(args)
			call.Function.Arguments = string(encoded)
			before := productionHash(work.DocumentParts)
			if _, _, err := productionStageDocumentParts(m, doc, rows, &work, call); err == nil {
				t.Fatal("invalid partial result accepted")
			}
			if productionHash(work.DocumentParts) != before {
				t.Fatal("failed batch changed the checkpoint")
			}
		})
	}
}

func TestProductionDocumentPartsReasoningRecoveryAndExplicitResume(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.Policy.ReasoningMode = "deep" })
	work := enqueueDocumentPart(t, s, runID, "visual")
	failDocumentPart(t, s, db, runID, work)
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if !work.DisableThinking || work.DocumentParts != nil || work.Error != "" {
		t.Fatal("first reasoning-limited attempt should retry once without reasoning")
	}
	work = enqueueDocumentPart(t, s, runID, "visual")
	task, _ := s.repo.Task(work.TaskID)
	if options := stepTaskTextOptions(t, s, task); options["thinking"] != false || options["reasoningDisabled"] != true {
		t.Fatal("reasoning remained enabled on recovery")
	}
	failDocumentPart(t, s, db, runID, work)
	_, state = productionRuntimeState(t, s, runID)
	if state.ProductionParallel["visual"].DocumentParts == nil {
		t.Fatal("second capped output repeated the full document")
	}

	// Simulate a pre-fix failed full document. An explicit resume should use the
	// known cap immediately instead of billing another identical full attempt.
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
		item := state.ProductionParallel["visual"]
		item.TaskID, item.Error, item.DocumentParts = work.TaskID, errProviderOutputLimit.Error(), nil
		state.ProductionParallel["visual"] = item
	})
	run, _ := productionRuntimeState(t, s, runID)
	if err := s.repo.MutateCloudAgent("user", runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = "failed"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	before := productionHash(mustPlanArtifacts(t, s, runID))
	if err := s.ControlProductionAgent("user", runID, "resume"); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if work.DocumentParts == nil || work.TaskID != "" || work.Error != "" || productionHash(mustPlanArtifacts(t, s, runID)) != before {
		t.Fatal("resume repeated capped work or changed completed documents")
	}
}

func TestProductionDocumentPartsReopensOnlyRejectedChapter(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ForceThinkingOff = true })
	work := enqueueDocumentPart(t, s, runID, "visual")
	failDocumentPart(t, s, db, runID, work)
	work = enqueueDocumentPart(t, s, runID, "visual")
	finishDocumentPart(t, s, db, runID, work)
	work = enqueueDocumentPart(t, s, runID, "visual")
	field := "facts"
	before := work.DocumentParts.Fields[field]
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Update("status", model.TaskStatusSucceeded).Error; err != nil {
		t.Fatal(err)
	}
	task, _ := s.repo.Task(work.TaskID)
	failure := productionParallelOutputError{cloudAgentFieldError("document."+field, "cross_document_conflict", "该章节与前置文稿冲突，请定向修正")}
	if err := s.recordProductionParallelFailure("user", runID, work, task, failure, true); err != nil {
		t.Fatal(err)
	}
	_, state := productionRuntimeState(t, s, runID)
	work = state.ProductionParallel["visual"]
	if work.DocumentParts.RepairFields[field] != before || work.DocumentParts.Fields[field] != "" || len(work.DocumentParts.Pending[0]) != 1 || work.DocumentParts.Pending[0][0] != field || work.ValidationAttempts != 1 {
		t.Fatal("repair discarded the original chapter or reopened unrelated fields")
	}
	work = enqueueDocumentPart(t, s, runID, "visual")
	finishDocumentPart(t, s, db, runID, work)
	_, state = productionRuntimeState(t, s, runID)
	if state.ProductionParallel["visual"].ValidationAttempts != 1 {
		t.Fatal("successful staging reset the validation budget and could create an infinite repair loop")
	}
}

func TestProductionDocumentPartsRetainCurrentSchemaAndFinalValidation(t *testing.T) {
	s, db, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	job, err := s.repo.ProductionAgentJob("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var m productionManifest
	_ = json.Unmarshal([]byte(job.ManifestJSON), &m)
	m.Plan.Version, m.Plan.ContinuityVersion = 4, 1
	encoded, _ := json.Marshal(m)
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, string(encoded)); err != nil {
		t.Fatal(err)
	}
	m, doc, rows := orderedPlanState(t, s, run.ID)
	work := productionParallelWork{Key: "story", Name: "故事总纲与世界规则", Dependencies: productionParallelDependencyHash(m, rows, "story")}
	if err := productionSplitDocumentParts(m, doc, rows, &work); err != nil {
		t.Fatal(err)
	}
	if work.DocumentParts.SchemaVersion != 2 || !cloudAgentContainsString(work.DocumentParts.Pending[1], "episodeArchitecture") {
		t.Fatal("split dropped the current story schema")
	}
	// Store a structurally valid first half whose relationship ledger in the
	// second half is invalid. The final ordinary tool must still reject it.
	productionRuntimeMutate(t, s, run.ID, func(state *cloudAgentRuntime) {
		state.ProductionParallel = map[string]productionParallelWork{"story": work}
	})
	work = enqueueDocumentPart(t, s, run.ID, "story")
	finishDocumentPart(t, s, db, run.ID, work)
	work = enqueueDocumentPart(t, s, run.ID, "story")
	fields := map[string]string{}
	for _, field := range work.DocumentParts.Pending[0] {
		fields[field] = "具体的制作设计。"
	}
	fields["relationships"] = "REL-001 | 主体：角色甲 | 客体：角色乙 | 类型：invalid_relation | 方向：bidirectional | 规范称呼：搭档 | 来源：制作设计 | 适用范围：全剧"
	args := map[string]any{"key": work.Key, "name": work.Name, "factIds": []string{}, "document": fields}
	call := productionRuntimeCall("production_submit")
	encoded, _ = json.Marshal(args)
	call.Function.Arguments = string(encoded)
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": productionRuntimeResult(t, call)}).Error; err != nil {
		t.Fatal(err)
	}
	task, _ := s.repo.Task(work.TaskID)
	if err := s.settleProductionParallel("user", run.ID, work, task); err != nil {
		t.Fatal(err)
	}
	_, state := productionRuntimeState(t, s, run.ID)
	if len(mustPlanArtifacts(t, s, run.ID)) != 0 || state.ProductionParallel["story"].ValidationAttempts != 1 || !strings.Contains(state.ProductionParallel["story"].Correction, "invalid_relation") {
		t.Fatal("merged output bypassed full continuity validation")
	}
}

func TestProductionDocumentPartsSupportGenerationAndEveryAssetKind(t *testing.T) {
	for _, key := range []string{"generation", "character", "environment", "prop", "special", "sound"} {
		t.Run(key, func(t *testing.T) {
			s, db, runID := parallelPlanFixture(t)
			for _, shared := range []string{"visual", "direction"} {
				submitOrderedPlan(t, s, runID, shared, "", shared)
			}
			if key != "generation" {
				submitOrderedPlan(t, s, runID, "generation", "", "生成规范")
				startPlanAssetsForTest(t, s, runID)
				if _, err := s.ensureProductionPlanGroups("user", runID); err != nil {
					t.Fatal(err)
				}
				if key == "sound" {
					submitOrderedPlan(t, s, runID, "character", "character", "测试character")
				}
			}
			productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ForceThinkingOff = true })
			m, _, rows := orderedPlanState(t, s, runID)
			if key != "generation" {
				item := productionPlanItem(m, key)
				productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
					state.ProductionParallel = map[string]productionParallelWork{key: {Key: key, Name: item.Name, Dependencies: productionParallelDependencyHash(m, rows, key)}}
				})
			}
			before := len(rows)
			work := enqueueDocumentPart(t, s, runID, key)
			failDocumentPart(t, s, db, runID, work)
			for batch := 0; batch < 2; batch++ {
				work = enqueueDocumentPart(t, s, runID, key)
				finishDocumentPart(t, s, db, runID, work)
			}
			m, doc, rows := orderedPlanState(t, s, runID)
			if len(rows) != before+1 || !productionPlanArtifactValid(m, doc, rows, key) {
				t.Fatal("split document did not pass its type's full save contract")
			}
		})
	}
}
