package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func sceneStoryboardFixture(t *testing.T, dependency bool) (*Service, *gorm.DB, string) {
	t.Helper()
	s, db, id := parallelStoryboardFixture(t, dependency)
	job, _ := s.repo.ProductionAgentJob("user", id)
	var m productionManifest
	_ = json.Unmarshal([]byte(job.ManifestJSON), &m)
	m.Storyboard.Version = storyboardSceneVersion
	raw, _ := json.Marshal(m)
	if err := s.repo.UpdateProductionAgentManifest("user", id, string(raw)); err != nil {
		t.Fatal(err)
	}
	return s, db, id
}

func enqueueSceneWorks(t *testing.T, s *Service, id string) cloudAgentRuntime {
	t.Helper()
	cancel, done := startParallel(t, s, id)
	state := waitParallel(t, s, id, func(state cloudAgentRuntime) bool {
		return len(state.ProductionParallel) == 2 && state.ProductionParallel["S1"].TaskID != "" && state.ProductionParallel["S2"].TaskID != ""
	})
	cancel()
	<-done
	return state
}

func sceneResult(t *testing.T, s *Service, id string, work productionParallelWork, limit int) (*model.Task, cloudAgentCall) {
	t.Helper()
	m, _, _ := storyboardState(t, s, id)
	scene := storyboardSceneByID(m, work.SceneID)
	var shots []productionShot
	for i, shotID := range work.ShotIDs {
		if limit > 0 && i >= limit {
			break
		}
		plan := scene.Layout[work.BatchOffset+i]
		shot := storyboardShot(work.SceneID, work.BatchOffset+i+1, plan.Start, plan.End, plan.Duration)
		shot.ID = shotID
		shots = append(shots, shot)
	}
	args, _ := json.Marshal(map[string]any{"sceneId": work.SceneID, "offset": work.BatchOffset, "expectedHash": storyboardSubmissionHash(m, *scene), "shots": shots, "complete": len(scene.Shots)+len(shots) == len(scene.Layout)})
	call := productionRuntimeCall("production_storyboard_submit")
	call.ID = "parallel-" + work.TaskID
	call.Function.Arguments = string(args)
	task, err := s.repo.Task(work.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	task.Status = model.TaskStatusSucceeded
	task.ResultJSON = productionRuntimeResult(t, call)
	return task, call
}

func TestStoryboardSceneConcurrentBatchesAndRecovery(t *testing.T) {
	s, db, id := sceneStoryboardFixture(t, false)
	state := enqueueSceneWorks(t, s, id)
	if len(state.TaskIDs) < 2 || len(state.StoryboardAssignments) != 2 {
		t.Fatal("scene assignments missing")
	}
	work := state.ProductionParallel["S2"]
	task, _ := sceneResult(t, s, id, work, 1)
	if err := s.settleProductionParallel("user", id, work, task); err != nil {
		t.Fatal(err)
	}
	m, _, rows := storyboardState(t, s, id)
	if m.Storyboard.Scenes[0].Complete || len(m.Storyboard.Scenes[1].Shots) != 1 || rows[1]["detailStatus"] != "ready" {
		t.Fatal("independent scene did not commit before its sibling")
	}
	// Restore only the coordinator; the first scene still owns its original call.
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	if _, err := restarted.recoverStoryboardCoordinator("user", id, "restart", true); err != nil {
		t.Fatal(err)
	}
	state2 := enqueueSceneWorks(t, restarted, id)
	if state2.ProductionParallel["S1"].TaskID != state.ProductionParallel["S1"].TaskID {
		t.Fatal("healthy child was reassigned")
	}
	if state2.ProductionParallel["S2"].BatchOffset != 1 || state2.ProductionParallel["S2"].Generation <= work.Generation {
		t.Fatal("saved batch was not used as checkpoint")
	}
	for _, key := range []string{"S2", "S1"} {
		work := state2.ProductionParallel[key]
		task, _ := sceneResult(t, restarted, id, work, 0)
		if err := restarted.settleProductionParallel("user", id, work, task); err != nil {
			t.Fatal(err)
		}
	}
	_, final := productionRuntimeState(t, restarted, id)
	p := restarted.productionAgentProgress("user", id, &final)
	if p.ExecutionMode != "scene" || p.ProcessedPages != 2 || p.ArtifactCount != 3 || p.Validated {
		t.Fatalf("wrong completion before main review: %+v", p)
	}
	if len(final.ProductionParallel) != 0 || final.StoryboardAssignments["S2"].Status != "completed" {
		t.Fatal("assignment did not settle")
	}
}

func TestStoryboardSceneExternalDependencyAndSiblingHash(t *testing.T) {
	s, _, id := sceneStoryboardFixture(t, true)
	state := enqueueSceneWorks(t, s, id)
	work := state.ProductionParallel["S2"]
	if len(work.ShotIDs) != 1 || work.ShotIDs[0] != "S2-001" {
		t.Fatal("batch crossed unfinished external dependency")
	}
	first := state.ProductionParallel["S1"]
	task, _ := sceneResult(t, s, id, first, 0)
	if err := s.settleProductionParallel("user", id, first, task); err != nil {
		t.Fatal(err)
	}
	// S1 completing must not invalidate S2's already assigned independent prefix.
	task, _ = sceneResult(t, s, id, work, 0)
	if err := s.settleProductionParallel("user", id, work, task); err != nil {
		t.Fatal(err)
	}
	_, after := productionRuntimeState(t, s, id)
	if after.ProductionParallel["S2"].Error != "" {
		t.Fatal("unrelated completion invalidated assigned prefix")
	}
}

func TestStoryboardSceneRevokeFencesLateResultsAndScope(t *testing.T) {
	s, _, id := sceneStoryboardFixture(t, false)
	state := enqueueSceneWorks(t, s, id)
	old := state.ProductionParallel["S2"]
	task, call := sceneResult(t, s, id, old, 0)
	if err := s.RetryProductionAgentItem("user", id, "S2"); err != nil {
		t.Fatal(err)
	}
	if err := s.commitProductionParallel("user", id, old, task, call); !errors.Is(err, repository.ErrCreationConflict) {
		t.Fatalf("late result accepted: %v", err)
	}
	state2 := enqueueSceneWorks(t, s, id)
	work := state2.ProductionParallel["S2"]
	if work.TaskID == old.TaskID || work.Generation <= old.Generation {
		t.Fatal("replacement reused revoked execution")
	}
	task, call = sceneResult(t, s, id, work, 0)
	var args map[string]any
	_ = json.Unmarshal([]byte(call.Function.Arguments), &args)
	args["sceneId"] = "S1"
	raw, _ := json.Marshal(args)
	call.Function.Arguments = string(raw)
	if err := s.commitProductionParallel("user", id, work, task, call); err == nil {
		t.Fatal("cross-scene write accepted")
	}
	m, _, _ := storyboardState(t, s, id)
	if len(m.Storyboard.Scenes[1].Shots) != 0 {
		t.Fatal("invalid writes leaked")
	}
}

func TestStoryboardSceneCheckpointAndEventAtomicReplay(t *testing.T) {
	s, db, id := sceneStoryboardFixture(t, false)
	state := enqueueSceneWorks(t, s, id)
	work := state.ProductionParallel["S2"]
	task, call := sceneResult(t, s, id, work, 0)
	before, _ := productionRuntimeState(t, s, id)
	fail := errors.New("injected journal write failure")
	name := "test:scene-event-failure"
	if err := db.Callback().Create().Before("gorm:create").Register(name, func(tx *gorm.DB) {
		if event, ok := tx.Statement.Dest.(*model.CloudAgentEventRecord); ok && strings.Contains(event.EventJSON, "production_scene_checkpoint") {
			tx.AddError(fail)
		}
	}); err != nil {
		t.Fatal(err)
	}
	err := s.commitProductionParallel("user", id, work, task, call)
	_ = db.Callback().Create().Remove(name)
	if !errors.Is(err, fail) {
		t.Fatalf("fault did not reach transaction: %v", err)
	}
	m, _, _ := storyboardState(t, s, id)
	after, _ := productionRuntimeState(t, s, id)
	if len(m.Storyboard.Scenes[1].Shots) != 0 || after.EventCount != before.EventCount {
		t.Fatal("partial result or notification survived rollback")
	}
	if err := s.commitProductionParallel("user", id, work, task, call); err != nil {
		t.Fatal(err)
	}
	var events []model.CloudAgentEventRecord
	if err := db.Where("run_id = ? AND sequence > ?", id, before.EventCount).Order("sequence").Find(&events).Error; err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range events {
		found = found || strings.Contains(event.EventJSON, "production_scene_checkpoint")
	}
	if !found {
		t.Fatal("no durable replay event after missed live notification")
	}
	_, reloaded := productionRuntimeState(t, s, id)
	if reloaded.StoryboardAssignments["S2"].Saved != 2 {
		t.Fatal("state cannot reconstruct saved progress")
	}
}

func TestStoryboardCoordinatorOwnershipAndStaleEvents(t *testing.T) {
	s, _, id := sceneStoryboardFixture(t, false)
	generation, err := s.claimStoryboardCoordinator("user", id)
	if err != nil || generation == 0 {
		t.Fatal(generation, err)
	}
	if _, err := s.claimStoryboardCoordinator("user", id); !errors.Is(err, context.Canceled) {
		t.Fatal("second coordinator acquired live lease", err)
	}
	ctx := context.WithValue(context.Background(), storyboardCoordinatorKey{}, generation)
	if _, err := s.recoverStoryboardCoordinator("user", id, "manual", true); err != nil {
		t.Fatal(err)
	}
	if err := s.checkStoryboardCoordinator(ctx, "user", id); !errors.Is(err, context.Canceled) {
		t.Fatal("stale main lease accepted")
	}
	payload := map[string]json.RawMessage{"type": json.RawMessage(`"session_snapshot"`), "sessionJSONL": json.RawMessage(`"obsolete"`)}
	if _, err := s.storyboardCoordinatorEvent(ctx, "user", id, payload); !errors.Is(err, context.Canceled) {
		t.Fatal("obsolete session snapshot accepted", err)
	}
	if err := s.completeCloudAgentPiRun("user", id, generation); !errors.Is(err, context.Canceled) {
		t.Fatal("obsolete main completed new run", err)
	}
}

func TestStoryboardReaperPreservesQueueReplacesExpiredWorker(t *testing.T) {
	s, db, id := sceneStoryboardFixture(t, false)
	state := enqueueSceneWorks(t, s, id)
	run, _ := productionRuntimeState(t, s, id)
	s.reapStoryboardRun(*run)
	_, same := productionRuntimeState(t, s, id)
	if same.ProductionParallel["S1"].TaskID != state.ProductionParallel["S1"].TaskID {
		t.Fatal("queued work was expired")
	}
	limits, err := s.cloudAgentStepLimits()
	if err != nil {
		t.Fatal(err)
	}
	if limits.Timeout <= 0 {
		t.Fatal("test needs configured execution timeout")
	}
	started := time.Now().Add(-limits.Timeout - 2*time.Minute)
	id1 := state.ProductionParallel["S1"].TaskID
	if err := db.Model(&model.Task{}).Where("id = ?", id1).Updates(map[string]any{"status": model.TaskStatusRunning, "started_at": started}).Error; err != nil {
		t.Fatal(err)
	}
	run, _ = productionRuntimeState(t, s, id)
	s.reapStoryboardRun(*run)
	_, next := productionRuntimeState(t, s, id)
	if next.ProductionParallel["S1"].TaskID != "" || next.ProductionParallel["S2"].TaskID != state.ProductionParallel["S2"].TaskID {
		t.Fatal("reaper failed to isolate expired worker")
	}
	old, _ := s.repo.Task(id1)
	if old.Status != model.TaskStatusCancelled {
		t.Fatal("expired worker not cancelled")
	}
}

func TestStoryboardSceneConcurrentClaimCreatesOneAssignment(t *testing.T) {
	s, _, id := sceneStoryboardFixture(t, false)
	run, state := productionRuntimeState(t, s, id)
	_, m, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		t.Fatal(err)
	}
	works := storyboardSceneReady(m)
	results := make(chan error, 2)
	for range 2 {
		go func() {
			copyState := state
			results <- s.enqueueProductionParallel(run, &copyState, m, doc, nil, works[0])
		}()
	}
	success, conflict := 0, 0
	for range 2 {
		err := <-results
		if err == nil {
			success++
		} else if errors.Is(err, repository.ErrCreationConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	_, after := productionRuntimeState(t, s, id)
	if success != 1 || conflict != 1 || len(after.TaskIDs) != len(state.TaskIDs)+1 || after.StoryboardAssignments["S1"].Generation != 1 {
		t.Fatal("duplicate scene claim was not atomic")
	}
}

func TestStoryboardAdaptiveGroupsUseWorkloadAndAllowSameSceneConcurrency(t *testing.T) {
	s, _, id := sceneStoryboardFixture(t, false)
	m, _, _ := storyboardState(t, s, id)
	m.Storyboard.AdaptiveWork = true
	scene := storyboardSceneByID(m, "S1")
	for i := 0; i < 8; i++ {
		plan := scene.Layout[0]
		plan.ID = fmt.Sprintf("S1-%03d", i+2)
		plan.TaskGroup = fmt.Sprintf("independent-%d", i+2)
		scene.Layout = append(scene.Layout, plan)
	}
	groups := storyboardWorkGroups(m)
	var sameScene []productionParallelWork
	for _, group := range groups {
		if group.SceneID == "S1" {
			sameScene = append(sameScene, group)
		}
	}
	if len(sameScene) != 9 {
		t.Fatalf("same-scene independent work was not split: %d", len(sameScene))
	}
	var readySameScene int
	for _, group := range storyboardSceneReady(m) {
		if group.SceneID == "S1" {
			readySameScene++
		}
	}
	if readySameScene != 9 {
		t.Fatalf("independent same-scene work was serialized: %d", readySameScene)
	}
	for i, group := range sameScene {
		if len(group.ShotIDs) != 1 || group.BatchOffset != i {
			t.Fatalf("unstable or oversized group: %+v", group)
		}
	}
}

func TestStoryboardAdaptiveGroupsCanCommitOutOfOrderAndDeriveCompletion(t *testing.T) {
	s, _, id := sceneStoryboardFixture(t, false)
	m, doc, _ := storyboardState(t, s, id)
	m.Storyboard.AdaptiveWork = true
	scene := storyboardSceneByID(m, "S2")
	scene.Layout[0].TaskGroup, scene.Layout[1].TaskGroup = "first", "second"
	groups := storyboardWorkGroups(m)
	var first, second productionParallelWork
	for _, group := range groups {
		if group.SceneID != "S2" {
			continue
		}
		if group.ShotIDs[0] == "S2-001" {
			first = group
		} else if group.ShotIDs[0] == "S2-002" {
			second = group
		}
	}
	if len(first.ShotIDs) != 1 || len(second.ShotIDs) != 1 {
		t.Fatal("fixture did not form independent sibling groups")
	}
	makeShot := func(id string, index, start int) productionShot {
		shot := storyboardShot("S2", index, start, start, 10)
		shot.ID = id
		return shot
	}
	// The later independent group can persist first; its provider complete bit
	// is intentionally false even though this is the scene's final missing shot.
	if err := applyStoryboardEpisodeBatch(m, doc, "S2", second.BatchOffset, storyboardSubmissionHash(m, *scene), []productionShot{makeShot("S2-002", 2, 3)}, false, second.Key); err != nil {
		t.Fatal(err)
	}
	if refreshed := storyboardSceneByID(m, "S2"); refreshed.Complete || len(refreshed.Shots) != 1 {
		t.Fatal("completion was not derived from persisted coverage")
	}
	if err := applyStoryboardEpisodeBatch(m, doc, "S2", first.BatchOffset, storyboardSubmissionHash(m, *scene), []productionShot{makeShot("S2-001", 1, 2)}, false, first.Key); err != nil {
		t.Fatal(err)
	}
	if refreshed := storyboardSceneByID(m, "S2"); !refreshed.Complete || len(refreshed.Shots) != 2 {
		t.Fatal("complete state was not derived after both siblings saved")
	}
}

func TestStoryboardLocalizedRepairPreservesGoodShotsAndResetsDependents(t *testing.T) {
	s, _, id := sceneStoryboardFixture(t, false)
	m, _, _ := storyboardState(t, s, id)
	m.Storyboard.AdaptiveWork = true
	scene := storyboardSceneByID(m, "S2")
	scene.Layout[1].DependsOn = []string{"S2-001"}
	scene.Shots = []productionShot{storyboardShot("S2", 1, 2, 2, 10), storyboardShot("S2", 2, 3, 3, 10)}
	scene.Complete = true
	s1 := storyboardSceneByID(m, "S1")
	s1.Shots, s1.Complete = []productionShot{storyboardShot("S1", 1, 1, 1, 10)}, true
	layoutHash := productionStoredValueHash(scene.Layout)
	if err := storyboardRepairShots(m, []string{"S2-001"}, nil); err != nil {
		t.Fatal(err)
	}
	if len(s1.Shots) != 1 || !s1.Complete {
		t.Fatal("unrelated scene was modified")
	}
	if len(scene.Shots) != 0 || len(scene.PreviousShots) != 2 || scene.Complete {
		t.Fatal("selected shot and its dependent were not preserved for targeted repair")
	}
	if productionStoredValueHash(scene.Layout) != layoutHash {
		t.Fatal("local content repair discarded the shot plan")
	}
}

func TestStoryboardCoordinatorFailureWaitsForManualRetryAndRejectsStaleWatchdog(t *testing.T) {
	s, _, id := sceneStoryboardFixture(t, false)
	gen, err := s.claimStoryboardCoordinator("user", id)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = s.recoverStoryboardCoordinator("user", id, "manual", true)
	newGen, err := s.claimStoryboardCoordinator("user", id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.recoverStoryboardCoordinator("user", id, "late failure", false, storyboardRecoveryExpectation{Generation: gen}); err != nil {
		t.Fatal(err)
	}
	_, state := productionRuntimeState(t, s, id)
	if state.StoryboardCoordinator.Generation != newGen {
		t.Fatal("stale coordinator killed replacement")
	}
	s.releaseStoryboardCoordinator("user", id, newGen)
	for range storyboardRecoveryLimit + 1 {
		if _, err := s.recoverStoryboardCoordinator("user", id, "same checkpoint", false); err != nil {
			t.Fatal(err)
		}
	}
	run, state := productionRuntimeState(t, s, id)
	if run.Status != "failed" || !state.ProductionPaused {
		t.Fatal("main failure did not wait for manual retry")
	}
}

func TestStoryboardManualRetryAfterParentStop(t *testing.T) {
	for _, action := range []string{"failure", "pause", "cancel"} {
		t.Run(action, func(t *testing.T) {
			s, _, id := sceneStoryboardFixture(t, false)
			state := enqueueSceneWorks(t, s, id)
			work := state.ProductionParallel["S2"]
			task, _ := sceneResult(t, s, id, work, 1)
			if err := s.settleProductionParallel("user", id, work, task); err != nil {
				t.Fatal(err)
			}
			m, _, _ := storyboardState(t, s, id)
			before := productionStoredValueHash(m.Storyboard.Scenes)
			var err error
			switch action {
			case "pause":
				err = s.ControlProductionAgent("user", id, "pause")
			case "cancel":
				err = s.CancelCloudAgent(context.Background(), "user", id)
			default:
				s.failPiRunner(id, "user", errors.New("main crashed"))
			}
			if err != nil {
				t.Fatal(err)
			}
			run, held := productionRuntimeState(t, s, id)
			if !held.ProductionPaused || run.Status == "running" {
				t.Fatal("parent did not stop")
			}
			for _, work := range held.ProductionParallel {
				if work.TaskID != "" || !work.QuietHold {
					t.Fatal("child remains active")
				}
			}
			child, _ := s.repo.Task(state.ProductionParallel["S1"].TaskID)
			if child.Status != model.TaskStatusCancelled {
				t.Fatal("queued child was not cancelled")
			}
			s.reapStoryboardRun(*run)
			if s.resumeQuietHeldProduction("user", id) {
				t.Fatal("automatic restart bypassed manual hold")
			}
			if err := s.retryStoryboardScene("user", id, "S1", false, ""); err == nil {
				t.Fatal("child retry revived stopped parent")
			}
			late, _ := sceneResult(t, s, id, state.ProductionParallel["S1"], 0)
			if err := s.settleProductionParallel("user", id, state.ProductionParallel["S1"], late); err == nil {
				t.Fatal("late child committed")
			}
			if err := s.ControlProductionAgent("user", id, "retry_main"); err != nil {
				t.Fatal(err)
			}
			run, resumed := productionRuntimeState(t, s, id)
			if run.Status != "running" || resumed.ProductionPaused {
				t.Fatal("manual retry did not resume")
			}
			m, _, _ = storyboardState(t, s, id)
			if productionStoredValueHash(m.Storyboard.Scenes) != before {
				t.Fatal("retry changed saved shots")
			}
			for _, work := range resumed.ProductionParallel {
				if work.Error != "" || work.QuietHold || work.TaskID != "" {
					t.Fatal("held assignment was not reset")
				}
			}
		})
	}
}

func TestStoryboardPromotionPreservesSavedShots(t *testing.T) {
	s, _, id := sceneStoryboardFixture(t, false)
	state := enqueueSceneWorks(t, s, id)
	for _, key := range []string{"S1", "S2"} {
		work := state.ProductionParallel[key]
		task, _ := sceneResult(t, s, id, work, 0)
		if err := s.settleProductionParallel("user", id, work, task); err != nil {
			t.Fatal(err)
		}
	}
	job, _ := s.repo.ProductionAgentJob("user", id)
	var m productionManifest
	_ = json.Unmarshal([]byte(job.ManifestJSON), &m)
	m.Storyboard.Version = storyboardEpisodeVersion
	before := productionStoredValueHash(m.Storyboard.Scenes)
	raw, _ := json.Marshal(m)
	if err := s.repo.UpdateProductionAgentManifest("user", id, string(raw)); err != nil {
		t.Fatal(err)
	}
	changed, err := s.promoteStoryboardScenes("user", id)
	if err != nil || !changed {
		t.Fatal(changed, err)
	}
	m, _, _ = storyboardState(t, s, id)
	if before != productionStoredValueHash(m.Storyboard.Scenes) || m.Storyboard.Version != storyboardSceneVersion {
		t.Fatal("migration changed valid shots")
	}
}

func TestStoryboardSceneChangingValidationFailuresAreBounded(t *testing.T) {
	s, db, id := sceneStoryboardFixture(t, false)
	state := enqueueSceneWorks(t, s, id)
	for attempt := 0; attempt < storyboardSceneValidationLimit; attempt++ {
		work := state.ProductionParallel["S2"]
		task, _ := sceneResult(t, s, id, work, 0)
		if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("status", model.TaskStatusSucceeded).Error; err != nil {
			t.Fatal(err)
		}
		if err := s.recordProductionParallelFailure("user", id, work, task, BadAuthRequest("invalid field "+task.ID), true); err != nil {
			t.Fatal(err)
		}
		_, state = productionRuntimeState(t, s, id)
		if attempt+1 < storyboardSceneValidationLimit {
			if state.ProductionParallel["S2"].QuietHold {
				t.Fatal("distinct repair stopped prematurely")
			}
			run, fresh := productionRuntimeState(t, s, id)
			_, m, doc, err := productionLoad(s.repo, run, &fresh)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.enqueueProductionParallel(run, &fresh, m, doc, nil, fresh.ProductionParallel["S2"]); err != nil {
				t.Fatal(err)
			}
			_, state = productionRuntimeState(t, s, id)
		}
	}
	if !state.ProductionParallel["S2"].QuietHold || state.ProductionParallel["S2"].TaskID != "" {
		t.Fatal("changing invalid outputs can retry without bound")
	}
	// Retry the actual validation-exhaustion state, not just explicit parent failure.
	before, _, _ := storyboardState(t, s, id)
	if err := s.ControlProductionAgent("user", id, "retry_main"); err != nil {
		t.Fatal(err)
	}
	run, resumed := productionRuntimeState(t, s, id)
	retried := resumed.ProductionParallel["S2"]
	if run.Status != "running" || resumed.ProductionPaused || retried.QuietHold || retried.Error != "" || retried.ValidationAttempts != 0 || retried.Notice != nil || len(retried.ValidationProblemHistory) != 0 {
		t.Fatal("validation hold survived manual restart", retried)
	}
	after, _, _ := storyboardState(t, s, id)
	if productionStoredValueHash(before.Storyboard.Scenes) != productionStoredValueHash(after.Storyboard.Scenes) {
		t.Fatal("manual retry changed durable shots")
	}
}

func TestStoryboardReaperCleansRevokedTasksAfterRunStops(t *testing.T) {
	s, db, id := sceneStoryboardFixture(t, false)
	state := enqueueSceneWorks(t, s, id)
	taskID := state.ProductionParallel["S1"].TaskID
	run, state := productionRuntimeState(t, s, id)
	if err := s.repo.MutateCloudAgent("user", id, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = "failed"
		revokeStoryboardTask(&state, taskID)
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	runs, err := s.repo.CloudAgentsWithRevokedTasksAfter("", 50)
	if err != nil || len(runs) != 1 || runs[0].ID != id {
		t.Fatal("terminal cleanup receipt was lost", runs, err)
	}
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	restarted.cleanupRevokedStoryboardTasks("user", id)
	task, _ := s.repo.Task(taskID)
	_, after := productionRuntimeState(t, s, id)
	if task.Status != model.TaskStatusCancelled || len(after.RevokedProductionTasks) != 0 {
		t.Fatal("terminal run leaked revoked work")
	}
}

func TestStoryboardCoordinatorRenewedLeaseRejectsStaleExpiry(t *testing.T) {
	s, _, id := sceneStoryboardFixture(t, false)
	gen, err := s.claimStoryboardCoordinator("user", id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.recoverStoryboardCoordinator("user", id, "stale expiry", false, storyboardRecoveryExpectation{Generation: gen, ExpiredLease: true}); err != nil {
		t.Fatal(err)
	}
	_, state := productionRuntimeState(t, s, id)
	if state.StoryboardCoordinator.Generation != gen || state.StoryboardCoordinator.Owner == "" {
		t.Fatal("watchdog revoked a healthy renewed lease")
	}
}
