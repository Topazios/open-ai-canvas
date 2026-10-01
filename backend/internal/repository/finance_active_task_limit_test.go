package repository

import (
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestCreateTaskWithActiveLimitZeroAllowsExistingActiveTasks(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:active-task-limit-unlimited?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	now := time.Now()
	for _, task := range []model.Task{
		{ID: "active-1", UserID: "user-1", Status: model.TaskStatusQueued, CreatedAt: now, UpdatedAt: now},
		{ID: "active-2", UserID: "user-1", Status: model.TaskStatusRunning, CreatedAt: now, UpdatedAt: now},
	} {
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}

	task := &model.Task{ID: "active-3", UserID: "user-1", Status: model.TaskStatusQueued, CreatedAt: now, UpdatedAt: now}
	if err := repo.CreateTaskWithActiveLimit(task, 0); err != nil {
		t.Fatalf("CreateTaskWithActiveLimit() error = %v, want unlimited admission", err)
	}
}
