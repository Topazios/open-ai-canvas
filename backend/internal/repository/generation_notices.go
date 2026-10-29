package repository

import "infinite-canvas/backend/internal/model"

func (r *Repository) GenerationNoticeTasks(userID, runID string, ids []string) ([]model.Task, error) {
	var tasks []model.Task
	if len(ids) == 0 {
		return tasks, nil
	}
	err := r.db.Select("id", "user_id", "agent_run_id", "status", "execution_diagnostic_json", "error").
		Where("user_id = ? AND agent_run_id = ? AND id IN ?", userID, runID, ids).Find(&tasks).Error
	return tasks, err
}
