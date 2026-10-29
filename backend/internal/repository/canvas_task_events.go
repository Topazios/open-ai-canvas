package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

const (
	canvasTaskEventLimit     = 1000
	canvasTaskEventRetention = 7 * 24 * time.Hour
)

func (r *Repository) CreateCanvasTaskEvent(event *model.CanvasTaskEvent) error {
	if event == nil || event.UserID == "" || event.ProjectID == "" || event.TaskID == "" || event.EventType == "" {
		return nil
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now()
	}
	if event.ExpiresAt.IsZero() {
		event.ExpiresAt = event.CreatedAt.Add(canvasTaskEventRetention)
	}
	return r.db.Create(event).Error
}

// CreateCanvasTaskEventIfChanged avoids writing the same compact state event
// repeatedly when a worker renews a lease or retries an unchanged provider
// observation. The caller only broadcasts when created is true.
func (r *Repository) CreateCanvasTaskEventIfChanged(event *model.CanvasTaskEvent) (created bool, err error) {
	if event == nil || event.UserID == "" || event.ProjectID == "" || event.TaskID == "" || event.EventType == "" {
		return false, nil
	}
	var latest model.CanvasTaskEvent
	lookupErr := r.db.Where("user_id = ? AND project_id = ? AND task_id = ? AND event_type = ?", event.UserID, event.ProjectID, event.TaskID, event.EventType).
		Order("seq desc").First(&latest).Error
	if lookupErr == nil && latest.Payload == event.Payload {
		return false, nil
	}
	if lookupErr != nil && !errors.Is(lookupErr, gorm.ErrRecordNotFound) {
		return false, lookupErr
	}
	if err := r.CreateCanvasTaskEvent(event); err != nil {
		return false, err
	}
	return true, nil
}

func (r *Repository) CanvasTaskEventsForUser(userID, projectID string, after int64, limit int) ([]model.CanvasTaskEvent, error) {
	if limit <= 0 || limit > canvasTaskEventLimit {
		limit = canvasTaskEventLimit
	}
	var events []model.CanvasTaskEvent
	err := r.db.Where("user_id = ? AND project_id = ? AND seq > ? AND expires_at > ?", userID, projectID, after, time.Now()).
		Order("seq asc").Limit(limit).Find(&events).Error
	return events, err
}

func (r *Repository) PruneCanvasTaskEvents(now time.Time, limit int) error {
	if limit <= 0 || limit > 1000 {
		limit = 1000
	}
	var ids []int64
	if err := r.db.Model(&model.CanvasTaskEvent{}).Where("expires_at <= ?", now).Order("seq asc").Limit(limit).Pluck("seq", &ids).Error; err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	return r.db.Where("seq IN ?", ids).Delete(&model.CanvasTaskEvent{}).Error
}
