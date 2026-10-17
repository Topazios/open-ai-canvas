package repository

import (
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

// Resume a confirmed retry stopped before its dispatch checkpoint was created.
// Missing logs alone are not sufficient: the caller must identify the exact
// preparation guard, and this transaction fences that diagnostic and execution.
func (r *Repository) ResumeUnsubmittedTaskRetry(userID string, observed *model.Task, attempt *model.RouteAttempt, activeTaskLimit int) (*model.Task, error) {
	var task model.Task
	err := r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&task, "id = ? AND user_id = ?", observed.ID, userID).Error; err != nil {
			return err
		}
		if task.Status != model.TaskStatusFailed || task.RemovedAt != nil || task.RouteRun <= 0 ||
			task.RouteRun != observed.RouteRun || task.BillingOrderID != observed.BillingOrderID ||
			task.ExecutionDiagnosticJSON != observed.ExecutionDiagnosticJSON || task.Error != observed.Error ||
			task.LogicalModelID != "" || task.ProviderRequestID != "" || task.ProviderCancelStatus != "" ||
			task.ResultJSON != "" || task.MediaRecoveryJSON != "" || task.StartedAt == nil ||
			attempt == nil || attempt.TaskID != task.ID || attempt.RouteRun != task.RouteRun || attempt.DispatchState != "not_sent" {
			return ErrTaskNotRetryable
		}
		if err := enforceActiveTaskLimit(tx, &task, activeTaskLimit); err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&model.RouteAttempt{}).Where("task_id = ? AND route_run = ?", task.ID, task.RouteRun).Count(&count).Error; err != nil {
			return err
		}
		if count != 0 {
			return ErrTaskNotRetryable
		}
		calls := tx.Model(&model.ApiCallLog{}).Where("task_id = ?", task.ID)
		if task.BillingOrderID != "" {
			calls = calls.Where("billing_order_id = ? OR started_at >= ?", task.BillingOrderID, task.StartedAt)
		} else {
			calls = calls.Where("started_at >= ?", task.StartedAt)
		}
		if err := calls.Count(&count).Error; err != nil {
			return err
		}
		if count != 0 {
			return ErrTaskNotRetryable
		}
		if task.BillingOrderID != "" {
			var order model.BillingOrder
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&order, "id = ? AND user_id = ? AND task_id = ?", task.BillingOrderID, userID, task.ID).Error; err != nil {
				return err
			}
			if order.ProviderRequestID != "" || order.UsageAvailable || order.SettledAt != nil || order.RefundedAt != nil || order.ResolvedBy != "" ||
				(order.Status != model.BillingStatusUncertain && order.Status != model.BillingStatusReserved && order.Status != model.BillingStatusRunning) {
				return ErrBillingStateConflict
			}
			updated := tx.Model(&model.BillingOrder{}).Where("id = ? AND status = ?", order.ID, order.Status).
				Updates(map[string]any{"status": model.BillingStatusReserved, "error": "", "resolution_note": "已核实本轮在提交前被拦截，恢复原预扣订单", "updated_at": time.Now()})
			if updated.Error != nil {
				return updated.Error
			}
			if updated.RowsAffected != 1 {
				return ErrBillingStateConflict
			}
		}
		updated := tx.Model(&model.Task{}).
			Where("id = ? AND user_id = ? AND status = ? AND removed_at IS NULL AND route_run = ? AND billing_order_id = ? AND execution_diagnostic_json = ?", task.ID, userID, model.TaskStatusFailed, observed.RouteRun, observed.BillingOrderID, observed.ExecutionDiagnosticJSON).
			Updates(map[string]any{"status": model.TaskStatusQueued, "stage": "等待队列调度", "progress": 5, "error": "", "execution_diagnostic_json": "", "started_at": nil, "completed_at": nil, "lease_owner": "", "lease_expires_at": nil, "next_poll_at": nil, "updated_at": time.Now()})
		if updated.Error != nil {
			return updated.Error
		}
		if updated.RowsAffected != 1 {
			return ErrTaskNotRetryable
		}
		if err := tx.Create(attempt).Error; err != nil {
			return err
		}
		return tx.First(&task, "id = ? AND user_id = ?", task.ID, userID).Error
	})
	return &task, err
}
