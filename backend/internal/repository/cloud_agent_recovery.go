package repository

import "infinite-canvas/backend/internal/model"

// Cancel receipts outlive the active run: failed/cancelled coordinators still
// need their revoked worker resources reclaimed after a process restart.
func (r *Repository) CloudAgentsWithRevokedTasksAfter(after string, limit int) ([]model.CloudAgentExecution, error) {
	var runs []model.CloudAgentExecution
	err := r.db.Select("id", "user_id").Where("id > ? AND state_json LIKE ?", after, `%"revokedProductionTasks":{%`).Order("id").Limit(limit).Find(&runs).Error
	return runs, err
}
