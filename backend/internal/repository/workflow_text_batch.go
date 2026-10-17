package repository

import (
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func (r *Repository) WorkflowBatchExecutionChildren(userID, parentID string, limit int) ([]model.Task, error) {
	var tasks []model.Task
	err := r.workflowBatchChildren(userID, parentID).Order("created_at DESC, id DESC").Limit(limit).Find(&tasks).Error
	return tasks, err
}

func (r *Repository) WorkflowBatchFirstDispatch(userID, parentID string) (*time.Time, error) {
	var child model.Task
	err := r.workflowBatchChildren(userID, parentID).Select("created_at").Order("created_at ASC").Limit(1).Find(&child).Error
	if err != nil || child.CreatedAt.IsZero() {
		return nil, err
	}
	return &child.CreatedAt, nil
}

func (r *Repository) workflowBatchChildren(userID, parentID string) *gorm.DB {
	path := "json_extract(CASE WHEN json_valid(input_json) THEN input_json ELSE '{}' END, '$.metadata.parentTaskId')"
	if r.Dialect() == "postgres" {
		path = "(NULLIF(input_json, '')::jsonb -> 'metadata' ->> 'parentTaskId')"
	}
	// Batch child IDs use wb-<hash>-<attempt>; exclude unrelated large inputs.
	return r.db.Where("user_id = ? AND id >= ? AND id < ? AND "+path+" = ?", userID, "wb-", "wb.", parentID)
}

func (r *Repository) ActiveWorkflowBatchChildren(userID, parentID string) ([]model.Task, error) {
	var tasks []model.Task
	err := r.workflowBatchChildren(userID, parentID).Where("status IN ?", []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}).Find(&tasks).Error
	return tasks, err
}

// Exact message allowlist excludes lease heartbeats and all raw provider payloads.
func (r *Repository) TaskExecutionEvents(userID, taskID string, messages []string, limit int) ([]model.TaskLog, error) {
	var logs []model.TaskLog
	err := r.db.Select("id", "task_id", "level", "message", "created_at").Where("user_id = ? AND task_id = ? AND message IN ?", userID, taskID, messages).
		Order("created_at DESC, id DESC").Limit(limit).Find(&logs).Error
	return logs, err
}

func (r *Repository) WorkflowExecutionSharedChildren(userID string, prefixes []string, limit int) ([]model.Task, error) {
	var tasks []model.Task
	if len(prefixes) == 0 {
		return tasks, nil
	}
	err := r.db.Where("user_id = ? AND substr(id, 1, ?) IN ?", userID, len(prefixes[0]), prefixes).Order("created_at DESC, id DESC").Limit(limit).Find(&tasks).Error
	return tasks, err
}

func (r *Repository) LatestWorkflowSharedTask(userID, prefix string) (*model.Task, error) {
	var task model.Task
	err := r.db.Where("user_id = ? AND id LIKE ?", userID, prefix+"%").Order("created_at DESC").First(&task).Error
	if err != nil {
		return nil, err
	}
	return &task, nil
}

// Serialize child admission with parent cancellation/reclaim. The deterministic
// child primary key and credit reservation commit in the same transaction.
func (r *Repository) CreateWorkflowBatchChild(parent, child *model.Task, order *model.BillingOrder, limit int) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		locked := tx.Model(&model.Task{}).Where("id = ? AND user_id = ? AND status = ? AND operation = ? AND lease_owner = ? AND lease_expires_at > ?",
			parent.ID, child.UserID, model.TaskStatusRunning, "short_drama_batch", parent.LeaseOwner, time.Now()).
			Update("updated_at", time.Now())
		if locked.Error != nil {
			return locked.Error
		}
		if locked.RowsAffected != 1 {
			return ErrTaskStateConflict
		}
		if err := r.requireActiveLogicalModelForTask(tx, child); err != nil {
			return err
		}
		if err := enforceActiveTaskLimit(tx, child, limit, parent.ID); err != nil {
			return err
		}
		if order != nil {
			if err := reserveBillingOrder(tx, order); err != nil {
				return err
			}
		}
		return tx.Create(child).Error
	})
}
