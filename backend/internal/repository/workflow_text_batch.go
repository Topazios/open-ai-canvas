package repository

import (
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

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
		if limit > 0 {
			var count int64
			if err := tx.Model(&model.Task{}).Where("user_id = ? AND id <> ? AND status IN ?", child.UserID, parent.ID, []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}).Count(&count).Error; err != nil {
				return err
			}
			if count >= int64(limit) {
				return ErrActiveTaskLimit
			}
		}
		if order != nil {
			if err := reserveBillingOrder(tx, order); err != nil {
				return err
			}
		}
		return tx.Create(child).Error
	})
}
