package repository

import "infinite-canvas/backend/internal/model"

// Parent association is read in one owner-scoped query even when the list page
// contains only children. Inputs stay server-side and are projected by app.
func (r *Repository) TaskPresentationParents(userID string, ids []string) ([]model.Task, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var tasks []model.Task
	err := r.db.Select("id", "user_id", "project_id", "input_json").Where("user_id = ? AND id IN ? AND removed_at IS NULL", userID, ids).Find(&tasks).Error
	return tasks, err
}
