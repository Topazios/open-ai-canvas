package repository

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

func concurrencyTestRepo(t *testing.T) *Repository {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.Task{}, &model.TaskTextDelta{}); err != nil {
		t.Fatal(err)
	}
	return New(db)
}

func TestTaskConcurrencyClassificationMatchesQueueAndAdmission(t *testing.T) {
	r := concurrencyTestRepo(t)
	cases := []struct {
		typeName, op string
		kind         model.TaskConcurrencyKind
	}{
		{"canvas_image", "cloud_agent_step", model.TaskConcurrencyImage},
		{"canvas_text", "text", model.TaskConcurrencyText},
		{"text", "short_drama_batch", model.TaskConcurrencyText},
		{"canvas_text", "cloud_agent_step", model.TaskConcurrencyAgent},
		{"canvas_text", "cloud_agent_context_compaction", model.TaskConcurrencyAgent},
		{"canvas_text", "agent_memory_compact", model.TaskConcurrencyAgent},
		{"video_create", "", model.TaskConcurrencyVideo},
		{"canvas_video", "", model.TaskConcurrencyVideo},
		{"timeline_render", "", model.TaskConcurrencyVideo},
		{"canvas_audio", "cloud_agent_step", model.TaskConcurrencyAudio},
		{"timeline_transcription", "", model.TaskConcurrencyAudio},
		{"unknown", "", model.TaskConcurrencyOther},
	}
	for i, c := range cases {
		task := model.Task{ID: fmt.Sprint(i), UserID: "user", Type: c.typeName, Operation: c.op, Status: model.TaskStatusQueued}
		if model.TaskConcurrency(c.typeName, c.op) != c.kind {
			t.Fatalf("classification: %+v", c)
		}
		if err := r.db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
		var got model.Task
		if err := taskConcurrencyQuery(r.db.Where("id = ?", task.ID), c.kind).First(&got).Error; err != nil {
			t.Fatalf("SQL classification: %+v: %v", c, err)
		}
	}
	// The oldest queued image must not prevent each other lane from claiming.
	for _, kind := range model.TaskConcurrencyKinds() {
		task, err := r.ClaimNextTask("owner", time.Minute, kind)
		if err != nil || task == nil || model.TaskConcurrency(task.Type, task.Operation) != kind {
			t.Fatalf("claim %s: %v %v", kind, task, err)
		}
	}
}

func TestTaskConcurrencyAdmissionRetryAndCancellationAreIsolated(t *testing.T) {
	r := concurrencyTestRepo(t)
	for _, kind := range []string{"image", "text", "video", "audio"} {
		task := &model.Task{ID: kind, UserID: "user", Type: "canvas_" + kind, Status: model.TaskStatusQueued}
		if err := r.CreateTaskWithActiveLimit(task, 1); err != nil {
			t.Fatal(kind, err)
		}
	}
	agent := &model.Task{ID: "agent", UserID: "user", Type: "canvas_text", Operation: "cloud_agent_step", Status: model.TaskStatusQueued}
	if err := r.CreateTaskWithActiveLimit(agent, 1); err != nil {
		t.Fatal(err)
	}
	image := &model.Task{ID: "image2", UserID: "user", Type: "canvas_image", Status: model.TaskStatusQueued}
	if err := r.CreateTaskWithActiveLimit(image, 1); !errors.Is(err, ErrActiveTaskLimit) {
		t.Fatalf("same lane accepted: %v", err)
	}
	if err := r.db.Model(&model.Task{}).Where("id = ?", "image").Update("status", model.TaskStatusCancelled).Error; err != nil {
		t.Fatal(err)
	}
	if err := r.CreateTaskWithActiveLimit(image, 1); err != nil {
		t.Fatal(err)
	}
	old, _ := r.Task("image")
	if _, err := r.RetryTaskWithBilling("user", old, nil, 1); !errors.Is(err, ErrActiveTaskLimit) {
		t.Fatalf("retry bypassed lane: %v", err)
	}
	if err := r.db.Model(image).Update("status", model.TaskStatusSucceeded).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := r.RetryTaskWithBilling("user", old, nil, 1); err != nil {
		t.Fatal(err)
	}
}

func TestTaskConcurrencyBatchBorrowsOnlyItsParentAndLeaseRecoveryStaysInLane(t *testing.T) {
	r := concurrencyTestRepo(t)
	expires := time.Now().Add(time.Minute)
	parent := &model.Task{ID: "parent", UserID: "user", Type: "canvas_text", Operation: "short_drama_batch", Status: model.TaskStatusRunning, LeaseOwner: "owner", LeaseExpiresAt: &expires}
	if err := r.db.Create(parent).Error; err != nil {
		t.Fatal(err)
	}
	if err := r.db.Create(&model.Task{ID: "image", UserID: "user", Type: "canvas_image", Status: model.TaskStatusQueued}).Error; err != nil {
		t.Fatal(err)
	}
	child := &model.Task{ID: "child", UserID: "user", Type: "canvas_text", Status: model.TaskStatusQueued}
	if err := r.CreateWorkflowBatchChild(parent, child, nil, 1); err != nil {
		t.Fatal(err)
	}
	claimed, err := r.ClaimNextTask("one", time.Minute, model.TaskConcurrencyText)
	if err != nil || claimed == nil || claimed.ID != child.ID {
		t.Fatalf("claim: %v %v", claimed, err)
	}
	if next, err := r.ClaimNextTask("two", time.Minute, model.TaskConcurrencyText); err != nil || next != nil {
		t.Fatal("live lease reclaimed", err)
	}
	if err := r.db.Model(child).Update("lease_expires_at", time.Now().Add(-time.Minute)).Error; err != nil {
		t.Fatal(err)
	}
	claimed, err = r.ClaimNextTask("two", time.Minute, model.TaskConcurrencyText)
	if err != nil || claimed == nil || claimed.ID != child.ID || claimed.LeaseOwner != "two" {
		t.Fatalf("recovery: %v %v", claimed, err)
	}
}
