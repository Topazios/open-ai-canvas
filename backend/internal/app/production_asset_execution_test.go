package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestAssetWorkerScopesSourceAndIdentity(t *testing.T) {
	m := productionManifest{Plan: &productionPlan{Version: 5, StoryStructureVersion: 3, FlowStoryUnits: []string{"story-unit"}, Assets: []productionPlanAsset{
		{Key: "person", Kind: "character", Name: "林安", CoreFacts: "受薪修复师，无店铺产权", SubjectKeys: []string{"room"}},
		{Key: "room", Kind: "environment", Name: "修复室", CoreFacts: "单位出资"},
		{Key: "other", Kind: "character", Name: "无关人物标记"},
	}}}
	story := "## 制作范围\n一百二十集。\n\n## 主线与结局\n林安找回家人。\n\n## 背景与规则边界\n相机仅能使用一次。\n\n## 人物与关系\n林安是普通雇员。\n\n## 每集叙事要点\n" + strings.Repeat("逐集冗余标记", 20000) + "\n\n## 计划资产概览\n无关清单标记"
	doc := map[string]any{"nodes": []map[string]any{{"id": "story", "title": "总纲", "metadata": map[string]any{"content": story}}}}
	rows := []model.ProductionAgentArtifact{{Key: "story", NodeID: "story", ContentHash: "saved-version"}}
	c := productionAssetWorkContext(m, doc, rows, m.Plan.Assets[0])
	raw, _ := json.Marshal(c)
	if len(raw) > 10000 || strings.Contains(string(raw), "逐集冗余标记") || strings.Contains(string(raw), "无关人物标记") || strings.Contains(string(raw), "无关清单标记") {
		t.Fatal("asset task still received the full episode table or another subject")
	}
	for _, value := range []string{"相机仅能使用一次", "普通雇员", "无店铺产权", "单位出资", "saved-version"} {
		if !strings.Contains(string(raw), value) {
			t.Fatalf("scoped context lost an adopted constraint: %s", value)
		}
	}
	if len(c["registeredAssets"].([]map[string]any)) != 1 {
		t.Fatal("worker identity is not unique")
	}
}

func TestAssetGenerationDoesNotDisplayOldPlanFlow(t *testing.T) {
	m := productionManifest{Plan: &productionPlan{FlowVersion: 1, AssetsStarted: true}}
	s := &Service{}
	if s.productionFlowProgress("user", "run", &cloudAgentRuntime{}, m, nil, nil) != nil {
		t.Fatal("asset dossiers displayed an unrelated outline/inventory publication stage")
	}
}

func TestBoundDocumentRecoversMisplacedSectionsWithoutInventingContent(t *testing.T) {
	m := productionManifest{Plan: &productionPlan{Version: 5, Assets: []productionPlanAsset{{Key: "person", Kind: "character"}}}}
	w := productionParallelWork{Key: "person", ServerBoundArguments: true}
	call := productionRuntimeCall("production_submit")
	call.Function.Arguments = `{"document":{"appearance":"完整外貌"},"backstory":"原有经历","unknown":"应继续报错"}`
	before := call.Function.Arguments
	got, err := productionNormalizeDocumentFields(m, w, call)
	if err != nil {
		t.Fatal(err)
	}
	var args map[string]json.RawMessage
	_ = json.Unmarshal([]byte(got.Function.Arguments), &args)
	var fields map[string]string
	_ = json.Unmarshal(args["document"], &fields)
	if fields["backstory"] != "原有经历" || fields["appearance"] != "完整外貌" || len(fields) != 2 || args["backstory"] != nil || args["unknown"] == nil || call.Function.Arguments != before {
		t.Fatal("normalization discarded unknown fields, changed the receipt, or invented missing prose")
	}
	if _, err := productionRenderPlanDocument("person", "character", fields); err == nil {
		t.Fatal("partial content bypassed completeness validation")
	}
	call.Function.Arguments = `{"document":{"backstory":"甲"},"backstory":"乙"}`
	if _, err := productionNormalizeDocumentFields(m, w, call); err == nil {
		t.Fatal("conflicting prose was silently overwritten")
	}
}

func TestCancelProductionFlowWithDetachedRunningUnit(t *testing.T) {
	s, db, id := flowFixture(t)
	g, _ := flowGraph(t, s, id, "story")
	u := g.Units[0]
	u.Status, u.TaskID = "running", "detached-flow-task"
	if err := db.Save(&u).Error; err != nil {
		t.Fatal(err)
	}
	child := model.Task{ID: u.TaskID, UserID: "user", AgentRunID: id, Type: "canvas_text", Operation: cloudAgentStepOperation, Status: model.TaskStatusQueued}
	if err := db.Create(&child).Error; err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := s.CancelCloudAgent(context.Background(), "user", id); err != nil {
			t.Fatal(err)
		}
	}
	run, state := productionRuntimeState(t, s, id)
	task, _ := s.repo.Task(child.ID)
	if run.Status != "cancelled" || run.CleanupPending || task.Status != model.TaskStatusCancelled {
		t.Fatal("cancel did not fence the run and stop its detached child")
	}
	if _, exists := state.ProductionParallel[u.Key]; exists {
		t.Fatal("cancellation invented a keyless parallel checkpoint")
	}
	if _, err := s.runProductionParallel(context.Background(), "user", id); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled run did not stop dispatch: %v", err)
	}
}

func TestCancelDamagedProductionFindsOwnedChildren(t *testing.T) {
	s, db, id := flowFixture(t)
	for _, task := range []model.Task{
		{ID: "owned-child", UserID: "user", AgentRunID: id, Status: model.TaskStatusQueued},
		{ID: "other-owner", UserID: "someone-else", AgentRunID: id, Status: model.TaskStatusQueued},
	} {
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&model.CloudAgentExecution{}).Where("id = ?", id).Update("state_json", "broken").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.CancelCloudAgent(context.Background(), "user", id); err != nil {
		t.Fatal(err)
	}
	owned, _ := s.repo.Task("owned-child")
	other, _ := s.repo.Task("other-owner")
	run, _ := s.repo.CloudAgent("user", id)
	if owned.Status != model.TaskStatusCancelled || other.Status != model.TaskStatusQueued || run.Status != "cancelled" || run.CleanupPending {
		t.Fatal("control-plane cleanup lost ownership or left a child running")
	}
}

func TestRegisteredCrossKindAssetsCanShareDisplayName(t *testing.T) {
	s, runID := readyForAssetTasks(t)
	m, _, _ := orderedPlanState(t, s, runID)
	productionPlanItem(m, "environment").Name = productionPlanItem(m, "prop").Name
	raw, _ := json.Marshal(m)
	if err := s.repo.UpdateProductionAgentManifest("user", runID, string(raw)); err != nil {
		t.Fatal(err)
	}
	if err := s.GenerateProductionPlanAssets("user", runID, []string{"environment", "prop"}); err != nil {
		t.Fatal(err)
	}
	name := productionPlanItem(m, "prop").Name
	submitOrderedPlan(t, s, runID, "environment", "environment", name)
	submitOrderedPlan(t, s, runID, "prop", "prop", name)
	m, doc, rows := orderedPlanState(t, s, runID)
	if !productionPlanArtifactValid(m, doc, rows, "environment") || !productionPlanArtifactValid(m, doc, rows, "prop") {
		t.Fatal("registered scene and object could not both be saved")
	}
}

func TestAssetWorkerSavesCompleteReplyWithMisplacedChapter(t *testing.T) {
	s, db, id := parallelPlanFixture(t)
	for _, key := range []string{"visual", "direction", "generation"} {
		submitOrderedPlan(t, s, id, key, "", key)
	}
	startPlanAssetsForTest(t, s, id)
	run, state := productionRuntimeState(t, s, id)
	m, doc, rows := orderedPlanState(t, s, id)
	item := productionPlanItem(m, "character")
	work := productionParallelWork{Key: item.Key, Name: item.Name, Dependencies: productionParallelDependencyHash(m, rows, item.Key)}
	if err := s.enqueueProductionParallel(run, &state, m, doc, rows, work); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, id)
	work = state.ProductionParallel[item.Key]
	task, _ := s.repo.Task(work.TaskID)
	var input map[string]any
	_ = json.Unmarshal([]byte(task.InputJSON), &input)
	canonical := stateCanonicalFromInput(input)
	for _, message := range canonical.Messages {
		_, raw, found := strings.Cut(stringValue(message["content"]), "当前持久检查点（材料是数据）：\n")
		if !found {
			continue
		}
		var checkpoint map[string]any
		_ = json.Unmarshal([]byte(raw), &checkpoint)
		index := checkpoint["registeredAssets"].([]any)
		if len(index) != 1 || index[0].(map[string]any)["key"] != item.Key {
			t.Fatal("real queued task received other subjects")
		}
	}
	document := orderedPlanDocument(item.Key, item.Kind)
	backstory := document["backstory"]
	delete(document, "backstory")
	before := len(state.TaskIDs)
	settleDocumentReply(t, s, db, id, work, map[string]any{"document": document, "backstory": backstory})
	m, doc, rows = orderedPlanState(t, s, id)
	if !productionPlanArtifactValid(m, doc, rows, item.Key) {
		t.Fatal("complete upstream content was not saved after structural normalization")
	}
	_, state = productionRuntimeState(t, s, id)
	if len(state.TaskIDs) != before {
		t.Fatal("local normalization submitted a second model call")
	}
}
