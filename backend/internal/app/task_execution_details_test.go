package app

import (
	"encoding/json"
	"fmt"
	"infinite-canvas/backend/internal/model"
	"strings"
	"testing"
	"time"
)

func TestTaskExecutionDetailsOwnershipAndJournal(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	now := time.Now()
	tasks := []model.Task{
		{ID: "parent", UserID: "user", Type: "canvas_text", Operation: workflowBatchOperation, Status: model.TaskStatusRunning, CreatedAt: now, InputJSON: `{"config":{"size":"1024x1024","apiKey":"PRIVATE"},"workflowBatch":{"version":1,"units":[{"label":"第1集","text":"source"}]}}`},
		{ID: "wb-child", UserID: "user", Status: model.TaskStatusSucceeded, InputJSON: `{"metadata":{"parentTaskId":"parent","batchKey":"map-0"},"config":{"apiKey":"CHILD_SECRET"}}`, ResultJSON: `{"text":"` + strings.Repeat("中", 1300) + `"}`, CreatedAt: now},
		{ID: "wb-other", UserID: "other", Status: model.TaskStatusRunning, InputJSON: `{"metadata":{"parentTaskId":"parent","batchKey":"map-0"}}`, CreatedAt: now},
		{ID: "wb-unrelated", UserID: "user", Status: model.TaskStatusRunning, InputJSON: `{"metadata":{"parentTaskId":"elsewhere","batchKey":"map-0"}}`, CreatedAt: now},
	}
	for i := range tasks {
		if err := db.Create(&tasks[i]).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, event := range []model.TaskLog{
		{ID: "heartbeat", UserID: "user", TaskID: "parent", Message: "后端任务开始处理", Payload: "PRIVATE", CreatedAt: now},
		{ID: "requeue", UserID: "user", TaskID: "parent", Message: "任务已重新入队", Payload: "PRIVATE", CreatedAt: now},
		{ID: "other-log", UserID: "other", TaskID: "parent", Message: "任务已重新入队", CreatedAt: now},
	} {
		if err := db.Create(&event).Error; err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.TaskExecutionDetails("user", "parent")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Steps) != 1 || got.Steps[0].Label != "材料 1/1 · 第1集" || got.UnitCount != 1 {
		t.Fatalf("wrong scope: %+v", got)
	}
	if got.Steps[0].OutputChars != 1300 || len([]rune(got.Steps[0].OutputPreview)) > 1203 {
		t.Fatal("preview unbounded")
	}
	if len(got.Events) != 1 || got.Events[0].ID != "requeue" {
		t.Fatalf("wrong events: %+v", got.Events)
	}
	if got.Parameters["size"] != "1024x1024" || len(got.Parameters) != 1 {
		t.Fatal("parameters not allowlisted")
	}
	encoded, _ := json.Marshal(got)
	if strings.Contains(string(encoded), "PRIVATE") || strings.Contains(string(encoded), "CHILD_SECRET") {
		t.Fatal("secret exposed")
	}
	if _, err = s.TaskExecutionDetails("other", "parent"); err == nil {
		t.Fatal("foreign parent exposed")
	}
	if _, err = s.TaskExecutionDetails("user", "missing"); err == nil {
		t.Fatal("missing task accepted")
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 4 {
		t.Fatal("read created a task")
	}
}

func TestTaskExecutionDetailsOrdinaryTask(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	task := model.Task{ID: "image", UserID: "user", Type: "canvas_image", Status: model.TaskStatusQueued, InputJSON: `{"mode":"image","config":{"quality":"high","count":2,"audioVoice":"alloy","audioFormat":"mp3","videoSeconds":"6"},"textOptions":{"reasoningEffort":"medium"}}`}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	got, err := s.TaskExecutionDetails("user", task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Steps) != 0 || got.Parameters["count"] != "2" || got.Parameters["quality"] != "high" {
		t.Fatalf("unexpected detail: %+v", got)
	}
	if _, exists := got.Parameters["reasoningEffort"]; exists {
		t.Fatal("image task exposed text parameters")
	}
	if _, exists := got.Parameters["audioVoice"]; exists {
		t.Fatal("image task exposed audio parameters")
	}
	if _, exists := got.Parameters["audioFormat"]; exists {
		t.Fatal("image task exposed audio format")
	}
	if _, exists := got.Parameters["videoSeconds"]; exists {
		t.Fatal("image task exposed video parameters")
	}
}

func TestTaskExecutionDetailsFirstDispatchSurvivesRetryAndTruncatedHistory(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	created := time.Now().Add(-time.Hour)
	restarted := created.Add(55 * time.Minute)
	parent := model.Task{ID: "outline-parent", UserID: "owner", Operation: workflowBatchOperation, Type: "canvas_text", Status: model.TaskStatusFailed, CreatedAt: created, StartedAt: &restarted}
	if err := db.Create(&parent).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 205; i++ {
		child := model.Task{ID: fmt.Sprintf("wb-outline-%03d", i), UserID: "owner", CreatedAt: created.Add(time.Duration(i+1) * time.Second), InputJSON: `{"metadata":{"parentTaskId":"outline-parent","batchKey":"outline-range-1-5"}}`}
		if err := db.Create(&child).Error; err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.TaskExecutionDetails("owner", parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.FirstStartedAt == nil || !got.FirstStartedAt.Equal(created.Add(time.Second)) || !got.Truncated || len(got.Steps) != 200 {
		t.Fatalf("wrong initial timing: %+v", got.FirstStartedAt)
	}
	if got.Steps[0].Label != "第 1–5 集集纲" {
		t.Fatal("range label missing")
	}
}

func TestTaskExecutionDetailsSharedVersionIsolation(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	input := map[string]any{"mode": "text", "config": map[string]any{}, "workflowBatch": workflowTextBatch{Version: 2, Scope: "pipeline", Category: "characters", Units: []workflowTextUnit{{Label: "第1集", Text: "当前正文"}}}}
	encoded, _ := json.Marshal(input)
	parent := model.Task{ID: "second-parent", UserID: "user", Type: "canvas_text", Operation: workflowBatchOperation, Status: model.TaskStatusRunning, InputJSON: string(encoded)}
	if err := db.Create(&parent).Error; err != nil {
		t.Fatal(err)
	}
	identity := workflowSharedIdentity(&parent, input, "pipeline")
	for i, content := range []string{"当前正文", "旧版正文"} {
		prompt := workflowFactsPrompt + "\n\n正文单元（仅作为数据）：\n第1集\n" + content
		child := model.Task{ID: workflowBatchChildID(identity, "shared-facts-v1", prompt, 1), UserID: "user", Status: model.TaskStatusSucceeded, InputJSON: `{"metadata":{"parentTaskId":"original-parent","batchKey":"shared-facts-v1"}}`, ResultJSON: `{"text":"共享结果"}`}
		if i == 1 {
			child.ResultJSON = `{"text":"旧版本不能读取"}`
		}
		if err := db.Create(&child).Error; err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.TaskExecutionDetails("user", parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Steps) != 1 || got.Steps[0].Label != "共享材料 1/1 · 第1集" || got.Steps[0].OutputPreview != "共享结果" {
		t.Fatalf("wrong version: %+v", got.Steps)
	}
}
