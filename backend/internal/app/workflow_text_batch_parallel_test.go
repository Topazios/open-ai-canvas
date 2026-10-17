package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type parallelBatchFixture struct {
	t      *testing.T
	s      *Service
	db     *gorm.DB
	parent *model.Task
}

func newParallelBatchFixture(t *testing.T, units, activeLimit int, configure ...func(*CreateTaskRequest)) *parallelBatchFixture {
	t.Helper()
	s, db := newBatchTestService(t)
	f := &parallelBatchFixture{t: t, s: s, db: db}
	f.policy(activeLimit, 3)
	request := batchTestRequest()
	batch := workflowTextBatch{Version: 1}
	for i := 0; i < units; i++ {
		batch.Units = append(batch.Units, workflowTextUnit{
			Label: fmt.Sprintf("unit-%d", i), Text: fmt.Sprintf("source material %d", i),
		})
	}
	request.Input["workflowBatch"] = batch
	for _, apply := range configure {
		apply(&request)
	}
	parent, err := s.CreateTask("parallel-batch-user", request)
	if err != nil {
		t.Fatal(err)
	}
	f.parent = parent
	return f
}

func (f *parallelBatchFixture) policy(activeLimit, concurrency int) {
	f.t.Helper()
	policy := defaultRuntimePolicy()
	policy.Task.ActiveTaskLimit = activeLimit
	policy.Task.TextConcurrency = concurrency
	policy.Task.ChannelConcurrency = 6
	if _, err := f.s.UpdateRuntimePolicySetting(&model.User{ID: "admin", Role: model.UserRoleAdmin}, policy); err != nil {
		f.t.Fatal(err)
	}
}

func (f *parallelBatchFixture) visit() {
	f.t.Helper()
	parent := claimBatchTestTask(f.t, f.s, f.db, f.parent.ID)
	if parent.ID != f.parent.ID {
		f.t.Fatalf("claimed child %s instead of parent %s", parent.ID, f.parent.ID)
	}
	if err := f.s.processWorkflowTextBatch(parent); err != nil {
		f.t.Fatal(err)
	}
	stored, err := f.s.repo.Task(parent.ID)
	if err != nil {
		f.t.Fatal(err)
	}
	f.parent = stored
}

func (f *parallelBatchFixture) children(keys ...string) map[string]*model.Task {
	f.t.Helper()
	tasks, err := f.s.repo.WorkflowBatchExecutionChildren(f.parent.UserID, f.parent.ID, 100)
	if err != nil {
		f.t.Fatal(err)
	}
	children := make(map[string]*model.Task, len(tasks))
	var actual []string
	for i := range tasks {
		child := &tasks[i]
		raw, err := f.s.decryptTaskInputJSON(child.InputJSON)
		if err != nil {
			f.t.Fatal(err)
		}
		var input struct {
			Metadata struct {
				Key string `json:"batchKey"`
			} `json:"metadata"`
		}
		if err := json.Unmarshal([]byte(raw), &input); err != nil {
			f.t.Fatal(err)
		}
		key := input.Metadata.Key
		if previous := children[key]; previous != nil {
			f.t.Fatalf("duplicate submission for %s: %s and %s", key, previous.ID, child.ID)
		}
		children[key] = child
		actual = append(actual, key)
	}
	sort.Strings(actual)
	want := append([]string(nil), keys...)
	sort.Strings(want)
	if strings.Join(actual, ",") != strings.Join(want, ",") {
		f.t.Fatalf("submitted children = %v, want %v (parent status=%s error=%s)", actual, want, f.parent.Status, f.parent.Error)
	}
	return children
}

func (f *parallelBatchFixture) startQueued(children map[string]*model.Task) {
	f.t.Helper()
	queued := make(map[string]string)
	for key, child := range children {
		if child.Status == model.TaskStatusQueued {
			queued[child.ID] = key
		}
	}
	// Keep the deferred parent out of worker claims even on a slow test machine.
	if err := f.db.Model(&model.Task{}).Where("id = ?", f.parent.ID).Update("next_poll_at", time.Now().Add(time.Hour)).Error; err != nil {
		f.t.Fatal(err)
	}
	for len(queued) > 0 {
		child, err := f.s.repo.ClaimNextTask("parallel-child-worker", time.Hour)
		if err != nil || child == nil {
			f.t.Fatalf("claim child: task=%v err=%v", child, err)
		}
		key, exists := queued[child.ID]
		if !exists {
			f.t.Fatalf("claimed unexpected task %s", child.ID)
		}
		children[key] = child
		delete(queued, child.ID)
	}
}

func (f *parallelBatchFixture) finish(child *model.Task, text string) {
	f.t.Helper()
	if child == nil || child.Status != model.TaskStatusRunning {
		f.t.Fatalf("cannot complete unclaimed child: %+v", child)
	}
	payload, err := json.Marshal(map[string]any{"mode": "text", "text": text})
	if err != nil {
		f.t.Fatal(err)
	}
	if err := f.s.saveTaskCompletionWithinStorageQuota(child, payload, nil, false); err != nil {
		f.t.Fatal(err)
	}
}

func (f *parallelBatchFixture) pending() {
	f.t.Helper()
	if f.parent.Status != model.TaskStatusRunning || f.parent.CompletedAt != nil || f.parent.ResultJSON != "" || f.parent.LeaseOwner != "" || f.parent.NextPollAt == nil {
		f.t.Fatalf("parent must yield while children are pending: status=%s owner=%q nextPoll=%v completed=%v result=%q error=%q",
			f.parent.Status, f.parent.LeaseOwner, f.parent.NextPollAt, f.parent.CompletedAt, f.parent.ResultJSON, f.parent.Error)
	}
}

func (f *parallelBatchFixture) succeeded(text string) {
	f.t.Helper()
	var result struct {
		Mode string `json:"mode"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(f.parent.ResultJSON), &result); err != nil {
		f.t.Fatal(err)
	}
	if f.parent.Status != model.TaskStatusSucceeded || result.Mode != "text" || result.Text != text || f.parent.BillingOrderID != "" {
		f.t.Fatalf("invalid final completion: status=%s result=%+v billing=%q", f.parent.Status, result, f.parent.BillingOrderID)
	}
}

func assertParallelBatchPromptOrder(t *testing.T, prompt string, markers ...string) {
	t.Helper()
	previous := -1
	for _, marker := range markers {
		position := strings.Index(prompt, marker)
		if position <= previous || strings.Count(prompt, marker) != 1 {
			t.Fatalf("merge input lost, duplicated or reordered %q: position=%d previous=%d", marker, position, previous)
		}
		previous = position
	}
}

func TestWorkflowBatchParallelMapWindowRefillsInInputOrder(t *testing.T) {
	f := newParallelBatchFixture(t, 5, 16)
	f.visit()
	keys := []string{"map-0", "map-1", "map-2"}
	children := f.children(keys...)
	f.pending()
	f.startQueued(children)
	for _, index := range []int{2, 3} {
		f.finish(children[fmt.Sprintf("map-%d", index)], fmt.Sprintf("fact[%d]", index))
		f.visit()
		keys = append(keys, fmt.Sprintf("map-%d", index+1))
		children = f.children(keys...)
		f.pending()
		f.startQueued(children)
	}
	for _, index := range []int{4, 1} {
		f.finish(children[fmt.Sprintf("map-%d", index)], fmt.Sprintf("fact[%d]", index))
		f.visit()
		children = f.children(keys...)
		f.pending()
	}
	f.finish(children["map-0"], "fact[0]")
	f.visit()
	keys = append(keys, "merge-0-0")
	children = f.children(keys...)
	f.pending()
	assertParallelBatchPromptOrder(t, children["merge-0-0"].Prompt,
		"unit-0", "fact[0]", "unit-1", "fact[1]", "unit-2", "fact[2]", "unit-3", "fact[3]", "unit-4", "fact[4]")
	f.startQueued(children)
	f.finish(children["merge-0-0"], "complete ordered result")
	f.visit()
	f.succeeded("complete ordered result")
	f.children(keys...)
}

func TestWorkflowBatchParallelRestartAndRepeatedVisitReuseChildren(t *testing.T) {
	f := newParallelBatchFixture(t, 5, 16)
	f.visit()
	keys := []string{"map-0", "map-1", "map-2"}
	original := f.children(keys...)
	f.startQueued(original)
	f.finish(original["map-1"], "saved before restart")
	f.s = &Service{repo: repository.New(f.db), dataDir: f.s.dataDir}
	f.visit()
	keys = append(keys, "map-3")
	children := f.children(keys...)
	f.pending()
	for i := 0; i < 3; i++ {
		f.visit()
		repeated := f.children(keys...)
		f.pending()
		for key, before := range children {
			after := repeated[key]
			if after.ID != before.ID || after.Status != before.Status || after.Attempts != before.Attempts || after.ResultJSON != before.ResultJSON || after.LeaseOwner != before.LeaseOwner {
				t.Fatalf("repeat visit replaced or resubmitted %s: before=%+v after=%+v", key, before, after)
			}
		}
	}
	for key, before := range original {
		after := children[key]
		if after.ID != before.ID || after.ResultJSON != before.ResultJSON || after.Status != before.Status {
			t.Fatalf("restart lost existing child %s", key)
		}
	}
}

func TestWorkflowBatchParallelCountsExistingChildrenBeyondWindow(t *testing.T) {
	f := newParallelBatchFixture(t, 7, 16)
	// Reconstruct a persisted run created before the concurrency setting shrank.
	f.policy(16, 6)
	f.visit()
	keys := []string{"map-0", "map-1", "map-2", "map-3", "map-4", "map-5"}
	children := f.children(keys...)
	f.startQueued(children)
	for i := 0; i < 3; i++ {
		f.finish(children[fmt.Sprintf("map-%d", i)], fmt.Sprintf("fact[%d]", i))
	}
	f.policy(16, 3)
	f.s = &Service{repo: repository.New(f.db), dataDir: f.s.dataDir}
	f.visit()
	children = f.children(keys...)
	f.pending()
	f.finish(children["map-5"], "fact[5]")
	f.visit()
	keys = append(keys, "map-6")
	children = f.children(keys...)
	f.pending()
	for _, key := range []string{"map-3", "map-4"} {
		if children[key].Status != model.TaskStatusRunning || children[key].Attempts != 1 {
			t.Fatalf("existing running child was replaced: %+v", children[key])
		}
	}
}

func TestWorkflowBatchParallelRespectsActiveTaskLimit(t *testing.T) {
	f := newParallelBatchFixture(t, 4, 2)
	f.visit()
	keys := []string{"map-0", "map-1"}
	children := f.children(keys...)
	f.pending()
	f.startQueued(children)
	f.finish(children["map-1"], "second unit done")
	f.visit()
	keys = append(keys, "map-2")
	f.children(keys...)
	f.pending()
}

func TestWorkflowBatchParallelMergeWindowAndRoundBarrier(t *testing.T) {
	f := newParallelBatchFixture(t, 5, 16)
	f.visit()
	keys := []string{"map-0", "map-1", "map-2"}
	children := f.children(keys...)
	f.startQueued(children)
	// Five 17k results require four bounded groups in the first merge round.
	for _, index := range []int{2, 3, 4, 1, 0} {
		f.finish(children[fmt.Sprintf("map-%d", index)], fmt.Sprintf("fact[%d]", index)+strings.Repeat("x", 17000))
		f.visit()
		if index == 2 || index == 3 {
			keys = append(keys, fmt.Sprintf("map-%d", index+1))
		}
		if index == 0 {
			keys = append(keys, "merge-0-0", "merge-0-1", "merge-0-2")
		}
		children = f.children(keys...)
		f.pending()
		f.startQueued(children)
	}
	f.finish(children["merge-0-2"], "reduced[2]")
	f.visit()
	keys = append(keys, "merge-0-3")
	children = f.children(keys...)
	f.pending()
	f.startQueued(children)
	for _, index := range []int{3, 1} {
		f.finish(children[fmt.Sprintf("merge-0-%d", index)], fmt.Sprintf("reduced[%d]", index))
		f.visit()
		children = f.children(keys...)
		f.pending()
	}
	f.finish(children["merge-0-0"], "reduced[0]")
	f.visit()
	keys = append(keys, "merge-1-0")
	children = f.children(keys...)
	f.pending()
	assertParallelBatchPromptOrder(t, children["merge-1-0"].Prompt, "reduced[0]", "reduced[1]", "reduced[2]", "reduced[3]")
	f.startQueued(children)
	f.finish(children["merge-1-0"], "final multi-round result")
	f.visit()
	f.succeeded("final multi-round result")
	f.children(keys...)
}

func TestWorkflowBatchParallelFailureDrainsSubmittedSiblings(t *testing.T) {
	for _, failedIndex := range []int{0, 2} {
		t.Run(fmt.Sprintf("failed-map-%d", failedIndex), func(t *testing.T) {
			f := newParallelBatchFixture(t, 5, 16)
			f.visit()
			keys := []string{"map-0", "map-1", "map-2"}
			children := f.children(keys...)
			f.startQueued(children)
			failed := children[fmt.Sprintf("map-%d", failedIndex)]
			updated, err := f.s.repo.UpdateTaskTerminalState(failed.ID, failed.LeaseOwner, model.TaskStatusRunning, model.TaskStatusFailed, "fixture failure", "fixture failure", time.Now())
			if err != nil || !updated {
				t.Fatalf("fail child: updated=%v err=%v", updated, err)
			}
			f.visit()
			children = f.children(keys...)
			f.pending()
			remaining := 2
			for index := 0; index < 3; index++ {
				if index == failedIndex {
					continue
				}
				f.finish(children[fmt.Sprintf("map-%d", index)], fmt.Sprintf("preserved[%d]", index))
				remaining--
				f.visit()
				children = f.children(keys...)
				if remaining > 0 {
					f.pending()
				}
			}
			if f.parent.Status != model.TaskStatusFailed || !strings.Contains(f.parent.Error, failed.ID) || f.parent.CompletedAt == nil {
				t.Fatalf("parent did not fail after draining siblings: status=%s completed=%v error=%q", f.parent.Status, f.parent.CompletedAt, f.parent.Error)
			}
			for key, child := range children {
				if child.ID != failed.ID && (child.Status != model.TaskStatusSucceeded || !strings.Contains(child.ResultJSON, "preserved[")) {
					t.Fatalf("successful sibling %s was lost: %+v", key, child)
				}
			}
		})
	}
}

func TestWorkflowBatchParallelWorkerOverlapsThreeProviderRequests(t *testing.T) {
	t.Setenv("REDIS_URL", "")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	entered := make(chan string, 8)
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	var calls, active, peak atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		calls.Add(1)
		inFlight := active.Add(1)
		defer active.Add(-1)
		for previous := peak.Load(); inFlight > previous; previous = peak.Load() {
			if peak.CompareAndSwap(previous, inFlight) {
				break
			}
		}
		select {
		case entered <- string(body):
		case <-r.Context().Done():
			return
		}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"parallel worker result\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(upstream.Close)
	t.Cleanup(unblock)
	f := newParallelBatchFixture(t, 4, 999, func(request *CreateTaskRequest) {
		request.Input["config"].(map[string]any)["baseUrl"] = upstream.URL
	})
	f.s = New(repository.New(f.db), f.s.dataDir)
	f.s.disablePiRuntime = true
	t.Cleanup(func() { _ = f.s.Close() })
	ctx, _ := f.s.backgroundWorkers().Start()
	f.s.taskWorker().start(ctx)
	t.Cleanup(func() {
		unblock()
		stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := f.s.StopWorker(stop); err != nil {
			t.Error(err)
		}
	})

	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	seen := make(map[int]bool)
	for len(seen) < 3 {
		select {
		case body := <-entered:
			index := -1
			for candidate := 0; candidate < 3; candidate++ {
				if strings.Contains(body, fmt.Sprintf("source material %d", candidate)) {
					index = candidate
					break
				}
			}
			if index < 0 || seen[index] {
				t.Fatalf("expected three distinct map requests before releasing provider: index=%d seen=%v", index, seen)
			}
			seen[index] = true
		case <-deadline.C:
			t.Fatalf("provider barrier never reached three requests: seen=%v calls=%d active=%d peak=%d", seen, calls.Load(), active.Load(), peak.Load())
		}
	}
	if calls.Load() != 3 || active.Load() != 3 || peak.Load() != 3 {
		t.Fatalf("provider requests did not overlap within window: calls=%d active=%d peak=%d", calls.Load(), active.Load(), peak.Load())
	}
	children := f.children("map-0", "map-1", "map-2")
	for key, child := range children {
		if child.Status != model.TaskStatusRunning || child.Attempts != 1 {
			t.Fatalf("provider barrier child %s is not running exactly once: %+v", key, child)
		}
	}
	unblock()

	completion := time.NewTimer(15 * time.Second)
	defer completion.Stop()
	poll := time.NewTicker(20 * time.Millisecond)
	defer poll.Stop()
	for {
		select {
		case <-poll.C:
			parent, err := f.s.repo.Task(f.parent.ID)
			if err != nil {
				t.Fatal(err)
			}
			if parent.Status == model.TaskStatusFailed {
				t.Fatalf("worker batch failed: %s", parent.Error)
			}
			if parent.Status == model.TaskStatusSucceeded {
				f.parent = parent
				f.succeeded("parallel worker result")
				f.children("map-0", "map-1", "map-2", "map-3", "merge-0-0")
				if calls.Load() != 5 || peak.Load() != 3 {
					t.Fatalf("expected four maps and one merge, peak three: calls=%d peak=%d", calls.Load(), peak.Load())
				}
				return
			}
		case <-completion.C:
			t.Fatal("worker batch did not complete after provider barrier was released")
		}
	}
}

func TestWorkflowBatchParallelParentCancellationCancelsChildren(t *testing.T) {
	for _, running := range []bool{false, true} {
		t.Run(fmt.Sprintf("running=%t", running), func(t *testing.T) {
			f := newParallelBatchFixture(t, 5, 16)
			f.visit()
			keys := []string{"map-0", "map-1", "map-2"}
			children := f.children(keys...)
			if running {
				f.startQueued(children)
			}
			stale := claimBatchTestTask(t, f.s, f.db, f.parent.ID)
			if stale.ID != f.parent.ID {
				t.Fatalf("expected parent lease, got %s", stale.ID)
			}
			cancelled, err := f.s.taskLifecycle().cancelTask(context.Background(), f.parent.UserID, f.parent.ID)
			if err != nil {
				t.Fatal(err)
			}
			if cancelled.Status != model.TaskStatusCancelled {
				t.Fatalf("parent not cancelled: %s", cancelled.Status)
			}
			for key, child := range f.children(keys...) {
				if child.Status != model.TaskStatusCancelled {
					t.Fatalf("parent cancellation left child %s in %s", key, child.Status)
				}
			}
			if err := f.s.processWorkflowTextBatch(stale); !errors.Is(err, repository.ErrTaskStateConflict) {
				t.Fatalf("cancelled parent accepted stale scheduler lease: %v", err)
			}
			f.children(keys...)
			stored, err := f.s.repo.Task(f.parent.ID)
			if err != nil || stored.Status != model.TaskStatusCancelled {
				t.Fatalf("stale visit changed cancelled parent: task=%+v err=%v", stored, err)
			}
			claimed, err := f.s.repo.ClaimNextTask("after-parent-cancel", time.Minute)
			if err != nil || claimed != nil {
				t.Fatalf("cancelled batch left claimable work: task=%+v err=%v", claimed, err)
			}
		})
	}
}

func TestWorkflowBatchParallelWorkerFencesChildrenOfTerminalParent(t *testing.T) {
	for _, status := range []model.TaskStatus{model.TaskStatusCancelled, model.TaskStatusFailed} {
		t.Run(string(status), func(t *testing.T) {
			t.Setenv("REDIS_URL", "")
			t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"must not be called"},"finish_reason":"stop"}]}`)
			}))
			defer upstream.Close()
			f := newParallelBatchFixture(t, 5, 16, func(request *CreateTaskRequest) {
				request.Input["config"].(map[string]any)["baseUrl"] = upstream.URL
			})
			f.s = New(repository.New(f.db), f.s.dataDir)
			f.s.disablePiRuntime = true
			t.Cleanup(func() { _ = f.s.Close() })
			f.visit()
			keys := []string{"map-0", "map-1", "map-2"}
			f.children(keys...)
			parent := claimBatchTestTask(t, f.s, f.db, f.parent.ID)
			// Persist the parent terminal state without cleanup to model a dispatch race.
			updated, err := f.s.repo.UpdateTaskTerminalState(parent.ID, parent.LeaseOwner, model.TaskStatusRunning, status, "terminal fixture", "terminal fixture", time.Now())
			if err != nil || !updated {
				t.Fatalf("parent terminal transition: updated=%v err=%v", updated, err)
			}
			for range keys {
				if err := f.s.taskWorker().processNextTask(); err != nil {
					t.Fatal(err)
				}
			}
			for key, child := range f.children(keys...) {
				if child.Status != model.TaskStatusCancelled {
					t.Fatalf("worker did not fence %s of %s parent: %s", key, status, child.Status)
				}
			}
			if calls.Load() != 0 {
				t.Fatalf("terminal parent leaked %d provider calls", calls.Load())
			}
		})
	}
}
