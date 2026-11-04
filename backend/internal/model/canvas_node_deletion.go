package model

import "time"

type CanvasNodeDeletionReceipt struct {
	UserID    string    `gorm:"primaryKey;size:36"`
	CanvasID  string    `gorm:"primaryKey;size:80"`
	NodeID    string    `gorm:"primaryKey;size:160"`
	CreatedAt time.Time `gorm:"not null"`
}
