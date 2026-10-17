package platform

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

// With the local Coordinator, Done is selected only after an attempt is full.
// Observing that select lets policy changes happen during a real wait.
type channelSlotWaitContext struct {
	context.Context
	waiting chan struct{}
}

func (c channelSlotWaitContext) Done() <-chan struct{} {
	select {
	case c.waiting <- struct{}{}:
	default:
	}
	return c.Context.Done()
}

type channelSlotWaitResult struct {
	limit int
	err   error
}

func startChannelSlotWaiter(t *testing.T, s *Service, kinds ...model.TaskConcurrencyKind) (<-chan struct{}, <-chan channelSlotWaitResult, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	waiting := make(chan struct{}, 1)
	result := make(chan channelSlotWaitResult, 1)
	done := make(chan struct{})
	t.Cleanup(func() {
		cancel()
		<-done
	})
	go func() {
		defer close(done)
		release, limit, err := s.AcquireChannelSlot(channelSlotWaitContext{ctx, waiting}, "supplier", "", time.Minute, kinds...)
		if release != nil {
			release()
		}
		result <- channelSlotWaitResult{limit: limit, err: err}
	}()
	return waiting, result, cancel
}

func requireChannelSlotWaiting(t *testing.T, waiting <-chan struct{}, result <-chan channelSlotWaitResult) {
	t.Helper()
	select {
	case <-waiting:
	case got := <-result:
		t.Fatalf("expected full channel to wait, got limit=%d err=%v", got.limit, got.err)
	case <-time.After(3 * time.Second):
		t.Fatal("channel request did not enter backoff")
	}
}

func requireChannelSlotAcquired(t *testing.T, result <-chan channelSlotWaitResult, want int) {
	t.Helper()
	select {
	case got := <-result:
		if got.err != nil || got.limit != want {
			t.Fatalf("acquire returned limit=%d err=%v, want limit=%d", got.limit, got.err, want)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("channel request did not use the updated limit")
	}
}

func TestChannelSlotWaitRefreshesGlobalPolicy(t *testing.T) {
	for _, field := range []string{"channel", "channel_with_category", "category"} {
		for _, change := range []string{"increase", "decrease"} {
			t.Run(field+"/"+change, func(t *testing.T) {
				s, _, _ := concurrencyTestService(t)
				policy := DefaultRuntimePolicy()
				policy.Task.ChannelConcurrency = 3
				policy.Task.ImageConcurrency = 3
				limitField := &policy.Task.ChannelConcurrency
				var kinds []model.TaskConcurrencyKind
				if field != "channel" {
					kinds = []model.TaskConcurrencyKind{model.TaskConcurrencyImage}
				}
				if field == "category" {
					limitField = &policy.Task.ImageConcurrency
				}
				initial, updated := 1, 2
				if change == "decrease" {
					initial, updated = 2, 1
				}
				*limitField = initial
				saveConcurrencyTestPolicy(t, s, policy)
				var releases []func()
				for range initial {
					release, limit, err := s.AcquireChannelSlot(context.Background(), "supplier", "", time.Minute, kinds...)
					if err != nil || limit != initial {
						t.Fatalf("initial acquire: limit=%d err=%v", limit, err)
					}
					t.Cleanup(release)
					releases = append(releases, release)
				}
				waiting, result, _ := startChannelSlotWaiter(t, s, kinds...)
				requireChannelSlotWaiting(t, waiting, result)
				*limitField = updated
				saveConcurrencyTestPolicy(t, s, policy)
				if change == "decrease" {
					// One active lease still fills the new cap, despite room under the old cap.
					releases[1]()
					requireChannelSlotWaiting(t, waiting, result)
					releases[0]()
				}
				// Increasing capacity must admit the waiter while the first lease remains held.
				requireChannelSlotAcquired(t, result, updated)
			})
		}
	}
}

func TestChannelSlotWaitPreservesFailureDetails(t *testing.T) {
	for _, failure := range []string{"cancel", "policy_read"} {
		t.Run(failure, func(t *testing.T) {
			s, db, _ := concurrencyTestService(t)
			policy := DefaultRuntimePolicy()
			policy.Task.ChannelConcurrency = 1
			saveConcurrencyTestPolicy(t, s, policy)
			release, _, err := s.AcquireChannelSlot(context.Background(), "supplier", "", time.Minute, model.TaskConcurrencyImage)
			if err != nil {
				t.Fatal(err)
			}
			defer release()
			waiting, result, cancel := startChannelSlotWaiter(t, s, model.TaskConcurrencyImage)
			requireChannelSlotWaiting(t, waiting, result)
			wantReason := "channel_concurrency_wait_cancelled"
			if failure == "cancel" {
				cancel()
			} else {
				if err := db.Model(&model.SystemSetting{}).Where("key = ?", runtimePolicySettingKey).Update("value_json", "{").Error; err != nil {
					t.Fatal(err)
				}
				s.runtimePolicyCache.Clear()
				s.concurrencyCache.Clear()
				wantReason = "channel_concurrency_unavailable"
			}
			select {
			case got := <-result:
				var slotErr channelSlotError
				if !errors.As(got.err, &slotErr) || slotErr.scope != "supplier:kind:image" || slotErr.limit != 1 || got.limit != 1 {
					t.Fatalf("channel failure lost context: limit=%d err=%v", got.limit, got.err)
				}
				if reason, _ := ChannelSlotFailureDetails(got.err); reason != wantReason {
					t.Fatalf("failure reason=%q, want %q", reason, wantReason)
				}
				if failure == "cancel" && !errors.Is(got.err, context.Canceled) {
					t.Fatalf("cancellation cause lost: %v", got.err)
				}
				if failure == "policy_read" && !strings.Contains(got.err.Error(), "读取全局并发配置失败") {
					t.Fatalf("policy read cause lost: %v", got.err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("channel waiter did not propagate failure")
			}
		})
	}
}
