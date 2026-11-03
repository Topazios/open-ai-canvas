package repository

import (
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

// RestoreRemovedCanvasTask is the inverse of RemoveStoppedCanvasTask for a run
// whose target node is still on the canvas. It only clears the lifecycle flag, so
// the stored plan, assets, accounting and idempotency receipts stay untouched.
func (r *Repository) RestoreRemovedCanvasTask(userID, taskID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		return tx.Model(&model.Task{}).
			Where("user_id = ? AND (id = ? OR agent_run_id = ?) AND removed_at IS NOT NULL", userID, taskID, taskID).
			Updates(map[string]any{"removed_at": nil, "updated_at": time.Now().UTC()}).Error
	})
}