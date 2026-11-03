package app

import (
	"errors"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// 活动模型任务已失败而会话只拿到纯文本错误时，run 必须落到失败并释放任务，
// 否则恢复扫描会反复拉起会话，分镜等任务永远停在“执行中”。
func TestFailPiRunnerReleasesFailedActiveModelTask(t *testing.T) {
	s, db, run := planFixture(t, 2)
	task := model.Task{ID: "failed-model-step", UserID: "user", Status: model.TaskStatusFailed, Error: "上游流式请求失败，生成未完成"}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	execution, err := s.repo.CloudAgent("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, decodeErr := cloudAgentDecode(current)
		if decodeErr != nil {
			return decodeErr
		}
		current.Status = "running"
		state.TaskIDs = append(state.TaskIDs, task.ID)
		state.ActiveTaskID = task.ID
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}

	s.failPiRunner(run.ID, "user", errors.New("上游流式请求失败，生成未完成"))

	stored, state := productionRuntimeState(t, s, run.ID)
	if stored.Status != "failed" {
		t.Fatalf("run status = %q, want failed", stored.Status)
	}
	if state.ActiveTaskID != "" {
		t.Fatalf("active task %q was not released", state.ActiveTaskID)
	}
	completed, failed := false, false
	for _, event := range state.Events {
		switch event.Type {
		case "production_model_completed":
			completed = true
		case "run_failed":
			failed = true
		}
	}
	if !completed || !failed {
		t.Fatalf("missing terminal events: completed=%v failed=%v", completed, failed)
	}
}
