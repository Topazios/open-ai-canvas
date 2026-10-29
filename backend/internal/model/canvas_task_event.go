package model

import "time"

// CanvasTaskEvent is a compact, replayable notification for canvas task state.
// It deliberately stores no prompt, provider credentials, or result payload.
type CanvasTaskEvent struct {
	Seq       int64     `json:"seq" gorm:"primaryKey;autoIncrement"`
	UserID    string    `json:"userId" gorm:"index;size:36"`
	ProjectID string    `json:"projectId" gorm:"index:idx_canvas_task_events_project_seq,priority:1;size:80"`
	TaskID    string    `json:"taskId" gorm:"index;size:36"`
	EventType string    `json:"eventType" gorm:"size:40"`
	Payload   string    `json:"payload" gorm:"type:text"`
	CreatedAt time.Time `json:"createdAt" gorm:"index"`
	ExpiresAt time.Time `json:"expiresAt" gorm:"index"`
}
