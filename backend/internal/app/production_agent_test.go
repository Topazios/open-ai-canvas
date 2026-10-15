package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func productionFixture(t *testing.T, sourceText ...string) (*Service, *gorm.DB, *CloudAgentRun) {
	t.Helper()
	s, db, _, _ := creationTestService(t)
	s.legacyCloudAgentRootTask = false
	doc := map[string]any{"id": "agent-canvas", "title": "制作测试", "nodes": []any{
		map[string]any{"id": "body", "type": "text", "title": "第1集", "position": map[string]any{"x": 0, "y": 0}, "width": 400, "height": 280, "metadata": map[string]any{"content": "林岚提着旧相机走进照相馆。她说：我回来了。", "status": "success", "shortDrama": map[string]any{"pipelineId": "story", "step": "story.body", "stage": "story", "role": "document", "episodeNumber": 1, "sourceNodeIds": []string{}}}},
		map[string]any{"id": "bodies", "type": "frame", "title": "正文", "metadata": map[string]any{"shortDrama": map[string]any{"pipelineId": "story", "step": "story.body", "role": "collection", "sourceNodeIds": []string{"body"}}}},
		map[string]any{"id": "target", "type": "text", "title": "人物提取记录", "parentId": "group", "position": map[string]any{"x": 624, "y": 100}, "width": 400, "height": 280, "metadata": map[string]any{"content": "", "shortDrama": map[string]any{"stage": "assets", "step": "assets.characters", "pipelineId": "story", "role": "document", "assetKey": "$summary", "assetOutput": true, "sourceNodeIds": []string{"bodies"}, "sourceSignatures": map[string]string{"body": "fixture"}}}},
		map[string]any{"id": "group", "type": "frame", "title": "人物资产", "position": map[string]any{"x": 600, "y": 0}, "width": 448, "height": 404, "metadata": map[string]any{"frame": map[string]any{}, "shortDrama": map[string]any{"step": "assets.characters", "pipelineId": "story", "role": "collection", "sourceNodeIds": []string{"target"}, "assetGroup": map[string]any{"manifestId": "target"}}}},
	}, "connections": []any{map[string]any{"id": "link", "fromNodeId": "bodies", "toNodeId": "group"}}}
	creationMaps(doc["nodes"])[0]["parentId"] = "bodies"
	if len(sourceText) > 0 {
		creationMaps(doc["nodes"])[0]["metadata"].(map[string]any)["content"] = sourceText[0]
	}
	body, _ := json.Marshal(doc)
	if err := db.Create(&model.CanvasProject{ID: "agent-canvas", UserID: "user", Title: "制作测试", PayloadJSON: string(body), Revision: 1}).Error; err != nil {
		t.Fatal(err)
	}
	req := agentTestRequest()
	req.PermissionMode = "auto"
	req.Budget.MaxSteps = 40
	req.Production = &ProductionAgentRequest{TargetNodeID: "target"}
	req.ContextScope = nil
	run, err := s.CreateCloudAgentRun("user", req, "")
	if err != nil {
		t.Fatal(err)
	}
	return s, db, run
}
func productionCall(t *testing.T, s *Service, runID, name string, args any, wantError bool) map[string]any {
	t.Helper()
	body, _ := json.Marshal(args)
	call := cloudAgentCall{ID: newID()}
	call.Function.Name = name
	call.Function.Arguments = string(body)
	result, err := s.executeCloudAgentRuntimeTool(context.Background(), "user", runID, call)
	if err != nil {
		t.Fatal(err)
	}
	response := result.(map[string]any)
	var payload map[string]any
	if err = json.Unmarshal([]byte(response["content"].(string)), &payload); err != nil {
		t.Fatal(err)
	}
	if (response["isError"] == true) != wantError {
		t.Fatalf("%s error=%v result=%#v", name, response["isError"], payload)
	}
	return payload
}
func productionFirstPage(t *testing.T, s *Service, runID string) string {
	t.Helper()
	job, err := s.repo.ProductionAgentJob("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	var m productionManifest
	_ = json.Unmarshal([]byte(job.ManifestJSON), &m)
	return m.Sources[0].Pages[0]
}
func productionExtractFixture(t *testing.T, s *Service, runID string) string {
	t.Helper()
	pageID := productionFirstPage(t, s, runID)
	productionCall(t, s, runID, "production_read", map[string]any{"pageId": pageID}, false)
	productionCall(t, s, runID, "production_facts", map[string]any{"pageId": pageID, "facts": []workflowFact{{Kind: "character", Name: "林岚", Aliases: []string{}, Description: "林岚回到照相馆，持有旧相机。", Evidence: "林岚提着旧相机走进照相馆。"}, {Kind: "environment", Name: "照相馆", Aliases: []string{}, Description: "林岚进入的地点", Evidence: "林岚提着旧相机走进照相馆。"}}}, false)
	return pageID + ":1"
}
func productionEditCanvas(t *testing.T, s *Service, db *gorm.DB, fn func(map[string]any)) {
	t.Helper()
	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := creationDocument(canvas.PayloadJSON)
	fn(doc)
	body, _ := json.Marshal(doc)
	if err := db.Model(&model.CanvasProject{}).Where("id = ?", canvas.ID).Updates(map[string]any{"payload_json": string(body), "revision": canvas.Revision + 1}).Error; err != nil {
		t.Fatal(err)
	}
}

func TestProductionAgentDurableToolsAndCompletion(t *testing.T) {
	s, db, run := productionFixture(t)
	before := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if before["valid"] != false {
		t.Fatal("unread source accepted")
	}
	factID := productionExtractFixture(t, s, run.ID)
	query := productionCall(t, s, run.ID, "production_query", map[string]any{"kind": "character"}, false)
	if len(query["facts"].([]any)) != 1 {
		t.Fatal(query)
	}
	args := map[string]any{"key": "林岚", "name": "林岚", "document": productionTestDocument(), "factIds": []string{factID}}
	first := productionCall(t, s, run.ID, "production_submit", args, false)
	// Recreate the service to prove there is no browser/process-local progress.
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	replayed := productionCall(t, restarted, run.ID, "production_submit", args, false)
	if replayed["reused"] != true || first["nodeId"] != replayed["nodeId"] {
		t.Fatal(replayed)
	}
	rows, _ := s.repo.ProductionAgentArtifacts("user", run.ID)
	if len(rows) != 1 {
		t.Fatal("duplicate asset")
	}
	checked := productionCall(t, restarted, run.ID, "production_check", map[string]any{}, false)
	if checked["valid"] != true {
		t.Fatal(checked)
	}
	execution, _ := s.repo.CloudAgent("user", run.ID)
	if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, _ := cloudAgentDecode(current)
		state.PiAssistantResponses = 1
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err := restarted.completeCloudAgentPiRun("user", run.ID); err != nil {
		t.Fatal(err)
	}
	finished, err := restarted.CloudAgentRun("user", run.ID)
	if err != nil || finished.Status != "completed" || finished.Production.ArtifactCount != 1 {
		t.Fatalf("%#v %v", finished, err)
	}
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	if len(creationMaps(doc["nodes"])) != 5 || productionWorkflow(productionNode(doc, first["nodeId"].(string)))["step"] != "assets.characters" {
		t.Fatal("asset contract missing")
	}
	if productionWorkflow(productionNode(doc, "target"))["assetOutput"] != false {
		t.Fatal("client would rematerialize summary")
	}
	var taskCount int64
	db.Model(&model.Task{}).Count(&taskCount)
	if taskCount != 1 {
		t.Fatal("tool path made a billed model call")
	}
}

func TestProductionAgentRejectsFalseEvidenceAndManualOverwrite(t *testing.T) {
	s, db, run := productionFixture(t)
	page := productionFirstPage(t, s, run.ID)
	productionCall(t, s, run.ID, "production_facts", map[string]any{"pageId": page, "facts": []workflowFact{}}, true)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": page}, false)
	productionCall(t, s, run.ID, "production_facts", map[string]any{"pageId": page, "facts": []workflowFact{{Kind: "character", Name: "虚构", Description: "不存在", Evidence: "原文没有这句话"}}}, true)
	stored, _ := s.repo.ProductionAgentPage("user", page)
	if stored.Processed {
		t.Fatal("invalid facts committed")
	}
	fact := productionExtractFixture(t, s, run.ID)
	args := map[string]any{"key": "林岚", "name": "林岚", "document": productionTestDocument(), "factIds": []string{fact}}
	receipt := productionCall(t, s, run.ID, "production_submit", args, false)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		meta := productionNode(doc, receipt["nodeId"].(string))["metadata"].(map[string]any)
		meta["content"] = "用户正在修改"
	})
	args["expectedHash"] = receipt["hash"]
	args["content"] = "旧模型结果"
	productionCall(t, s, run.ID, "production_submit", args, true)
	checked := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if checked["valid"] != false {
		t.Fatal("edited artifact silently validated")
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		nodes := []map[string]any{}
		for _, node := range creationMaps(doc["nodes"]) {
			if node["id"] != receipt["nodeId"] {
				nodes = append(nodes, node)
			}
		}
		doc["nodes"] = nodes
	})
	productionCall(t, s, run.ID, "production_submit", args, true)
	if _, err := s.repo.ProductionAgentJob("other", run.ID); err == nil {
		t.Fatal("cross-user job readable")
	}
}

func TestProductionAgentSourceChangeAndSharedReuse(t *testing.T) {
	s, db, run := productionFixture(t)
	first := productionFirstPage(t, s, run.ID)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		target := productionNode(doc, "target")
		clone := map[string]any{}
		raw, _ := json.Marshal(target)
		_ = json.Unmarshal(raw, &clone)
		clone["id"] = "target2"
		clone["parentId"] = "group2"
		wd := productionWorkflow(clone)
		wd["step"] = "assets.environments"
		delete(wd, "productionAgent")
		frame := map[string]any{"id": "group2", "type": "frame", "metadata": map[string]any{"shortDrama": map[string]any{"sourceNodeIds": []string{"target2"}, "assetGroup": map[string]any{"manifestId": "target2"}}}}
		doc["nodes"] = append(creationMaps(doc["nodes"]), clone, frame)
	})
	req := agentTestRequest()
	req.PermissionMode = "auto"
	req.Budget.MaxSteps = 40
	req.Production = &ProductionAgentRequest{TargetNodeID: "target2"}
	req.IdempotencyKey = "second-category"
	req.ContextScope = nil
	second, err := s.CreateCloudAgentRun("user", req, "")
	if err != nil {
		t.Fatal(err)
	}
	if productionFirstPage(t, s, second.ID) != first {
		t.Fatal("categories repeated extraction identity")
	}
	if waiting, err := s.productionSharedPredecessor("user", second.ID, "agent-canvas"); err != nil || !waiting {
		t.Fatalf("second extraction did not wait: %v %v", waiting, err)
	}
	productionExtractFixture(t, s, run.ID)
	if waiting, err := s.productionSharedPredecessor("user", second.ID, "agent-canvas"); err != nil || waiting {
		t.Fatalf("shared page did not release: %v %v", waiting, err)
	}
	status := productionCall(t, s, second.ID, "production_status", map[string]any{}, false)
	if status["processedPages"] != float64(1) {
		t.Fatal("facts not reused", status)
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionNode(doc, "body")["metadata"].(map[string]any)["content"] = "正文已改动"
	})
	productionCall(t, s, second.ID, "production_query", map[string]any{}, true)
}

func TestProductionAgentPauseBoundaryAndResume(t *testing.T) {
	s, _, run := productionFixture(t)
	if err := s.ControlProductionAgent("other", run.ID, "pause"); err == nil {
		t.Fatal("foreign control accepted")
	}
	if err := s.ControlProductionAgent("user", run.ID, "pause"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := s.waitProductionAgentBoundary(ctx, "user", run.ID); err == nil {
		t.Fatal("paused boundary passed")
	}
	if err := s.ControlProductionAgent("user", run.ID, "resume"); err != nil {
		t.Fatal(err)
	}
	if err := s.waitProductionAgentBoundary(context.Background(), "user", run.ID); err != nil {
		t.Fatal(err)
	}
}

func TestProductionAgentEpisodeIsStoredAsOnePageAndNoPrematureComplete(t *testing.T) {
	original := strings.Repeat("林岚走进照相馆。\n", 1000)
	s, _, run := productionFixture(t, original)
	execution, _ := s.repo.CloudAgent("user", run.ID)
	if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, _ := cloudAgentDecode(current)
		state.PiAssistantResponses = 1
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.completeCloudAgentPiRun("user", run.ID); err == nil {
		t.Fatal("assistant text bypassed artifact check")
	}
	job, _ := s.repo.ProductionAgentJob("user", run.ID)
	var m productionManifest
	_ = json.Unmarshal([]byte(job.ManifestJSON), &m)
	var rebuilt strings.Builder
	if len(m.Sources[0].Pages) != 1 {
		t.Fatalf("expected one page per episode, got %d", len(m.Sources[0].Pages))
	}
	hash := ""
	for _, id := range m.Sources[0].Pages {
		page := productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": id}, false)
		body := page["text"].(string)
		if body != original {
			t.Fatal("episode body was truncated")
		}
		rebuilt.WriteString(body)
		facts := []workflowFact{}
		ids := []string{}
		for i := 0; i < 100; i++ {
			facts = append(facts, workflowFact{Kind: "character", Name: "林岚", Aliases: []string{}, Description: fmt.Sprintf("证据片段%d", i), Evidence: "林岚走进照相馆。"})
			ids = append(ids, fmt.Sprintf("%s:%d", id, i+1))
		}
		productionCall(t, s, run.ID, "production_facts", map[string]any{"pageId": id, "facts": facts}, false)
		receipt := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "林岚", "name": "林岚", "document": productionTestDocument(), "factIds": ids, "expectedHash": hash}, false)
		hash = receipt["hash"].(string)
	}
	if rebuilt.String() != original {
		t.Fatal("pagination lost source text")
	}
	rows, _ := s.repo.ProductionAgentArtifacts("user", run.ID)
	if len(rows) != 1 || len(productionIDs(json.RawMessage(rows[0].FactIDsJSON))) != 100 {
		t.Fatal("episode facts truncated")
	}
	check := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if check["valid"] != true {
		t.Fatal(check)
	}
}

func TestProductionAgentInitializationAndStatusRecovery(t *testing.T) {
	s, db, run := productionFixture(t)
	productionExtractFixture(t, s, run.ID)
	before, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err := s.initializeProductionAgent("user", run.ID); err != nil {
		t.Fatal(err)
	}
	after, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if before.Revision != after.Revision {
		t.Fatal("initialization replay reset canvas")
	}
	s.failPiRunner(run.ID, "user", fmt.Errorf("fixture upstream failure"))
	after, _ = s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(after.PayloadJSON)
	if productionNode(doc, "target")["metadata"].(map[string]any)["status"] != "error" {
		t.Fatal("failure still appears loading")
	}
	if err := s.ControlProductionAgent("user", run.ID, "resume"); err != nil {
		t.Fatal(err)
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) { productionNode(doc, "body")["parentId"] = "moved" })
	productionCall(t, s, run.ID, "production_query", map[string]any{}, true)
}

func TestProductionAgentSubmissionRollback(t *testing.T) {
	s, db, run := productionFixture(t)
	fact := productionExtractFixture(t, s, run.ID)
	before, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err := db.Exec(`CREATE TRIGGER reject_production_receipt BEFORE INSERT ON production_agent_artifacts BEGIN SELECT RAISE(ABORT, 'fixture write failed'); END`).Error; err != nil {
		t.Fatal(err)
	}
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "林岚", "name": "林岚", "content": "人物提示词", "factIds": []string{fact}}, true)
	after, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if after.PayloadJSON != before.PayloadJSON || after.Revision != before.Revision {
		t.Fatal("partial canvas mutation survived receipt failure")
	}
}

func TestProductionAgentModelReceiptReplayDoesNotEnqueue(t *testing.T) {
	s, db, run := productionFixture(t)
	messages := []map[string]any{{"role": "user", "content": "继续制作"}}
	key := productionHash([]any{messages, "off", []map[string]any(nil)})
	var call cloudAgentCall
	call.ID = "fixture-status"
	call.Function.Name = "production_status"
	call.Function.Arguments = "{}"
	result, _ := json.Marshal(map[string]any{"text": "", "toolCalls": []cloudAgentCall{call}})
	if err := db.Create(&model.Task{ID: "saved-model-step", UserID: "user", ProjectID: "agent-canvas", Type: "canvas_text", Status: model.TaskStatusSucceeded, ResultJSON: string(result)}).Error; err != nil {
		t.Fatal(err)
	}
	execution, _ := s.repo.CloudAgent("user", run.ID)
	if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, _ := cloudAgentDecode(current)
		state.TaskIDs = append(state.TaskIDs, "saved-model-step")
		state.ProductionModelReceipts = map[string]string{key: "saved-model-step"}
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	var before int64
	db.Model(&model.Task{}).Count(&before)
	for i := 0; i < 2; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_, _, err := s.runCloudAgentModelStep(ctx, "user", run.ID, messages, "off")
		cancel()
		if err != nil {
			t.Fatal(err)
		}
	}
	var after int64
	db.Model(&model.Task{}).Count(&after)
	if after != before {
		t.Fatal("model replay enqueued another billed task")
	}
}
