package repository

import (
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

// Mirrors model.TaskConcurrency; filtering before LIMIT avoids head-of-line blocking.
const taskConcurrencySQL = `CASE
WHEN type IN ('canvas_image', 'image') THEN 'image'
WHEN type IN ('canvas_video', 'video', 'timeline_render') OR substr(type, 1, 6) = 'video_' THEN 'video'
WHEN type IN ('canvas_audio', 'audio', 'timeline_transcription') THEN 'audio'
WHEN type IN ('canvas_text', 'text') THEN CASE
 WHEN substr(operation, 1, 11) = 'cloud_agent' OR operation = 'agent_memory_compact' THEN 'agent'
 ELSE 'text' END
ELSE 'other' END`

func taskConcurrencyQuery(query *gorm.DB, kind model.TaskConcurrencyKind) *gorm.DB {
	return query.Where("("+taskConcurrencySQL+") = ?", kind)
}

func (r *Repository) ActiveTaskCountForKind(userID string, kind model.TaskConcurrencyKind) (int64, error) {
	var count int64
	err := taskConcurrencyQuery(r.db.Model(&model.Task{}).Where("user_id = ? AND status IN ?", userID,
		[]model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}), kind).Count(&count).Error
	return count, err
}
