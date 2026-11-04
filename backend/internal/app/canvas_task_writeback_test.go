package app

import (
	"context"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func writebackAddNode(t *testing.T, s *Service, db *gorm.DB, node map[string]any) {
	t.Helper()
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		doc["nodes"] = append(creationMaps(doc["nodes"]), node)
	})
}

func writebackNode(t *testing.T, s *Service, id string) map[string]any {
	t.Helper()
	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := creationDocument(canvas.PayloadJSON)
	for _, n := range creationMaps(doc["nodes"]) {
		if n["id"] == id {
			return n
		}
	}
	t.Fatalf("node %s missing", id)
	return nil
}

func writebackMeta(n map[string]any) map[string]any {
	m, _ := n["metadata"].(map[string]any)
	return m
}

func writebackTask(t *testing.T, db *gorm.DB, id, taskType, nodeID, result string, status model.TaskStatus) model.Task {
	t.Helper()
	now := time.Now()
	start := now.Add(-40 * time.Second)
	task := model.Task{ID: id, UserID: "user", ProjectID: "agent-canvas", Type: taskType, Status: status, Prompt: "一只猫",
		Model: "img-model", Progress: 100, StartedAt: &start, CompletedAt: &now, ResultJSON: result,
		InputJSON: `{"metadata":{"nodeId":"` + nodeID + `"}}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	return task
}

func writebackResource(t *testing.T, db *gorm.DB, id, mime string, w, h int) {
	t.Helper()
	if err := db.Create(&model.Resource{ID: id, UserID: "user", Status: "ready", MimeType: mime, Size: 1234, Width: w, Height: h, DurationMs: 3000}).Error; err != nil {
		t.Fatal(err)
	}
}

func loadingNode(id, typ string, extra map[string]any) map[string]any {
	meta := map[string]any{"status": "loading"}
	for k, v := range extra {
		meta[k] = v
	}
	return map[string]any{"id": id, "type": typ, "width": float64(200), "height": float64(200), "position": map[string]any{"x": 0, "y": 0}, "metadata": meta}
}

func TestWritebackImageWithoutFrontend(t *testing.T) {
	s, db, _ := productionFixture(t)
	writebackAddNode(t, s, db, loadingNode("img", "image", map[string]any{"taskId": "t1", "assetId": "old", "producedModelCandidate": "cand"}))
	writebackResource(t, db, "res1", "image/png", 200, 100)
	task := writebackTask(t, db, "t1", "image", "img", `{"resourceId":"resource:res1"}`, model.TaskStatusSucceeded)
	if err := s.writeTaskResultToCanvas(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	node := writebackNode(t, s, "img")
	meta := writebackMeta(node)
	if meta["status"] != "success" || meta["content"] != resourceFileURL("res1") || meta["storageKey"] != "resource:res1" {
		t.Fatalf("unexpected meta %#v", meta)
	}
	if meta["taskStatus"] != "succeeded" || meta["producedModel"] != "cand" || meta["assetId"] != nil || meta["producedModelCandidate"] != nil {
		t.Fatalf("unexpected meta %#v", meta)
	}
	if node["height"].(float64) != 100 {
		t.Fatalf("height=%v", node["height"])
	}
	// 重复回写保持幂等。
	if err := s.writeTaskResultToCanvas(context.Background(), task); err != nil {
		t.Fatal(err)
	}
}

func TestWritebackVideoAudioText(t *testing.T) {
	s, db, _ := productionFixture(t)
	writebackAddNode(t, s, db, loadingNode("vid", "video", map[string]any{"taskId": "tv"}))
	writebackAddNode(t, s, db, loadingNode("aud", "audio", map[string]any{"taskId": "ta"}))
	writebackAddNode(t, s, db, loadingNode("txt", "text", map[string]any{"taskId": "tt", "richText": "<p>x</p>"}))
	writebackResource(t, db, "rv", "video/mp4", 1920, 1080)
	writebackResource(t, db, "ra", "audio/mpeg", 0, 0)
	for _, task := range []model.Task{
		writebackTask(t, db, "tv", "video", "vid", `{"resourceId":"resource:rv"}`, model.TaskStatusSucceeded),
		writebackTask(t, db, "ta", "audio", "aud", `{"resourceId":"resource:ra"}`, model.TaskStatusSucceeded),
		writebackTask(t, db, "tt", "text", "txt", `{"mode":"text","text":"你好"}`, model.TaskStatusSucceeded),
	} {
		if err := s.writeTaskResultToCanvas(context.Background(), task); err != nil {
			t.Fatal(err)
		}
	}
	if m := writebackMeta(writebackNode(t, s, "vid")); m["status"] != "success" || m["durationMs"] != float64(3000) {
		t.Fatalf("video %#v", m)
	}
	if m := writebackMeta(writebackNode(t, s, "aud")); m["status"] != "success" || m["mimeType"] != "audio/mpeg" {
		t.Fatalf("audio %#v", m)
	}
	if m := writebackMeta(writebackNode(t, s, "txt")); m["content"] != "你好" || m["richText"] != "" || m["status"] != "success" {
		t.Fatalf("text %#v", m)
	}
}

func TestWritebackBindingRules(t *testing.T) {
	s, db, _ := productionFixture(t)
	writebackAddNode(t, s, db, loadingNode("other", "text", map[string]any{"taskId": "someone-else"}))
	writebackAddNode(t, s, db, loadingNode("empty", "text", nil))
	writebackAddNode(t, s, db, loadingNode("filled", "text", map[string]any{"status": "success", "content": "手写内容"}))
	for id, node := range map[string]string{"x1": "other", "x2": "empty", "x3": "filled", "x4": "deleted"} {
		task := writebackTask(t, db, id, "text", node, `{"mode":"text","text":"结果"}`, model.TaskStatusSucceeded)
		if err := s.writeTaskResultToCanvas(context.Background(), task); err != nil {
			t.Fatal(err)
		}
	}
	if m := writebackMeta(writebackNode(t, s, "other")); m["taskId"] != "someone-else" || m["content"] != nil {
		t.Fatalf("other-task node overwritten %#v", m)
	}
	if m := writebackMeta(writebackNode(t, s, "empty")); m["content"] != "结果" || m["taskId"] != "x2" {
		t.Fatalf("unbound empty node not written %#v", m)
	}
	if m := writebackMeta(writebackNode(t, s, "filled")); m["content"] != "手写内容" || m["taskId"] != nil {
		t.Fatalf("user content overwritten %#v", m)
	}
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	for _, n := range creationMaps(doc["nodes"]) {
		if n["id"] == "deleted" {
			t.Fatal("deleted node recreated")
		}
	}
}

func TestWritebackFailedAndCancelled(t *testing.T) {
	s, db, _ := productionFixture(t)
	writebackAddNode(t, s, db, loadingNode("bad", "image", map[string]any{"taskId": "f1"}))
	writebackAddNode(t, s, db, loadingNode("stop", "image", map[string]any{"taskId": "c1"}))
	failed := writebackTask(t, db, "f1", "image", "bad", "", model.TaskStatusFailed)
	cancelled := writebackTask(t, db, "c1", "image", "stop", "", model.TaskStatusCancelled)
	for _, task := range []model.Task{failed, cancelled} {
		if err := s.writeTaskResultToCanvas(context.Background(), task); err != nil {
			t.Fatal(err)
		}
	}
	if m := writebackMeta(writebackNode(t, s, "bad")); m["status"] != "error" || m["taskStatus"] != "failed" || m["errorDetails"] == nil {
		t.Fatalf("failed %#v", m)
	}
	if m := writebackMeta(writebackNode(t, s, "stop")); m["status"] != "idle" || m["taskStatus"] != "cancelled" {
		t.Fatalf("cancelled %#v", m)
	}
}

func TestWritebackFailedScreenplayAuditPreservesBodyAndMarksRetryableError(t *testing.T) {
	s, db, _ := productionFixture(t)
	shortDrama := map[string]any{
		"step":            "body",
		"screenplayAudit": map[string]any{"bodyNodeId": "body", "contextNodeIds": []any{}},
	}
	node := loadingNode("audit", "text", map[string]any{
		"content":    "第1集正文原文",
		"shortDrama": shortDrama,
	})
	writebackAddNode(t, s, db, node)
	task := writebackTask(t, db, "audit-timeout", "text", "audit", "", model.TaskStatusFailed)
	task.Error = "上游模型请求超时"
	if err := s.writeTaskResultToCanvas(context.Background(), task); err != nil {
		t.Fatal(err)
	}

	meta := writebackMeta(writebackNode(t, s, "audit"))
	if meta["status"] != "error" || meta["taskStatus"] != string(model.TaskStatusFailed) || meta["taskId"] != task.ID {
		t.Fatalf("diagnosis task state was not written back: %#v", meta)
	}
	if meta["content"] != "第1集正文原文" {
		t.Fatalf("diagnosis failure overwrote the source body: %#v", meta["content"])
	}
	if got := meta["errorDetails"]; got == nil || got == "" {
		t.Fatalf("diagnosis failure is not visible: %#v", meta)
	}
	if _, ok := meta["shortDrama"].(map[string]any)["screenplayAudit"]; !ok {
		t.Fatalf("diagnosis binding was lost: %#v", meta["shortDrama"])
	}
}

func TestWritebackRetriesAfterConflictAndKeepsUserEdits(t *testing.T) {
	s, db, _ := productionFixture(t)
	writebackAddNode(t, s, db, loadingNode("img", "image", map[string]any{"taskId": "t1"}))
	writebackResource(t, db, "res1", "image/png", 100, 100)
	task := writebackTask(t, db, "t1", "image", "img", `{"resourceId":"resource:res1"}`, model.TaskStatusSucceeded)
	policy, err := s.RuntimePolicy()
	if err != nil {
		t.Fatal(err)
	}
	attempts := 0
	err = saveCanvasDocumentWithRetry(context.Background(), s.repo, "user", "agent-canvas", policy, func(doc map[string]any) bool {
		attempts++
		if attempts == 1 {
			// 模拟前端在回写读取之后保存了另一处修改。
			productionEditCanvas(t, s, db, func(latest map[string]any) {
				productionNode(latest, "body")["title"] = "用户改的标题"
			})
		}
		return applyTaskResultToCanvasDoc(doc, task, "img", &model.Resource{ID: "res1", MimeType: "image/png", Width: 100, Height: 100})
	})
	if err != nil {
		t.Fatal(err)
	}
	if attempts < 2 {
		t.Fatalf("expected a retry, attempts=%d", attempts)
	}
	if writebackMeta(writebackNode(t, s, "img"))["status"] != "success" {
		t.Fatal("result not written")
	}
	if writebackNode(t, s, "body")["title"] != "用户改的标题" {
		t.Fatal("concurrent user edit lost")
	}
}

func TestReconcileCompensatesLateNode(t *testing.T) {
	s, db, _ := productionFixture(t)
	writebackResource(t, db, "res1", "image/png", 100, 100)
	writebackTask(t, db, "t1", "image", "late", `{"resourceId":"resource:res1"}`, model.TaskStatusSucceeded)
	// 任务先完成，节点后首次保存。
	writebackAddNode(t, s, db, loadingNode("late", "image", map[string]any{"taskId": "t1"}))
	if err := s.ReconcileCanvasNodeTasks(context.Background(), "user", "agent-canvas"); err != nil {
		t.Fatal(err)
	}
	if m := writebackMeta(writebackNode(t, s, "late")); m["status"] != "success" || m["content"] != resourceFileURL("res1") {
		t.Fatalf("not compensated %#v", m)
	}
}

func TestTerminalCoordinatorWithoutWritebackDoesNotPanic(t *testing.T) {
	c := &taskTerminalCoordinator{}
	c.writeCanvas(model.Task{ID: "x", Status: model.TaskStatusSucceeded})
}

func TestWritebackMediaResourceMissingIsVisibleAndRecovers(t *testing.T) {
	s, db, _ := productionFixture(t)
	writebackAddNode(t, s, db, loadingNode("img", "image", map[string]any{"taskId": "tm"}))
	task := writebackTask(t, db, "tm", "image", "img", `{"resourceId":"resource:late"}`, model.TaskStatusSucceeded)
	if err := s.writeTaskResultToCanvas(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	meta := writebackMeta(writebackNode(t, s, "img"))
	if meta["status"] != "error" || meta["errorDetails"] != canvasMediaResourceUnavailableMessage || meta["taskStatus"] != "succeeded" {
		t.Fatalf("missing resource should be visible, got %#v", meta)
	}
	// 重复回写不应反复改写画布。
	before, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err := s.writeTaskResultToCanvas(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	after, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if before.Revision != after.Revision {
		t.Fatalf("repeat writeback bumped revision %d -> %d", before.Revision, after.Revision)
	}
	// 资源就绪后再次回写转为成功。
	writebackResource(t, db, "late", "image/png", 200, 100)
	if err := s.writeTaskResultToCanvas(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	meta = writebackMeta(writebackNode(t, s, "img"))
	if meta["status"] != "success" || meta["content"] != resourceFileURL("late") || meta["errorDetails"] != nil {
		t.Fatalf("expected recovery to success, got %#v", meta)
	}
}
