package app

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestTaskConcurrencyChannelLanesIgnoreExplicitSupplierCap(t *testing.T) {
	t.Setenv("REDIS_URL", "")
	s, db, _, _ := creationTestService(t)
	s = New(s.repo, s.dataDir)
	t.Cleanup(func() { _ = s.Close() })
	policy := defaultRuntimePolicy()
	policy.Task.ChannelConcurrency = 1
	if _, err := s.UpdateRuntimePolicySetting(&model.User{ID: "admin", Role: model.UserRoleAdmin}, policy); err != nil {
		t.Fatal(err)
	}
	var releases []func()
	defer func() {
		for _, release := range releases {
			release()
		}
	}()
	for _, kind := range model.TaskConcurrencyKinds() {
		release, limit, err := s.AcquireChannelSlot(context.Background(), "channel", "", time.Minute, kind)
		if err != nil || limit != 1 {
			t.Fatalf("lane %s: %d %v", kind, limit, err)
		}
		releases = append(releases, release)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if release, _, err := s.AcquireChannelSlot(ctx, "channel", "", time.Minute, model.TaskConcurrencyImage); err == nil {
		release()
		t.Fatal("image cap exceeded")
	}
	for _, release := range releases {
		release()
	}
	releases = nil
	if err := db.Model(&model.ModelChannel{}).Where("id = ?", "channel").Update("concurrency_limit", 1).Error; err != nil {
		t.Fatal(err)
	}
	release, _, err := s.AcquireChannelSlot(context.Background(), "channel", "", time.Minute, model.TaskConcurrencyImage)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx2, cancel2 := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel2()
	second, limit, err := s.AcquireChannelSlot(ctx2, "channel", "", time.Minute, model.TaskConcurrencyText)
	if err != nil {
		t.Fatalf("legacy supplier cap blocked independent text lane: %v", err)
	}
	defer second()
	if limit != 1 {
		t.Fatalf("text lane limit = %d, want global channel limit 1", limit)
	}
}

func TestTaskConcurrencyLegacyPolicyDefaultsAndValidation(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	if err := db.Create(&model.SystemSetting{Key: "runtime_policy", ValueJSON: `{"task":{"workerConcurrency":2,"channelConcurrency":2,"activeTaskLimit":17}}`}).Error; err != nil {
		t.Fatal(err)
	}
	s = New(s.repo, s.dataDir)
	t.Cleanup(func() { _ = s.Close() })
	policy, err := s.RuntimePolicy()
	if err != nil {
		t.Fatal(err)
	}
	if policy.Task.ImageConcurrency != 6 || policy.Task.TextConcurrency != 3 || policy.Task.AgentConcurrency != 3 || policy.Task.VideoConcurrency != 2 || policy.Task.AudioConcurrency != 3 || policy.Task.ActiveTaskLimit != 17 {
		t.Fatalf("legacy defaults: %+v", policy.Task)
	}
	policy.Task.ImageConcurrency = 0
	if _, err := s.UpdateRuntimePolicySetting(&model.User{ID: "admin", Role: model.UserRoleAdmin}, policy); err == nil {
		t.Fatal("zero lane accepted")
	}
}

func TestTaskConcurrencyWorkerDispatchesTextWhileImageLaneIsFull(t *testing.T) {
	t.Setenv("REDIS_URL", "")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"complete"},"finish_reason":"stop"}]}`)
	}))
	defer upstream.Close()
	s, db, _, _ := creationTestService(t)
	s = New(s.repo, s.dataDir)
	s.disablePiRuntime = true
	t.Cleanup(func() { _ = s.Close() })
	if err := db.Model(&model.ModelChannel{}).Where("id = ?", "channel").Updates(map[string]any{"base_url": upstream.URL, "api_key": "fixture"}).Error; err != nil {
		t.Fatal(err)
	}
	policy := defaultRuntimePolicy()
	policy.Task.ImageConcurrency = 1
	policy.Task.TextConcurrency = 1
	policy.Task.ActiveTaskLimit = 1
	if _, err := s.UpdateRuntimePolicySetting(&model.User{ID: "admin", Role: model.UserRoleAdmin}, policy); err != nil {
		t.Fatal(err)
	}
	image := model.Task{ID: "image-waiting", UserID: "user", Type: "canvas_image", Status: model.TaskStatusQueued}
	if err := db.Create(&image).Error; err != nil {
		t.Fatal(err)
	}
	textTask, err := s.CreateTask("user", creationTextRequest())
	if err != nil {
		t.Fatalf("image queue blocked text admission: %v", err)
	}
	lease, acquired, err := s.coordinator.AcquireLease(context.Background(), "workers:image", 1, time.Minute)
	if err != nil || !acquired {
		t.Fatal("image slot", err)
	}
	defer lease.Release()
	ctx, _ := s.backgroundWorkers().Start()
	s.taskWorker().start(ctx)
	defer func() {
		stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.StopWorker(stop); err != nil {
			t.Error(err)
		}
	}()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		current, err := s.repo.Task(textTask.ID)
		if err != nil {
			t.Fatal(err)
		}
		if current.Status == model.TaskStatusFailed {
			t.Fatal(current.Error)
		}
		if current.Status == model.TaskStatusSucceeded {
			waiting, err := s.repo.Task(image.ID)
			if err != nil || waiting.Status != model.TaskStatusQueued {
				t.Fatal("image lane exceeded", err)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("text did not complete while image lane was occupied")
}
