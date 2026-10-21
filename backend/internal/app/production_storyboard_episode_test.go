package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestStoryboardEpisodeBatchAtomicResumeAndReview(t *testing.T) {
	s, db, runID := parallelStoryboardFixture(t, false)
	if err := s.prepareStoryboardEpisode(context.Background(), "user", runID); err != nil {
		t.Fatal(err)
	}
	m, doc, rows := storyboardState(t, s, runID)
	if m.Storyboard.Version != storyboardEpisodeVersion || len(rows) != 3 || len(productionParallelReady(m, doc, nil)) != 0 {
		t.Fatal("episode lane lost placeholders or admitted per-shot tasks")
	}
	first := storyboardSubmitArgs(t, s, runID, "S1", 0, []productionShot{storyboardShot("S1", 1, 1, 1, 10)}, true)
	productionCall(t, s, runID, "production_storyboard_submit", first, false)
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	ctx := productionCall(t, restarted, runID, "production_storyboard_context", map[string]any{}, false)
	if ctx["phase"] != "scene" || ctx["executionMode"] != "episode" || len(creationMaps(ctx["plannedShots"])) != 2 || ctx["previousShot"].(map[string]any)["id"] != "S1-001" {
		t.Fatal("not a continuous batch", ctx)
	}
	bad := []productionShot{storyboardShot("S2", 1, 2, 2, 10), storyboardShot("S2", 2, 3, 3, 10)}
	bad[1].AssetIDs = []string{"CHR-999"}
	args := storyboardSubmitArgs(t, restarted, runID, "S2", 0, bad, true)
	productionCall(t, restarted, runID, "production_storyboard_submit", args, true)
	m, _, _ = storyboardState(t, restarted, runID)
	if len(m.Storyboard.Scenes[1].Shots) != 0 {
		t.Fatal("invalid second shot partially saved first shot")
	}
	bad[1].AssetIDs = nil
	bad[0].Dialogue = "林岚：我回来了。"
	args = storyboardSubmitArgs(t, restarted, runID, "S2", 0, bad, true)
	productionCall(t, restarted, runID, "production_storyboard_submit", args, false)
	productionCall(t, restarted, runID, "production_storyboard_submit", args, false)
	ctx = productionCall(t, restarted, runID, "production_storyboard_context", map[string]any{}, false)
	encoded, _ := json.Marshal(ctx)
	if ctx["phase"] != "review" || len(creationMaps(ctx["source"])) != 3 || !strings.Contains(string(encoded), "我回来了。") || strings.Contains(string(encoded), "visualSummary") {
		t.Fatal("review lacks complete episode and shots", string(encoded))
	}
	productionCall(t, restarted, runID, "production_storyboard_review", map[string]any{"hash": ctx["hash"], "review": "已逐段核对正文与完整镜头的动作、对白和连续性", "repairSceneIds": []string{}}, false)
	m, _, _ = storyboardState(t, restarted, runID)
	if storyboardCoverage(m)["valid"] != true {
		t.Fatal("completed batch did not finish review")
	}
}

func TestStoryboardEpisodeDrainsLegacyResponsesWithoutNewFanout(t *testing.T) {
	s, db, runID := parallelStoryboardFixture(t, false)
	// Materialize legacy paid receipts without starting the old scheduler.
	for _, key := range []string{"S1-001", "S2-002"} {
		run, state := productionRuntimeState(t, s, runID)
		_, m, doc, err := productionLoad(s.repo, run, &state)
		if err != nil {
			t.Fatal(err)
		}
		for _, work := range storyboardParallelReady(m) {
			if work.Key == key {
				if err := s.enqueueProductionParallel(run, &state, m, doc, nil, work); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	_, initial := productionRuntimeState(t, s, runID)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.prepareStoryboardEpisode(ctx, "user", runID) }()
	t.Cleanup(func() { cancel() })
	select {
	case err := <-done:
		t.Fatal("migration bypassed pending paid responses", err)
	case <-time.After(30 * time.Millisecond):
	}
	for _, work := range initial.ProductionParallel {
		completeStoryboardWork(t, db, work)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("legacy drain did not finish")
	}
	run, state := productionRuntimeState(t, s, runID)
	if len(state.ProductionParallel) != 0 || len(state.TaskIDs) != len(initial.TaskIDs) {
		t.Fatal("migration created calls or retained child scheduling")
	}
	m, doc, rows := storyboardState(t, s, runID)
	if !storyboardShotDone(m, "S2-002") || rows[2]["detailStatus"] != "ready" {
		t.Fatal("out-of-order paid result was lost")
	}
	if err := s.enqueueProductionParallel(run, &state, m, doc, nil, productionParallelWork{Key: "S2-001"}); err == nil {
		t.Fatal("episode lane admitted a child request")
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		meta := productionNode(doc, "target")["metadata"].(map[string]any)
		row := creationMaps(meta["storyboard"].(map[string]any)["rows"])[2]
		row["videoNodeId"], row["videoMotionPrompt"] = "saved-video", "用户已调整提示词"
	})
	checkpoint := productionCall(t, s, runID, "production_storyboard_context", map[string]any{}, false)
	if checkpoint["offset"] != float64(0) || len(creationMaps(checkpoint["plannedShots"])) != 1 {
		t.Fatal("missing slot not identified", checkpoint)
	}
	args := storyboardSubmitArgs(t, s, runID, "S2", 0, []productionShot{storyboardShot("S2", 1, 2, 2, 10)}, true)
	productionCall(t, s, runID, "production_storyboard_submit", args, false)
	_, _, rows = storyboardState(t, s, runID)
	if rows[2]["videoNodeId"] != "saved-video" || rows[2]["videoMotionPrompt"] != "用户已调整提示词" {
		t.Fatal("filling a hole replaced existing media or edits")
	}
}

func TestStoryboardEpisodeRejectsMultipleSceneTailsAndImpossibleTiming(t *testing.T) {
	s := &productionStoryboard{Version: storyboardEpisodeVersion, ShotDuration: 25, ShotTolerance: 3, MinDuration: 60, MaxDuration: 120}
	if validateStoryboardPlanTiming([]productionScene{{ID: "A", Duration: 33}, {ID: "B", Duration: 33}}, s) == nil {
		t.Fatal("multiple per-scene tails accepted")
	}
	if err := validateStoryboardPlanTiming([]productionScene{{ID: "A", Duration: 52}, {ID: "B", Duration: 24}}, s); err != nil {
		t.Fatal(err)
	}
	if err := restoreStoryboardTiming(s, map[string]any{"minutesPerEpisode": 1}); err == nil {
		t.Fatal("fixed 60 seconds cannot fit 22-28 second shots")
	}
	if s.MaxDuration != 120 {
		t.Fatal("invalid timing partially changed checkpoint")
	}
	if err := restoreStoryboardTiming(s, map[string]any{"minutesPerEpisode": "1-2"}); err != nil {
		t.Fatal(err)
	}
}

func TestStoryboardEpisodeProgressUsesActualSingleTask(t *testing.T) {
	s, db, runID := parallelStoryboardFixture(t, false)
	if err := s.prepareStoryboardEpisode(context.Background(), "user", runID); err != nil {
		t.Fatal(err)
	}
	// An ordinary Agent task keeps the same tenant-isolated status lookup.
	task := model.Task{ID: "episode-active", UserID: "user", Status: model.TaskStatusQueued}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	_, state := productionRuntimeState(t, s, runID)
	state.ActiveTaskID = task.ID
	view := s.productionAgentProgress("user", runID, &state)
	if view.ExecutionMode != "episode" || view.EpisodeTaskStatus != "queued" || view.CurrentItem != "S1-001 ~ S1-001" || len(view.ParallelItems) != 0 {
		t.Fatalf("incorrect episode progress: %+v", view)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("status", model.TaskStatusRunning).Error; err != nil {
		t.Fatal(err)
	}
	if view := s.productionAgentProgress("user", runID, &state); view.EpisodeTaskStatus != "running" {
		t.Fatal("did not reflect worker execution")
	}
}

func TestStoryboardEpisodeReviewCanRebudgetOnlyReopenedScenes(t *testing.T) {
	s, _, runID := parallelStoryboardFixture(t, false)
	if err := s.prepareStoryboardEpisode(context.Background(), "user", runID); err != nil {
		t.Fatal(err)
	}
	productionCall(t, s, runID, "production_storyboard_submit", storyboardSubmitArgs(t, s, runID, "S1", 0, []productionShot{storyboardShot("S1", 1, 1, 1, 10)}, true), false)
	productionCall(t, s, runID, "production_storyboard_submit", storyboardSubmitArgs(t, s, runID, "S2", 0, []productionShot{storyboardShot("S2", 1, 2, 2, 10), storyboardShot("S2", 2, 3, 3, 10)}, true), false)
	ctx := productionCall(t, s, runID, "production_storyboard_context", map[string]any{}, false)
	productionCall(t, s, runID, "production_storyboard_review", map[string]any{"hash": ctx["hash"], "review": "只返修S2：原对白与报时冲突，重新分配本场预算为22秒并保留全部剧情。", "repairSceneIds": []string{"S2"}}, false)
	ctx = productionCall(t, s, runID, "production_storyboard_context", map[string]any{}, false)
	if ctx["phase"] != "layout" || ctx["canRebudget"] != true {
		t.Fatal("semantic timing repair cannot reach budget adjustment", ctx)
	}
	canonical := canonicalAgentRequest{Tools: storyboardTools()}
	productionConstrainStoryboard(ctx, &canonical)
	productionRuntimeAssertTools(t, canonical.Tools, []string{"production_storyboard_plan", "production_storyboard_layout"})
	m, _, _ := storyboardState(t, s, runID)
	plans := append([]productionScene{}, m.Storyboard.Scenes...)
	plans[0].Duration, plans[1].Duration = 11, 22
	productionCall(t, s, runID, "production_storyboard_plan", storyboardPlanArgs(plans), true)
	plans[0].Duration = 10
	productionCall(t, s, runID, "production_storyboard_plan", storyboardPlanArgs(plans), false)
	m, _, _ = storyboardState(t, s, runID)
	if !m.Storyboard.Scenes[0].Complete || len(m.Storyboard.Scenes[0].Shots) != 1 || m.Storyboard.Scenes[1].Duration != 22 || len(m.Storyboard.Scenes[1].PreviousShots) != 2 {
		t.Fatal("budget repair lost a prior draft or reused the unchanged budget")
	}
	layouts := storyboardLayouts()[1:]
	for i := range layouts[0].Shots {
		layouts[0].Shots[i].Duration = 11
	}
	productionCall(t, s, runID, "production_storyboard_layout", map[string]any{"layouts": layouts}, false)
	ctx = productionCall(t, s, runID, "production_storyboard_context", map[string]any{}, false)
	if ctx["canRebudget"] == true {
		t.Fatal("budget adjustment remained available after repair layout was saved")
	}
	productionCall(t, s, runID, "production_storyboard_submit", storyboardSubmitArgs(t, s, runID, "S2", 0, []productionShot{storyboardShot("S2", 1, 2, 2, 11), storyboardShot("S2", 2, 3, 3, 11)}, true), false)
	ctx = productionCall(t, s, runID, "production_storyboard_context", map[string]any{}, false)
	productionCall(t, s, runID, "production_storyboard_review", map[string]any{"hash": ctx["hash"], "review": "重新核对22秒预算与对白、动作和前后镜连续性，返修完成。", "repairSceneIds": []string{}}, false)
	m, _, _ = storyboardState(t, s, runID)
	if storyboardCoverage(m)["valid"] != true {
		t.Fatal("semantic budget repair did not finish")
	}
}
