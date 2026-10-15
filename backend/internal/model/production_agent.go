package model

import "time"

// ProductionAgentJob owns the immutable source manifest, independently of the
// bounded Agent conversation. Page bodies and artifact receipts live separately.
type ProductionAgentJob struct {
	RunID        string `gorm:"primaryKey;size:80"`
	UserID       string `gorm:"index;size:36;not null"`
	CanvasID     string `gorm:"index;size:80;not null"`
	ManifestJSON string `gorm:"type:text;not null"`
	Validated    bool
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

type ProductionAgentPage struct {
	ID        string `gorm:"primaryKey;size:64"`
	UserID    string `gorm:"index;size:36;not null"`
	CanvasID  string `gorm:"index;size:80;not null"`
	Text      string `gorm:"type:text;not null"`
	FactsJSON string `gorm:"type:text;not null"`
	Processed bool
	CreatedAt time.Time
	UpdatedAt time.Time
}

// A receipt survives deletion of its canvas node. Replaying a tool must never
// resurrect that node or overwrite subsequent manual edits.
type ProductionAgentArtifact struct {
	RunID       string `gorm:"primaryKey;size:80"`
	Key         string `gorm:"primaryKey;size:160"`
	UserID      string `gorm:"index;size:36;not null"`
	NodeID      string `gorm:"size:80;not null"`
	ContentHash string `gorm:"size:64;not null"`
	FactIDsJSON string `gorm:"type:text;not null"`
	CreatedAt   time.Time
}
