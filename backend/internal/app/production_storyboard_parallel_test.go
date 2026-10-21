package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func storyboardLayouts() []storyboardSceneLayout {
	return []storyboardSceneLayout{
		{SceneID: "S1", Shots: []productionShotOutline{{ID: "S1-001", Start: 1, End: 1, Duration: 10, Goal: "入场", Entry: "门外", Exit: "馆内", Camera: "固定空间基准，门在画面左侧"}}},
		{SceneID: "S2", Shots: []productionShotOutline{
			{ID: "S2-001", Start: 2, End: 2, Duration: 10, Goal: "说出回归", Entry: "馆内", Exit: "对白结束", Camera: "沿用馆内基准，中景"},
			{ID: "S2-002", Start: 3, End: 3, Duration: 10, Goal: "放下相机", Entry: "对白结束", Exit: "相机落桌", Camera: "沿用馆内基准，近景"},
		}},
	}
}

func parallelStoryboardFixture(t *testing.T, dependency bool) (*Service, *gorm.DB, string) {
	t.Helper()
	s, db, run := storyboardFixtureWithTiming(t, 10, 3)
	storyboardFixturePlan(t, s, run.ID)
	raw, state := productionRuntimeState(t, s, run.ID)
	if err := s.upgradeStoryboardLayout(raw, &state); err != nil {
		t.Fatal(err)
	}
	layouts := storyboardLayouts()
	if dependency {
		layouts[1].Shots[1].DependsOn = []string{"S1-001"}
	}
	productionCall(t, s, run.ID, "production_storyboard_layout", map[string]any{"layouts": layouts}, false)
	return s, db, run.ID
}

func storyboardState(t *testing.T, s *Service, runID string) (productionManifest, map[string]any, []map[string]any) {
	t.Helper()
	run, state := productionRuntimeState(t, s, runID)
	_, m, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		t.Fatal(err)
	}
	target := productionNode(doc, "target")
	meta := target["metadata"].(map[string]any)
	table := meta["storyboard"].(map[string]any)
	return m, doc, creationMaps(table["rows"])
}

func completeStoryboardWork(t *testing.T, db *gorm.DB, work productionParallelWork) {
	t.Helper()
	scene, index, start := "S1", 1, 1
	if work.Key == "S2-001" {
		scene, start = "S2", 2
	}
	if work.Key == "S2-002" {
		scene, index, start = "S2", 2, 3
	}
	args, _ := json.Marshal(map[string]any{"sceneId": scene, "shot": storyboardShot(scene, index, start, start, 10)})
	call := productionRuntimeCall("production_storyboard_expand")
	call.Function.Arguments = string(args)
	var task model.Task
	if err := db.First(&task, "id = ?", work.TaskID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "input_json": completedTaskInputJSON(task), "result_json": productionRuntimeResult(t, call)}).Error; err != nil {
		t.Fatal(err)
	}
}

func TestStoryboardParallelSettlesCompactedTaskWithoutAnotherModelCall(t *testing.T) {
	s, db, runID := parallelStoryboardFixture(t, false)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 3 })
	cancel()
	<-done
	work := state.ProductionParallel["S2-001"]
	completeStoryboardWork(t, db, work)
	task, err := s.repo.Task(work.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(task.InputJSON, "agentRequests") {
		t.Fatal("terminal request still contains model inputs")
	}
	if err := s.settleProductionParallel("user", runID, work, task); err != nil {
		t.Fatal(err)
	}
	m, _, rows := storyboardState(t, s, runID)
	_, after := productionRuntimeState(t, s, runID)
	if !storyboardShotDone(m, work.Key) || rows[1]["detailStatus"] != "ready" {
		t.Fatalf("valid compacted result was rejected: %+v", after.ProductionParallel[work.Key])
	}
	if _, exists := after.ProductionParallel[work.Key]; exists || len(after.TaskIDs) != len(state.TaskIDs) {
		t.Fatal("successful settlement scheduled another paid call")
	}
}

func TestStoryboardParallelRecoversRejectedSuccessfulReceipt(t *testing.T) {
	s, db, runID := parallelStoryboardFixture(t, false)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 3 })
	cancel()
	<-done
	work := state.ProductionParallel["S2-001"]
	completeStoryboardWork(t, db, work)
	task, _ := s.repo.Task(work.TaskID)
	work.Attempts = cloudAgentModelStepRetries + 1
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
		state.ProductionParallel[work.Key] = work
		state.ProductionPaused = true
	})
	if err := s.recordProductionParallelFailure("user", runID, work, task, BadAuthRequest("请直接调用 production_submit，仅保存指定的一项完整内容"), true); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.CloudAgentExecution{}).Where("id = ?", runID).Update("status", "failed").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.ControlProductionAgent("user", runID, "resume"); err != nil {
		t.Fatal(err)
	}
	_, resumed := productionRuntimeState(t, s, runID)
	if resumed.ProductionParallel[work.Key].TaskID != task.ID {
		t.Fatal("resume discarded the successful receipt")
	}
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ProductionPaused = true })
	cancel, done = startParallel(t, s, runID)
	after := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { _, exists := state.ProductionParallel[work.Key]; return !exists })
	cancel()
	<-done
	m, _, _ := storyboardState(t, s, runID)
	if !storyboardShotDone(m, work.Key) || len(after.TaskIDs) != len(state.TaskIDs) {
		t.Fatal("recovery discarded valid billed result or issued another call")
	}
}

func TestStoryboardParallelRejectsInvalidCompactedOutputs(t *testing.T) {
	for _, issue := range []string{"wrong-tool", "multiple-calls", "wrong-shot", "wrong-scene"} {
		t.Run(issue, func(t *testing.T) {
			s, db, runID := parallelStoryboardFixture(t, false)
			cancel, done := startParallel(t, s, runID)
			state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 3 })
			cancel()
			<-done
			work := state.ProductionParallel["S2-001"]
			completeStoryboardWork(t, db, work)
			task, _ := s.repo.Task(work.TaskID)
			var result struct {
				ToolCalls []cloudAgentCall `json:"toolCalls"`
			}
			_ = json.Unmarshal([]byte(task.ResultJSON), &result)
			switch issue {
			case "wrong-tool":
				result.ToolCalls[0].Function.Name = "production_submit"
			case "multiple-calls":
				result.ToolCalls = append(result.ToolCalls, result.ToolCalls[0])
			default:
				var args map[string]any
				_ = json.Unmarshal([]byte(result.ToolCalls[0].Function.Arguments), &args)
				if issue == "wrong-shot" {
					args["shot"].(map[string]any)["id"] = "S2-002"
				} else {
					args["sceneId"] = "S1"
				}
				encoded, _ := json.Marshal(args)
				result.ToolCalls[0].Function.Arguments = string(encoded)
			}
			task.ResultJSON = productionRuntimeResult(t, result.ToolCalls...)
			if err := s.settleProductionParallel("user", runID, work, task); err != nil {
				t.Fatal(err)
			}
			m, _, _ := storyboardState(t, s, runID)
			_, after := productionRuntimeState(t, s, runID)
			if storyboardShotDone(m, work.Key) || after.ProductionParallel[work.Key].Correction == "" {
				t.Fatal("invalid result bypassed validation")
			}
		})
	}
}

func TestStoryboardParallelProgressReportsWorkerStates(t *testing.T) {
	s, db, runID := parallelStoryboardFixture(t, false)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 3 })
	cancel()
	<-done
	if err := db.Model(&model.Task{}).Where("id = ?", state.ProductionParallel["S1-001"].TaskID).Update("status", model.TaskStatusRunning).Error; err != nil {
		t.Fatal(err)
	}
	completeStoryboardWork(t, db, state.ProductionParallel["S2-001"])
	p := s.productionAgentProgress("user", runID, &state)
	if len(p.ParallelItems) != 3 || p.ParallelItems[0].Status != "running" || p.ParallelItems[1].Status != "succeeded" || p.ParallelItems[2].Status != "queued" {
		t.Fatalf("inaccurate worker states: %+v", p.ParallelItems)
	}
	foreign, err := s.repo.TaskStatesForUser("other-user", []string{state.ProductionParallel["S1-001"].TaskID})
	if err != nil || len(foreign) != 0 {
		t.Fatal("task state leaked across users", err)
	}
}

func TestStoryboardLayoutPersistsAllPlaceholdersBeforeAnyDetails(t *testing.T) {
	s, _, runID := parallelStoryboardFixture(t, true)
	m, _, rows := storyboardState(t, s, runID)
	if len(rows) != 3 || storyboardCoverage(m)["artifactCount"] != 0 || storyboardCoverage(m)["shotTotal"] != 3 {
		t.Fatalf("missing placeholders: %+v", rows)
	}
	for index, row := range rows {
		if row["detailStatus"] != "planned" || row["videoMotionPrompt"] != "" || row["shotNumber"] != float64(index+1) || row["plannedGoal"] == "" {
			t.Fatalf("invalid placeholder: %+v", row)
		}
	}
	if len(storyboardParallelReady(m)) != 2 {
		t.Fatal("explicit dependency was admitted early")
	}
	_, state := productionRuntimeState(t, s, runID)
	if p := s.productionAgentProgress("user", runID, &state); p.ShotTotal != 3 || p.ArtifactCount != 0 {
		t.Fatalf("incorrect progress: %+v", p)
	}
}

func TestStoryboardLayoutValidationIsAtomicAndStable(t *testing.T) {
	for _, issue := range []string{"missing", "id", "duration", "coverage", "forward", "rewrite"} {
		t.Run(issue, func(t *testing.T) {
			s, _, runID := parallelStoryboardFixture(t, false)
			m, _, _ := storyboardState(t, s, runID)
			if issue != "rewrite" {
				for i := range m.Storyboard.Scenes {
					m.Storyboard.Scenes[i].Layout = nil
				}
			}
			before := productionStoredValueHash(m.Storyboard)
			layouts := storyboardLayouts()
			switch issue {
			case "missing":
				layouts = layouts[:1]
			case "id":
				layouts[1].Shots[1].ID = "invented"
			case "duration":
				layouts[1].Shots[1].Duration = 2
			case "coverage":
				layouts[1].Shots[1].Start, layouts[1].Shots[1].End = 2, 2
			case "forward":
				layouts[0].Shots[0].DependsOn = []string{"S2-001"}
			case "rewrite":
				layouts[1].Shots[0].Goal = "改变规划"
			}
			if err := applyStoryboardLayout(m.Storyboard, layouts); err == nil {
				t.Fatal("invalid layout accepted")
			}
			if productionStoredValueHash(m.Storyboard) != before {
				t.Fatal("failed validation mutated the layout")
			}
		})
	}
}

func TestStoryboardParallelShortTailMayFinishBeforeEarlierShot(t *testing.T) {
	s, _, runID := parallelStoryboardFixture(t, false)
	m, doc, _ := storyboardState(t, s, runID)
	m.Storyboard.Duration, m.Storyboard.ShotDuration, m.Storyboard.ShotTolerance = 34, 30, 3
	m.Storyboard.Scenes = []productionScene{{ID: "S1", Start: 1, End: 3, Duration: 34}}
	layout := []storyboardSceneLayout{{SceneID: "S1", Shots: []productionShotOutline{
		{ID: "S1-001", Start: 1, End: 2, Duration: 30, Goal: "进入并说话", Entry: "门外", Exit: "对白结束", Camera: "同场中景"},
		{ID: "S1-002", Start: 3, End: 3, Duration: 4, Goal: "放下相机", Entry: "对白结束", Exit: "相机落桌", Camera: "同场近景"},
	}}}
	if err := applyStoryboardLayout(m.Storyboard, layout); err != nil {
		t.Fatal(err)
	}
	if err := applyStoryboardExpansion(m, doc, "S1", storyboardShot("S1", 2, 3, 3, 4)); err != nil {
		t.Fatal(err)
	}
	if issues := storyboardTimingIssues(m); len(issues) != 0 {
		t.Fatalf("unordered legal tail treated as invalid prefix: %+v", issues)
	}
	if err := applyStoryboardExpansion(m, doc, "S1", storyboardShot("S1", 1, 1, 2, 30)); err != nil {
		t.Fatal(err)
	}
	if !m.Storyboard.Scenes[0].Complete || len(storyboardTimingIssues(m)) != 0 {
		t.Fatal("valid completed scene did not pass timing")
	}
}

func TestStoryboardLayoutUpgradeOffersResetForInvalidLegacyPrefix(t *testing.T) {
	s, _, runID := parallelStoryboardFixture(t, false)
	m, doc, _ := storyboardState(t, s, runID)
	for i := range m.Storyboard.Scenes {
		m.Storyboard.Scenes[i].Layout = nil
	}
	m.Storyboard.Scenes[0].Shots = []productionShot{storyboardShot("S1", 1, 1, 1, 3)}
	ctx, err := storyboardContext(s.repo, "user", m, doc)
	if err != nil || ctx["nextTool"] != "production_storyboard_reset" || ctx["expectedHash"] != storyboardSceneHash(m.Storyboard.Scenes[0]) {
		t.Fatal("invalid legacy prefix trapped layout generation", ctx, err)
	}
	canonical := canonicalAgentRequest{Tools: storyboardTools()}
	productionConstrainStoryboard(ctx, &canonical)
	productionRuntimeAssertTools(t, canonical.Tools, []string{"production_storyboard_reset"})
}

func TestStoryboardParallelPolicyDependencyRestartAndOutOfOrder(t *testing.T) {
	s, db, runID := parallelStoryboardFixture(t, true)
	_, initial := productionRuntimeState(t, s, runID)
	initialTasks := len(initial.TaskIDs)
	updateTestGlobalConcurrency(t, s, func(p *RuntimePolicySetting) { p.Task.AgentConcurrency = 1; p.Task.TextConcurrency = 9 })
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["S1-001"].TaskID != "" })
	if len(state.ProductionParallel) != 1 {
		t.Fatal("ignored Agent concurrency")
	}
	updateTestGlobalConcurrency(t, s, func(p *RuntimePolicySetting) { p.Task.AgentConcurrency = 3; p.Task.TextConcurrency = 1 })
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["S2-001"].TaskID != "" })
	if len(state.ProductionParallel) != 2 {
		t.Fatal("independent scenes did not run concurrently")
	}
	if _, exists := state.ProductionParallel["S2-002"]; exists {
		t.Fatal("dependent shot ran early")
	}
	_, _, rows := storyboardState(t, s, runID)
	if rows[0]["detailStatus"] != "queued" || rows[2]["detailStatus"] != "planned" {
		t.Fatalf("statuses not persisted: %+v", rows)
	}
	for _, work := range state.ProductionParallel {
		task, err := s.repo.Task(work.TaskID)
		if err != nil {
			t.Fatal(err)
		}
		var input map[string]any
		_ = json.Unmarshal([]byte(task.InputJSON), &input)
		canonical := stateCanonicalFromInput(input)
		productionRuntimeAssertTools(t, canonical.Tools, []string{"production_storyboard_expand"})
		encoded, _ := json.Marshal(canonical.Messages)
		if work.Key == "S2-001" && (strings.Contains(string(encoded), "林岚进入照相馆") || strings.Contains(string(encoded), "她放下相机")) {
			t.Fatal("per-shot context contains unrelated source")
		}
	}
	// Restart while requests are pending; settle the second scene before the first.
	cancel()
	<-done
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	cancel, done = startParallel(t, s, runID)
	completeStoryboardWork(t, db, state.ProductionParallel["S2-001"])
	waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 1 })
	m, _, rows := storyboardState(t, s, runID)
	if rows[0]["detailStatus"] != "queued" || rows[1]["detailStatus"] != "ready" || rows[1]["detailTaskId"] != state.ProductionParallel["S2-001"].TaskID || rows[2]["detailStatus"] != "planned" || len(storyboardTimingIssues(m)) != 0 {
		t.Fatal("out-of-order settlement changed ordering or timing")
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		meta := productionNode(doc, "target")["metadata"].(map[string]any)
		row := creationMaps(meta["storyboard"].(map[string]any)["rows"])[1]
		row["videoNodeId"], row["videoMotionPrompt"] = "saved-video", "用户调整的提示词"
	})
	completeStoryboardWork(t, db, state.ProductionParallel["S1-001"])
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel["S2-002"].TaskID != "" })
	if len(state.TaskIDs) != initialTasks+3 {
		t.Fatalf("restart duplicated paid task receipts: initial=%d actual=%d", initialTasks, len(state.TaskIDs))
	}
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ProductionPaused = true })
	completeStoryboardWork(t, db, state.ProductionParallel["S2-002"])
	waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 0 })
	cancel()
	<-done
	m, doc, rows := storyboardState(t, s, runID)
	if rows[1]["videoNodeId"] != "saved-video" || rows[1]["videoMotionPrompt"] != "用户调整的提示词" {
		t.Fatal("checkpoint overwrote manual edits or media")
	}
	if storyboardCoverage(m)["valid"] == true || storyboardCoverage(m)["artifactCount"] != 3 {
		t.Fatal("finished without final review")
	}
	ctx, err := storyboardContext(s.repo, "user", m, doc)
	if err != nil || ctx["phase"] != "review" {
		t.Fatal(ctx, err)
	}
	productionCall(t, s, runID, "production_storyboard_review", map[string]any{"hash": ctx["hash"], "review": "剧情、对白、时长、端点与构图已核对。", "repairSceneIds": []string{}}, false)
	m, _, _ = storyboardState(t, s, runID)
	if storyboardCoverage(m)["valid"] != true {
		t.Fatal("review did not complete")
	}
}

func TestStoryboardParallelFailureAndSourceVersionPreserveResults(t *testing.T) {
	s, db, runID := parallelStoryboardFixture(t, false)
	_, initial := productionRuntimeState(t, s, runID)
	initialTasks := len(initial.TaskIDs)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 3 })
	cancel()
	<-done
	work := state.ProductionParallel["S2-002"]
	task, _ := s.repo.Task(work.TaskID)
	if err := s.recordProductionParallelFailure("user", runID, work, task, errors.New("temporary upstream failure"), true); err != nil {
		t.Fatal(err)
	}
	_, _, rows := storyboardState(t, s, runID)
	if rows[2]["detailStatus"] != "retrying" || stringValue(rows[2]["detailError"]) == "" {
		t.Fatalf("retry status missing: %+v", rows[2])
	}
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) { state.ProductionPaused = true })
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
		work := state.ProductionParallel["S2-002"]
		work.RetryAt = time.Now().Add(-time.Second).UnixMilli()
		state.ProductionParallel[work.Key] = work
	})
	cancel, done = startParallel(t, s, runID)
	completeStoryboardWork(t, db, state.ProductionParallel["S2-001"])
	waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 2 })
	cancel()
	<-done
	_, after := productionRuntimeState(t, s, runID)
	if len(after.TaskIDs) != initialTasks+3 || after.ProductionParallel["S2-002"].TaskID != "" {
		t.Fatal("pause admitted retry")
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		for _, node := range creationMaps(doc["nodes"]) {
			if productionWorkflow(node)["step"] == "story.body" {
				node["metadata"].(map[string]any)["content"] = "来源已经修改"
			}
		}
	})
	completeStoryboardWork(t, db, state.ProductionParallel["S1-001"])
	task, _ = s.repo.Task(state.ProductionParallel["S1-001"].TaskID)
	if err := s.settleProductionParallel("user", runID, state.ProductionParallel["S1-001"], task); err == nil {
		t.Fatal("stale source was accepted")
	}
	_, after = productionRuntimeState(t, s, runID)
	if len(after.TaskIDs) != initialTasks+3 {
		t.Fatal("source conflict triggered another billed call")
	}
	if err := s.CancelCloudAgent(context.Background(), "user", runID); err != nil {
		t.Fatal(err)
	}
}

func TestStoryboardParallelBridgeContinuesWithEpisodeReview(t *testing.T) {
	s, db, runID := parallelStoryboardFixture(t, false)
	cancel, pending := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 3 })
	cancel()
	<-pending
	for _, work := range state.ProductionParallel {
		completeStoryboardWork(t, db, work)
	}
	task, done := productionRuntimeStart(t, s, runID, []map[string]any{{"role": "user", "content": "继续分镜"}})
	var input map[string]any
	_ = json.Unmarshal([]byte(task.InputJSON), &input)
	canonical := stateCanonicalFromInput(input)
	productionRuntimeAssertTools(t, canonical.Tools, []string{"production_storyboard_review", "production_storyboard_read"})
	_, next := productionRuntimeState(t, s, runID)
	if len(next.ProductionParallel) != 0 || next.ActiveTaskID != task.ID || len(next.TaskIDs) != len(state.TaskIDs)+1 {
		t.Fatal("legacy bridge failed to drain into one episode review task")
	}
	if result := productionRuntimeFinish(t, db, task.ID, done, productionRuntimeCall("production_storyboard_context")); result.err != nil {
		t.Fatal(result.err)
	}
}

func TestStoryboardParallelFailedSlotResumeReusesSuccessfulRows(t *testing.T) {
	s, db, runID := parallelStoryboardFixture(t, false)
	cancel, done := startParallel(t, s, runID)
	state := waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return len(state.ProductionParallel) == 3 })
	cancel()
	<-done
	failed := state.ProductionParallel["S2-002"]
	task, _ := s.repo.Task(failed.TaskID)
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.recordProductionParallelFailure("user", runID, failed, task, BadAuthRequest("模型返回内容不完整"), false); err != nil {
		t.Fatal(err)
	}
	_, _, rows := storyboardState(t, s, runID)
	if rows[2]["detailStatus"] != "error" {
		t.Fatal("failed slot is not visible")
	}
	for _, key := range []string{"S1-001", "S2-001"} {
		work := state.ProductionParallel[key]
		completeStoryboardWork(t, db, work)
		completed, _ := s.repo.Task(work.TaskID)
		if err := s.settleProductionParallel("user", runID, work, completed); err != nil {
			t.Fatal(err)
		}
	}
	// The resume controller clears failed receipts. Exercise the resulting
	// durable checkpoint through the same scheduler and billing admission.
	productionRuntimeMutate(t, s, runID, func(state *cloudAgentRuntime) {
		work := state.ProductionParallel[failed.Key]
		work.TaskID, work.Error, work.Attempts, work.RetryAt = "", "", 0, 0
		state.ProductionParallel[work.Key] = work
	})
	_, before := productionRuntimeState(t, s, runID)
	_, done = startParallel(t, s, runID)
	state = waitParallel(t, s, runID, func(state cloudAgentRuntime) bool { return state.ProductionParallel[failed.Key].TaskID != "" })
	if len(state.ProductionParallel) != 1 || len(state.TaskIDs) != len(before.TaskIDs)+1 {
		t.Fatal("resume regenerated completed slots")
	}
	completeStoryboardWork(t, db, state.ProductionParallel[failed.Key])
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("resume did not finish")
	}
	m, _, rows := storyboardState(t, s, runID)
	if len(rows) != 3 || storyboardCoverage(m)["artifactCount"] != 3 {
		t.Fatal("resume did not preserve the whole list")
	}
}
