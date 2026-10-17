package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func ownedWorkflowBatchParent(task *model.Task) string {
	if task.Type != "canvas_text" || !strings.HasPrefix(task.ID, "wb-") {
		return ""
	}
	var input struct {
		Metadata struct {
			Source string `json:"source"`
			Parent string `json:"parentTaskId"`
			Key    string `json:"batchKey"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || input.Metadata.Source != "canvas-workflow-batch-child" || input.Metadata.Key == "shared-facts-v1" {
		return ""
	}
	return input.Metadata.Parent
}

func (s *Service) cancelWorkflowBatchChildren(parent *model.Task) {
	children, err := s.repo.ActiveWorkflowBatchChildren(parent.UserID, parent.ID)
	if err != nil {
		_ = s.log(parent.UserID, parent.ID, "error", "取消分批子任务读取失败", err.Error())
		return
	}
	for _, child := range children {
		if ownedWorkflowBatchParent(&child) != parent.ID {
			continue
		}
		if _, err := s.taskLifecycle().cancelTaskWithIntent(context.Background(), child.UserID, child.ID, model.TaskCancellationIntent{Source: model.TaskCancellationParentCancelled, ActorID: parent.CancellationActorID}); err != nil {
			_ = s.log(parent.UserID, parent.ID, "error", "取消分批子任务失败", err.Error())
		}
	}
}

// Fence queued work if parent cancellation raced with dispatch or cleanup.
// Shared fact parses can have other consumers and keep their existing lifecycle.
func (s *Service) cancelWorkflowChildForTerminalParent(ctx context.Context, task *model.Task) (bool, error) {
	parentID := ownedWorkflowBatchParent(task)
	if parentID == "" {
		return false, nil
	}
	parent, err := s.repo.TaskForUser(task.UserID, parentID)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return true, err
	}
	if parent != nil && parent.Status != model.TaskStatusCancelled && parent.Status != model.TaskStatusFailed {
		return false, nil
	}
	source := model.TaskCancellationParentCancelled
	if parent != nil && parent.Status == model.TaskStatusFailed {
		source = model.TaskCancellationParentFailed
	}
	_, err = s.taskLifecycle().cancelTaskWithIntent(ctx, task.UserID, task.ID, model.TaskCancellationIntent{Source: source})
	return true, err
}
