package model

import "time"

// The task owns the provider response. Units hold adopted content separately
// from the bounded conversation; receipts preserve every validation attempt.
type ProductionFlowUnit struct {
	ID         string `gorm:"primaryKey;size:64"`
	UserID     string `gorm:"index;size:36;not null"`
	RunID      string `gorm:"index;size:80;not null"`
	Root       string `gorm:"size:20;not null"`
	SourceHash string `gorm:"size:64;not null"`
	Key        string `gorm:"size:160;not null"`
	Stage      string `gorm:"size:40;not null"`
	Name       string `gorm:"size:200;not null"`
	Contract   int
	InputJSON  string `gorm:"type:text;not null"`
	ResultJSON string `gorm:"type:text;not null"`
	IssuesJSON string `gorm:"type:text;not null"`
	SplitJSON  string `gorm:"type:text"`
	Status     string `gorm:"size:24;not null"`
	TaskID     string `gorm:"size:80"`
	Generation int
	Attempts   int
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

type ProductionFlowReceipt struct {
	ID            string `gorm:"primaryKey;size:64"`
	UserID        string `gorm:"index;size:36;not null"`
	RunID         string `gorm:"index;size:80;not null"`
	UnitID        string `gorm:"index;size:64;not null"`
	TaskID        string `gorm:"size:80;not null"`
	Generation    int
	ArgumentsJSON string `gorm:"type:text;not null"`
	AdoptedJSON   string `gorm:"type:text;not null"`
	IssuesJSON    string `gorm:"type:text;not null"`
	CreatedAt     time.Time
}
