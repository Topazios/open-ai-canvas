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

func installFlowResponse(t *testing.T, s *Service, db *gorm.DB, runID string, u model.ProductionFlowUnit, raw string) (model.ProductionFlowUnit, productionParallelWork, *model.Task) {
	t.Helper()
	oldTask, oldGen := u.TaskID, u.Generation
	u.TaskID, u.Generation, u.Status, u.Attempts = newID(), u.Generation+1, "running", u.Attempts+1
	if err := s.repo.SaveProductionFlowUnit(&u, oldTask, oldGen); err != nil {
		t.Fatal(err)
	}
	w := productionParallelWork{FlowUnitID: u.ID, Key: u.Key, Name: u.Name, TaskID: u.TaskID, Generation: u.Generation}
	mutateParallelState(t, s, runID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		if state.ProductionParallel == nil {
			state.ProductionParallel = map[string]productionParallelWork{}
		}
		state.ProductionParallel[u.Key] = w
		state.TaskIDs = append(state.TaskIDs, u.TaskID)
	})
	call := cloudAgentCall{}
	call.Function.Name = productionFlowTool
	call.Function.Arguments = raw
	task := &model.Task{ID: u.TaskID, UserID: "user", Status: model.TaskStatusSucceeded, ResultJSON: productionFlowJSON(map[string]any{"toolCalls": []cloudAgentCall{call}})}
	if err := db.Create(task).Error; err != nil {
		t.Fatal(err)
	}
	return u, w, task
}

func TestProductionFlowCoordinatorPauseLateResultAndManualRecovery(t *testing.T) {
	s, db, id := flowFixture(t)
	g, _ := flowGraph(t, s, id, "story")
	run, state := productionRuntimeState(t, s, id)
	if changed, err := s.claimProductionFlow(run, &state, "owner-a"); err != nil || !changed {
		t.Fatal(changed, err)
	}
	run, state = productionRuntimeState(t, s, id)
	if _, err := s.claimProductionFlow(run, &state, "owner-b"); !errors.Is(err, context.Canceled) {
		t.Fatal("duplicate owner claimed", err)
	}
	u, w, task := installFlowResponse(t, s, db, id, g.Units[0], productionFlowJSON(flowReply(g.Units[0])))
	if handled, err := s.holdProductionFlow("user", id, "test pause"); err != nil || !handled {
		t.Fatal(err)
	}
	if err := s.settleProductionFlow("user", id, w, task); err != nil {
		t.Fatal(err)
	}
	saved, _ := s.repo.ProductionFlowUnit("user", id, u.ID)
	if saved.Status != "held" || saved.Generation == u.Generation || saved.ResultJSON != "{}" {
		t.Fatal("old writer adopted", saved)
	}
	run, state = productionRuntimeState(t, s, id)
	if err := s.repo.MutateCloudAgent("user", id, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		if err := productionFlowResetHeld(repo, current, &state, ""); err != nil {
			return err
		}
		state.ProductionPaused = false
		current.Status = "running"
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	run, state = productionRuntimeState(t, s, id)
	if _, err := s.claimProductionFlow(run, &state, "owner-new"); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, id)
	if state.ProductionParallel[u.Key].TaskID != task.ID {
		t.Fatal("successful result was regenerated")
	}
	if err := s.settleProductionFlow("user", id, state.ProductionParallel[u.Key], task); err != nil {
		t.Fatal(err)
	}
	saved, _ = s.repo.ProductionFlowUnit("user", id, u.ID)
	if saved.Status != "accepted" {
		t.Fatal(saved)
	}
}

func TestProductionFlowExpiredCoordinatorStopsInsteadOfDispatching(t *testing.T) {
	s, _, id := flowFixture(t)
	mutateParallelState(t, s, id, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.ProductionFlowCoordinator = storyboardCoordinator{Owner: "lost", Generation: 3, LeaseUntil: time.Now().Add(-time.Second).UnixMilli()}
	})
	run, state := productionRuntimeState(t, s, id)
	if _, err := s.claimProductionFlow(run, &state, "replacement"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	run, state = productionRuntimeState(t, s, id)
	if run.Status != "waiting_user" || !state.ProductionPaused || state.ProductionFlowCoordinator.Owner != "" {
		t.Fatal("expired root continued")
	}
}

func TestProductionFlowStorageRollbackReusesResponse(t *testing.T) {
	s, db, id := flowFixture(t)
	g, _ := flowGraph(t, s, id, "story")
	u, w, task := installFlowResponse(t, s, db, id, g.Units[0], productionFlowJSON(flowReply(g.Units[0])))
	if err := db.Callback().Create().Before("gorm:create").Register("flow_receipt_failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "production_flow_receipts" {
			tx.AddError(errors.New("test storage unavailable"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	err := s.settleProductionFlow("user", id, w, task)
	db.Callback().Create().Remove("flow_receipt_failure")
	if err == nil {
		t.Fatal("storage error swallowed")
	}
	saved, _ := s.repo.ProductionFlowUnit("user", id, u.ID)
	if saved.Status != "running" || saved.ResultJSON != "{}" {
		t.Fatal("partial transaction committed")
	}
	if err := s.settleProductionFlow("user", id, w, task); err != nil {
		t.Fatal(err)
	}
	receipts, _ := s.repo.ProductionFlowReceipts("user", id, u.ID)
	if len(receipts) != 1 {
		t.Fatal("response was not replayable")
	}
}

func TestProductionFlowInvalidJSONRemainsReadableInDetail(t *testing.T) {
	s, db, id := flowFixture(t)
	g, _ := flowGraph(t, s, id, "story")
	u, w, task := installFlowResponse(t, s, db, id, g.Units[0], `{"premise":`)
	if err := s.settleProductionFlow("user", id, w, task); err != nil {
		t.Fatal(err)
	}
	detail, err := s.ProductionFlowUnitDetail("user", id, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := json.Marshal(detail); err != nil {
		t.Fatal("malformed response broke diagnostic API", err)
	}
}

func TestProductionFlowFieldRestructureAggregatesWithoutRepeatingGoodFields(t *testing.T) {
	u := model.ProductionFlowUnit{ID: "parent", Key: "flow/story/foundation", Stage: "foundation", InputJSON: "{}", ResultJSON: productionFlowJSON(map[string]any{"premise": "林岚找回家人。"})}
	if !productionFlowRestructure(&u) {
		t.Fatal("did not split missing fields")
	}
	g := productionFlowGraph{Root: "story", Existing: map[string]model.ProductionFlowUnit{u.ID: u}}
	g.splitChildren(u)
	if len(g.Units) != 1 {
		t.Fatal("regenerated accepted fields", len(g.Units))
	}
	for i := range g.Units {
		child := &g.Units[i]
		if productionFlowRestructure(child) {
			t.Fatal("recursive split allowed")
		}
		reply := map[string]any{}
		for _, field := range productionFlowUnitFields(*child) {
			reply[field] = "她追查线索并与家人团聚。"
		}
		result, issues := productionFlowValidate(*child, productionFlowJSON(reply))
		if len(issues) > 0 {
			t.Fatal(issues)
		}
		child.ResultJSON, child.Status = result, "accepted"
	}
	result, issues := productionFlowAggregate(u, g.Units)
	if len(issues) > 0 || !strings.Contains(result, "林岚找回家人") {
		t.Fatal(result, issues)
	}
}

func TestProductionFlowResumeIgnoresObsoleteAssignments(t *testing.T) {
	s, db, id := flowFixture(t)
	g, _ := flowGraph(t, s, id, "story")
	u := g.Units[0]
	u.Status = "held"
	if err := s.repo.SaveProductionFlowUnit(&u, u.TaskID, u.Generation); err != nil {
		t.Fatal(err)
	}
	stale := u
	stale.ID, stale.SourceHash, stale.TaskID = newID(), "obsolete-source", newID()
	if err := s.repo.EnsureProductionFlowUnit(&stale); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Task{ID: stale.TaskID, UserID: "user", Status: model.TaskStatusRunning}).Error; err != nil {
		t.Fatal(err)
	}
	run, state := productionRuntimeState(t, s, id)
	if err := s.repo.MutateCloudAgent("user", id, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		return productionFlowResetHeld(repo, current, &state, "")
	}); err != nil {
		t.Fatal("obsolete request prevented current resume", err)
	}
	current, _ := s.repo.ProductionFlowUnit("user", id, u.ID)
	old, _ := s.repo.ProductionFlowUnit("user", id, stale.ID)
	if current.Status != "repair" || old.Status != "held" || old.TaskID != stale.TaskID {
		t.Fatal("resume changed obsolete scope", current, old)
	}
}

func TestProductionFlowSplitCardsAndExtractionRevalidateOriginalScope(t *testing.T) {
	for _, stage := range []string{"cards", "extract"} {
		t.Run(stage, func(t *testing.T) {
			input := map[string]any{"start": 1, "end": 3, "registry": []productionPlanningAsset{{Key: productionPlanningAssetKey("character", "林岚"), Kind: "character", Name: "林岚"}}}
			if stage == "extract" {
				input = map[string]any{"sources": []productionFlowSource{{ID: "src", Text: "林岚走进照相馆。\n林岚拿起了相机。"}}}
			}
			u := model.ProductionFlowUnit{ID: "parent", Key: "flow/story/" + stage, Stage: stage, SourceHash: "v1", InputJSON: productionFlowJSON(input), ResultJSON: "{}"}
			if stage == "cards" {
				full := flowReply(u).(map[string]any)
				u.ResultJSON = productionFlowJSON(map[string]any{"episodes": full["episodes"].([]any)[:1]})
			}
			if !productionFlowRestructure(&u) {
				t.Fatal("split missing")
			}
			g := productionFlowGraph{Root: "story", Existing: map[string]model.ProductionFlowUnit{}}
			g.splitChildren(u)
			if len(g.Units) != 2 {
				t.Fatal("unexpected child count", len(g.Units))
			}
			for i := range g.Units {
				child := &g.Units[i]
				result, issues := productionFlowValidate(*child, productionFlowJSON(flowReply(*child)))
				if len(issues) != 0 {
					t.Fatal(issues)
				}
				child.ResultJSON, child.Status = result, "accepted"
			}
			result, issues := productionFlowAggregate(u, g.Units)
			if len(issues) != 0 {
				t.Fatal(result, issues)
			}
			value := productionFlowValue(model.ProductionFlowUnit{ResultJSON: result})
			if stage == "cards" {
				var episodes []map[string]any
				_ = decodeFlowValue(value["episodes"], &episodes)
				if len(episodes) != 3 {
					t.Fatal("lost accepted episode", result)
				}
			} else {
				var candidates []productionFlowCandidate
				_ = decodeFlowValue(value["candidates"], &candidates)
				if len(candidates) != 2 || len(candidates[1].Locations) == 0 {
					t.Fatal("lost extraction evidence", result)
				}
			}
		})
	}
}

func TestProductionFlowResolveSplitKeepsAdoptedMembers(t *testing.T) {
	candidates := []productionFlowCandidate{{ID: "a", Kind: "character"}, {ID: "b", Kind: "character"}, {ID: "c", Kind: "character"}}
	u := model.ProductionFlowUnit{ID: "parent", Key: "flow/inventory/resolve", Stage: "resolve", SourceHash: "v1", InputJSON: productionFlowJSON(map[string]any{"kind": "character", "assignedCandidates": candidates}), ResultJSON: "{}"}
	partial := []productionFlowEntity{{Name: "林岚", Members: []string{"a"}, Disposition: "asset", Reason: "故事主角"}}
	u.ResultJSON, _ = productionFlowValidate(u, productionFlowJSON(map[string]any{"entities": partial}))
	if !productionFlowRestructure(&u) {
		t.Fatal("resolve did not split")
	}
	existing := map[string]model.ProductionFlowUnit{}
	var children []model.ProductionFlowUnit
	for iteration := 0; iteration < 3; iteration++ {
		g := productionFlowGraph{Root: "inventory", Existing: existing}
		g.splitChildren(u)
		children = g.Units
		for i := range children {
			child := &children[i]
			if child.Status == "accepted" {
				continue
			}
			var assigned []productionFlowCandidate
			_ = decodeFlowValue(productionFlowInput(*child)["assignedCandidates"], &assigned)
			for _, candidate := range assigned {
				if candidate.ID == "a" {
					t.Fatal("redispatched accepted identity")
				}
			}
			result, issues := productionFlowValidate(*child, productionFlowJSON(flowReply(*child)))
			if len(issues) != 0 {
				t.Fatal(issues)
			}
			child.ResultJSON, child.Status = result, "accepted"
			existing[child.ID] = *child
		}
	}
	result, issues := productionFlowAggregate(u, children)
	if len(issues) != 0 {
		t.Fatal(result, issues)
	}
	var entities []productionFlowEntity
	_ = decodeFlowValue(productionFlowValue(model.ProductionFlowUnit{ResultJSON: result})["entities"], &entities)
	if len(entities) != 1 || len(entities[0].Members) != 3 {
		t.Fatal("accepted or split identity lost", result)
	}
}

func TestProductionFlowUnknownCandidateFieldsDoNotDiscardGoodSiblings(t *testing.T) {
	u := model.ProductionFlowUnit{Stage: "extract", SourceHash: "v1", InputJSON: productionFlowJSON(map[string]any{"sources": []productionFlowSource{{ID: "src", Text: "甲拿相机。乙读信。"}}}), ResultJSON: "{}"}
	good := map[string]any{"localRef": "a", "label": "甲", "kind": "character", "sourceRef": "src", "quote": "甲拿相机", "basis": "explicit", "action": "拿相机", "state": "", "context": "行动者甲", "reason": "实际在场"}
	bad := productionFlowInput(model.ProductionFlowUnit{InputJSON: productionFlowJSON(good)})
	bad["localRef"], bad["unexpected"] = "b", "must not disappear"
	result, issues := productionFlowValidate(u, productionFlowJSON(map[string]any{"candidates": []any{good, bad}, "noAssetsReason": ""}))
	var adopted []productionFlowCandidate
	_ = decodeFlowValue(productionFlowValue(model.ProductionFlowUnit{ResultJSON: result})["candidates"], &adopted)
	if len(issues) == 0 || len(adopted) != 1 {
		t.Fatal(result, issues)
	}
}

func TestProductionFlowSameNameIdentityAndStateCanonicalName(t *testing.T) {
	candidates := []productionFlowCandidate{{ID: "a", Kind: "character"}, {ID: "b", Kind: "character"}}
	u := model.ProductionFlowUnit{SourceHash: "v", Stage: "resolve", InputJSON: productionFlowJSON(map[string]any{"kind": "character", "assignedCandidates": candidates, "existingEntities": []any{}}), ResultJSON: "{}"}
	reply := []productionFlowEntity{{Name: "林岚", Members: []string{"a"}, Disposition: "asset", Reason: "甲地成人"}, {Name: "林岚", Members: []string{"b"}, Disposition: "asset", Reason: "乙地同名儿童"}}
	result, issues := productionFlowValidate(u, productionFlowJSON(map[string]any{"entities": reply}))
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	var entities []productionFlowEntity
	_ = decodeFlowValue(productionFlowValue(model.ProductionFlowUnit{ResultJSON: result})["entities"], &entities)
	if len(entities) != 2 || entities[0].ID == entities[1].ID {
		t.Fatal("same name collapsed")
	}
	u.InputJSON = productionFlowJSON(map[string]any{"kind": "character", "assignedCandidates": candidates[:1], "existingEntities": entities})
	reply = []productionFlowEntity{{Name: "小林", Members: []string{"a"}, Existing: entities[0].ID, Disposition: "state", Reason: "同一人昵称"}}
	result, issues = productionFlowValidate(u, productionFlowJSON(map[string]any{"entities": reply}))
	if len(issues) > 0 {
		t.Fatal(issues)
	}
	_ = decodeFlowValue(productionFlowValue(model.ProductionFlowUnit{ResultJSON: result})["entities"], &entities)
	if entities[0].Name != "林岚" || len(entities[0].Aliases) != 1 {
		t.Fatal("canonical identity renamed", result)
	}
}

func TestProductionFlowNewManifestOnlyOptsInNewRuns(t *testing.T) {
	s, _, run := planFixture(t, 5)
	execution, state := productionRuntimeState(t, s, run.ID)
	canvas, err := s.repo.CanvasProjectForUser("user", state.Request.CanvasID)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := productionSourceManifest(canvas, state.Request)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Plan.FlowVersion != 1 {
		t.Fatal("fresh plan did not opt in")
	}
	if len(fresh.Plan.FlowStoryUnits) != 0 || fresh.Plan.InventoryReviewVersion != 1 {
		t.Fatal("unadopted/imported text lost source-review protection before structured publication")
	}
	_, persisted, _, err := productionLoad(s.repo, execution, &state)
	if err != nil || persisted.Plan.FlowVersion != 0 {
		t.Fatal("reading changed persisted legacy contract", err)
	}
}

func TestProductionFlowPublicationProtectsEditedOrDeletedTarget(t *testing.T) {
	for _, mode := range []string{"edit", "delete", "source"} {
		t.Run(mode, func(t *testing.T) {
			s, db, id := flowFixture(t)
			var graph productionFlowGraph
			for iteration := 0; iteration < 20; iteration++ {
				g, done := flowGraph(t, s, id, "story")
				if done {
					graph = g
					break
				}
				for _, u := range g.Units {
					if u.Status == "pending" {
						settleFlowReply(t, s, db, id, u, flowReply(u))
					}
				}
			}
			if len(graph.Units) == 0 {
				t.Fatal("no completed graph")
			}
			productionEditCanvas(t, s, db, func(doc map[string]any) {
				if mode == "source" {
					productionNode(doc, "body")["metadata"].(map[string]any)["content"] = "人工更换选题"
					return
				}
				if mode == "delete" {
					nodes, _ := doc["nodes"].([]any)
					kept := []any{}
					for _, node := range nodes {
						if node.(map[string]any)["id"] != "target" {
							kept = append(kept, node)
						}
					}
					doc["nodes"] = kept
					return
				}
				productionNode(doc, "target")["metadata"].(map[string]any)["content"] = "人工保留的草稿"
			})
			run, state := productionRuntimeState(t, s, id)
			job, _ := s.repo.ProductionAgentJob("user", id)
			var manifest productionManifest
			_ = json.Unmarshal([]byte(job.ManifestJSON), &manifest)
			canvas, _ := s.repo.CanvasProjectForUser("user", state.Request.CanvasID)
			doc, _ := creationDocument(canvas.PayloadJSON)
			if err := s.publishProductionFlow(run, &state, manifest, doc, nil, graph); err == nil {
				t.Fatal("obsolete result published")
			}
			rows, _ := s.repo.ProductionFlowUnits("user", id, "story", graph.Source)
			for _, u := range rows {
				if u.Status != "accepted" {
					t.Fatal("protected draft lost")
				}
			}
		})
	}
}

func TestProductionFlowQueueAdmissionIsAtomicAndHonorsOutputConfiguration(t *testing.T) {
	s, db, id := flowFixture(t)
	policy := defaultRuntimePolicy()
	policy.Task.AgentStepMaxOutputTokens = 2048
	if _, err := s.UpdateRuntimePolicySetting(&model.User{ID: "admin", Role: model.UserRoleAdmin}, policy); err != nil {
		t.Fatal(err)
	}
	g, _ := flowGraph(t, s, id, "story")
	run, state := productionRuntimeState(t, s, id)
	if _, err := s.claimProductionFlow(run, &state, "scheduler"); err != nil {
		t.Fatal(err)
	}
	run, state = productionRuntimeState(t, s, id)
	if err := s.enqueueProductionFlow(run, &state, g.Units[0]); err != nil {
		t.Fatal(err)
	}
	unit, _ := s.repo.ProductionFlowUnit("user", id, g.Units[0].ID)
	if unit.Status != "running" || unit.TaskID == "" || unit.Attempts != 1 {
		t.Fatal("claim not persisted")
	}
	task, err := s.repo.TaskForUser("user", unit.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if got := stepTaskTextOptions(t, s, task)["maxOutputTokens"]; got != float64(2048) {
		t.Fatal("configured cap changed", got)
	}
	var before, after int64
	db.Model(&model.Task{}).Count(&before)
	run, state = productionRuntimeState(t, s, id)
	if err := s.enqueueProductionFlow(run, &state, g.Units[0]); !errors.Is(err, repository.ErrCreationConflict) {
		t.Fatal("duplicate claim admitted", err)
	}
	db.Model(&model.Task{}).Count(&after)
	if before != after {
		t.Fatal("duplicate task persisted")
	}
}

func TestProductionFlowSchedulerPublishesAndStopsAtStoryBoundary(t *testing.T) {
	s, db, id := flowFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := s.runProductionParallel(ctx, "user", id); done <- err }()
	for {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
			run, state := productionRuntimeState(t, s, id)
			_, m, doc, err := productionLoad(s.repo, run, &state)
			if err != nil {
				t.Fatal(err)
			}
			rows, _ := s.repo.ProductionAgentArtifacts("user", id)
			if !productionPlanArtifactValid(m, doc, rows, "story") || m.Plan.PlansStarted {
				t.Fatal("wrong phase boundary")
			}
			return
		case <-ctx.Done():
			t.Fatal("scheduler stalled")
		case <-time.After(15 * time.Millisecond):
			units, err := s.repo.ProductionFlowUnits("user", id, "story", "")
			if err != nil {
				t.Fatal(err)
			}
			for _, u := range units {
				if u.Status != "running" {
					continue
				}
				call := cloudAgentCall{}
				call.Function.Name = productionFlowTool
				call.Function.Arguments = productionFlowJSON(flowReply(u))
				if err := db.Model(&model.Task{}).Where("id = ? AND status = ?", u.TaskID, model.TaskStatusQueued).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": productionFlowJSON(map[string]any{"toolCalls": []cloudAgentCall{call}})}).Error; err != nil {
					t.Fatal(err)
				}
			}
		}
	}
}
