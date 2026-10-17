package platform

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

type concurrencyTestHost struct {
	nopHost
	legacyLimit int
	legacyReads int
	audits      []string
}

func (h *concurrencyTestHost) ChannelConcurrencyLimit(string) (int, error) {
	h.legacyReads++
	return h.legacyLimit, errors.New("legacy channel lookup must not run")
}

func (h *concurrencyTestHost) AppendAudit(_ *model.User, action, _, _, _ string, _ any) error {
	h.audits = append(h.audits, action)
	return nil
}

func concurrencyTestService(t *testing.T) (*Service, *gorm.DB, *concurrencyTestHost) {
	t.Helper()
	t.Setenv("CANVAS_WORKER_CONCURRENCY", "8")
	t.Setenv("CANVAS_CHANNEL_CONCURRENCY", "8")
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "policy.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	host := &concurrencyTestHost{}
	coordinator := NewCoordinatorWithRedis(nil, "policy-test")
	return New(repository.New(db), coordinator, host), db, host
}

func saveConcurrencyTestPolicy(t *testing.T, s *Service, policy RuntimePolicySetting) {
	t.Helper()
	if _, err := s.UpdateRuntimePolicySetting(&model.User{ID: "admin"}, policy); err != nil {
		t.Fatal(err)
	}
}

func TestChannelSlotsIgnoreLegacyOverrides(t *testing.T) {
	s, _, host := concurrencyTestService(t)
	policy := DefaultRuntimePolicy()
	policy.Task.ChannelConcurrency = 2
	saveConcurrencyTestPolicy(t, s, policy)
	for _, legacy := range []int{-1, 0, 1, 999, 1000} {
		t.Run(fmt.Sprint(legacy), func(t *testing.T) {
			host.legacyLimit = legacy
			for range 2 {
				release, limit, err := s.AcquireChannelSlot(context.Background(), "supplier", "", time.Minute)
				if err != nil || limit != 2 {
					t.Fatalf("acquire: limit=%d err=%v", limit, err)
				}
				t.Cleanup(release)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
			defer cancel()
			if release, limit, err := s.AcquireChannelSlot(ctx, "supplier", "", time.Minute); !errors.Is(err, context.DeadlineExceeded) || limit != 2 {
				if release != nil {
					release()
				}
				t.Fatalf("global cap not enforced: limit=%d err=%v", limit, err)
			}
		})
	}
	if host.legacyReads != 0 {
		t.Fatalf("read legacy channel limit %d times", host.legacyReads)
	}
	if len(s.Coordinator.localSlots) != 0 {
		t.Fatal("released channel leases retained")
	}
}

func TestChannelSlotsUseIndependentGlobalWorkloadLimits(t *testing.T) {
	s, _, host := concurrencyTestService(t)
	host.legacyLimit = 1
	policy := DefaultRuntimePolicy()
	policy.Task.ChannelConcurrency = 2
	policy.Task.ImageConcurrency = 1
	policy.Task.TextConcurrency = 3
	policy.Task.AgentConcurrency = 1
	policy.Task.VideoConcurrency = 3
	policy.Task.AudioConcurrency = 1
	policy.Task.WorkerConcurrency = 3
	saveConcurrencyTestPolicy(t, s, policy)
	for _, useFallback := range []bool{false, true} {
		t.Run(fmt.Sprint(useFallback), func(t *testing.T) {
			channelID, fallback := " supplier ", "ignored"
			if useFallback {
				channelID, fallback = "", " relay "
			}
			for i, kind := range model.TaskConcurrencyKinds() {
				want := 1 + i%2
				for range want {
					release, limit, err := s.AcquireChannelSlot(context.Background(), channelID, fallback, time.Minute, kind)
					if err != nil || limit != want {
						t.Fatalf("%s: limit=%d want=%d err=%v", kind, limit, want, err)
					}
					t.Cleanup(release)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
				release, limit, err := s.AcquireChannelSlot(ctx, channelID, fallback, time.Minute, kind)
				cancel()
				if release != nil {
					release()
				}
				if !errors.Is(err, context.DeadlineExceeded) || limit != want {
					t.Fatalf("%s cap: limit=%d err=%v", kind, limit, err)
				}
			}
		})
	}
	if host.legacyReads != 0 || len(s.Coordinator.localSlots) != 0 {
		t.Fatalf("legacy reads=%d remaining scopes=%d", host.legacyReads, len(s.Coordinator.localSlots))
	}
}

func TestPublicRuntimeConcurrencyAndAdminRoundTrip(t *testing.T) {
	s, _, host := concurrencyTestService(t)
	// Warm both caches so an admin update must invalidate the old policy.
	if _, err := s.PublicRuntimeLimits(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RuntimeConcurrencySetting(); err != nil {
		t.Fatal(err)
	}
	policy := DefaultRuntimePolicy()
	policy.Task.ImageConcurrency, policy.Task.TextConcurrency = 11, 12
	policy.Task.AgentConcurrency, policy.Task.VideoConcurrency = 13, 14
	policy.Task.AudioConcurrency, policy.Task.WorkerConcurrency = 15, 16
	policy.Task.ChannelConcurrency, policy.Request.CustomRelayConcurrency = 17, 18
	policy.Resource.ImagePreparationConcurrency, policy.Resource.ResourceDownloadConcurrency = 19, 20
	policy.Resource.UploadConcurrency, policy.Resource.MediaRecoveryConcurrency = 21, 22
	policy.Task.AgentMaxSessions = 23
	saveConcurrencyTestPolicy(t, s, policy)
	admin, err := s.AdminRuntimePolicySetting(&model.User{ID: "admin"})
	if err != nil || admin.RuntimePolicySetting != policy || !admin.Configured || admin.UpdatedBy != "admin" {
		t.Fatalf("admin round trip: %+v err=%v", admin, err)
	}
	reopened := New(s.repo, s.Coordinator, host)
	persisted, err := reopened.RuntimePolicy()
	if err != nil || persisted != policy {
		t.Fatalf("persisted policy: %+v err=%v", persisted, err)
	}
	task, err := s.RuntimeConcurrencySetting()
	if err != nil || task != policy.Task {
		t.Fatalf("stale concurrency cache: %+v err=%v", task, err)
	}
	limits, err := s.PublicRuntimeLimits()
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(limits)
	if err != nil {
		t.Fatal(err)
	}
	var output map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &output); err != nil {
		t.Fatal(err)
	}
	var concurrency map[string]int
	if err := json.Unmarshal(output["concurrency"], &concurrency); err != nil {
		t.Fatal(err)
	}
	want := map[string]int{
		"image": 11, "text": 12, "agent": 13, "video": 14, "audio": 15, "other": 16,
		"channel": 17, "customRelay": 18, "imagePreparation": 19, "resourceDownload": 20,
		"upload": 21, "mediaRecovery": 22, "agentSessions": 23,
	}
	if !reflect.DeepEqual(concurrency, want) || len(output) != 4 {
		t.Fatalf("public JSON contract: %s", encoded)
	}
	if limits.ActiveTaskLimit != policy.Task.ActiveTaskLimit || limits.ResourceUploadMB != policy.Resource.ResourceUploadMB || limits.RecycleBinRetentionDays != policy.Resource.RecycleBinRetentionDays {
		t.Fatalf("existing public limits changed: %+v", limits)
	}
	if !reflect.DeepEqual(host.audits, []string{"runtime_policy.update"}) {
		t.Fatalf("update audit missing: %v", host.audits)
	}
}

func TestRuntimeConcurrencyLegacyJSONAndReset(t *testing.T) {
	s, db, _ := concurrencyTestService(t)
	legacy := `{"resource":{"resourceUploadMB":77},"task":{"workerConcurrency":9,"channelConcurrency":7}}`
	if err := db.Create(&model.SystemSetting{Key: runtimePolicySettingKey, ValueJSON: legacy}).Error; err != nil {
		t.Fatal(err)
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		t.Fatal(err)
	}
	if policy.Resource.ImagePreparationConcurrency != 4 || policy.Resource.ResourceDownloadConcurrency != 16 || policy.Resource.UploadConcurrency != 4 || policy.Resource.MediaRecoveryConcurrency != 2 || policy.Task.AgentMaxSessions != 30 {
		t.Fatalf("legacy defaults: %+v", policy)
	}
	if policy.Resource.ResourceUploadMB != 77 || policy.Task.WorkerConcurrency != 9 || policy.Task.ChannelConcurrency != 7 {
		t.Fatalf("legacy values overwritten: %+v", policy)
	}
	// Simulate an old admin client sending a full policy without the new fields.
	encoded, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"imagePreparationConcurrency", "resourceDownloadConcurrency", "uploadConcurrency", "mediaRecoveryConcurrency"} {
		delete(payload["resource"], field)
	}
	encoded, err = json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var request RuntimePolicySetting
	if err := json.Unmarshal(encoded, &request); err != nil {
		t.Fatal(err)
	}
	saveConcurrencyTestPolicy(t, s, request)
	if request != policy {
		t.Fatalf("old admin JSON lost defaults: %+v", request)
	}
	if _, err := s.RuntimeConcurrencySetting(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResetRuntimePolicySetting(&model.User{ID: "admin"}); err != nil {
		t.Fatal(err)
	}
	reset, err := s.RuntimePolicy()
	if err != nil || reset != DefaultRuntimePolicy() {
		t.Fatalf("reset policy: %+v err=%v", reset, err)
	}
	task, err := s.RuntimeConcurrencySetting()
	if err != nil || task != reset.Task {
		t.Fatalf("reset concurrency cache: %+v err=%v", task, err)
	}
}

func TestRuntimeConcurrencyBoundsAndSelfUse(t *testing.T) {
	fields := []struct {
		section string
		name    string
		max     int
	}{
		{"resource", "imagePreparationConcurrency", 999}, {"resource", "resourceDownloadConcurrency", 999},
		{"resource", "uploadConcurrency", 999}, {"resource", "mediaRecoveryConcurrency", 999},
		{"task", "agentMaxSessions", 64},
	}
	for _, field := range fields {
		for _, limit := range []int{-1, 0, 1, 64, 65, 999, 1000} {
			t.Run(fmt.Sprintf("%s/%d", field.name, limit), func(t *testing.T) {
				policy := DefaultRuntimePolicy()
				payload := fmt.Sprintf(`{"%s":{"%s":%d}}`, field.section, field.name, limit)
				if err := json.Unmarshal([]byte(payload), &policy); err != nil {
					t.Fatal(err)
				}
				if err := ValidateRuntimePolicy(policy); (err == nil) != (limit >= 1 && limit <= field.max) {
					t.Fatalf("limit=%d validation=%v", limit, err)
				}
			})
		}
	}
	s, _, _ := concurrencyTestService(t)
	selfUse, err := s.AdminSelfUseRuntimePolicy(&model.User{ID: "admin"})
	if err != nil {
		t.Fatal(err)
	}
	saveConcurrencyTestPolicy(t, s, selfUse.RuntimePolicySetting)
	limits, err := s.PublicRuntimeLimits()
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(limits.Concurrency)
	if err != nil {
		t.Fatal(err)
	}
	var values map[string]int
	if err := json.Unmarshal(encoded, &values); err != nil {
		t.Fatal(err)
	}
	for name, value := range values {
		want := 999
		if name == "agentSessions" {
			want = 64
		}
		if value != want {
			t.Errorf("self-use %s=%d, want %d", name, value, want)
		}
	}
}

func TestCustomRelaySlotsUseGlobalPolicyAndRefresh(t *testing.T) {
	s, _, _ := concurrencyTestService(t)
	policy := DefaultRuntimePolicy()
	policy.Request.CustomRelayConcurrency = 1
	saveConcurrencyTestPolicy(t, s, policy)
	release, acquired, err := s.AcquireCustomRelaySlot(context.Background(), "user", 999, time.Minute)
	if err != nil || !acquired {
		t.Fatalf("first relay: acquired=%v err=%v", acquired, err)
	}
	defer release()
	if extra, acquired, err := s.AcquireCustomRelaySlot(context.Background(), "user", 999, time.Minute); err != nil || acquired {
		if extra != nil {
			extra()
		}
		t.Fatalf("caller bypassed policy: acquired=%v err=%v", acquired, err)
	}
	policy.Request.CustomRelayConcurrency = 2
	saveConcurrencyTestPolicy(t, s, policy)
	extra, acquired, err := s.AcquireCustomRelaySlot(context.Background(), "user", 1, time.Minute)
	if err != nil || !acquired {
		t.Fatalf("updated global policy ignored: acquired=%v err=%v", acquired, err)
	}
	extra()
	release()
	if len(s.Coordinator.localSlots) != 0 {
		t.Fatal("released relay leases retained")
	}
}
