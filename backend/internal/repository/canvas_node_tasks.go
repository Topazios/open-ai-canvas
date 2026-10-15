package repository

import (
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func (r *Repository) CanvasNodeTaskScopes(after string) ([]model.CanvasProject, error) {
	var rows []model.CanvasProject
	err := r.db.Select("id", "user_id").Where("id > ? AND EXISTS (SELECT 1 FROM tasks WHERE tasks.project_id = canvas_projects.id AND tasks.user_id = canvas_projects.user_id AND tasks.removed_at IS NULL)", after).Order("id").Limit(50).Find(&rows).Error
	return rows, err
}

func (r *Repository) CanvasNodeTasks(userID, canvasID string) ([]model.Task, error) {
	var rows []model.Task
	err := r.db.Where("user_id = ? AND project_id = ? AND removed_at IS NULL", userID, canvasID).Find(&rows).Error
	return rows, err
}

func (r *Repository) BindCanvasNodeTasks(userID string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	return r.db.Model(&model.Task{}).Where("user_id = ? AND id IN ? AND node_bound_at IS NULL", userID, ids).Update("node_bound_at", time.Now().UTC()).Error
}

// Keep accounting, provider-cancellation reconciliation and idempotency receipts.
// Removal is a user-facing lifecycle state, never destruction of financial data.
func (r *Repository) RemoveStoppedCanvasTask(userID, taskID string, relatedIDs ...string) error {
	ids := append([]string{taskID}, relatedIDs...)
	return r.db.Transaction(func(tx *gorm.DB) error {
		var tasks []model.Task
		if err := tx.Where("user_id = ? AND (id IN ? OR agent_run_id = ?)", userID, ids, taskID).Find(&tasks).Error; err != nil {
			return err
		}
		for _, task := range tasks {
			if task.Status == model.TaskStatusRunning || task.Status == model.TaskStatusQueued {
				return ErrCreationConflict
			}
		}
		if tx.Migrator().HasTable(&model.CloudAgentExecution{}) {
			var active int64
			if err := tx.Model(&model.CloudAgentExecution{}).Where("user_id = ? AND id = ? AND (status IN ? OR cleanup_pending = ?)", userID, taskID, []string{"running", "queued", "waiting_approval", "waiting_user"}, true).Count(&active).Error; err != nil {
				return err
			}
			if active != 0 {
				return ErrCreationConflict
			}
		}
		return tx.Model(&model.Task{}).Where("user_id = ? AND (id IN ? OR agent_run_id = ?) AND removed_at IS NULL", userID, ids, taskID).Update("removed_at", time.Now().UTC()).Error
	})
}
