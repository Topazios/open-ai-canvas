package app

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type taskTerminalRepositoryStub struct {
	task             *model.Task
	taskError        error
	terminalCalls    int
	terminalError    error
	terminalConflict bool
}

func (r *taskTerminalRepositoryStub) Task(string) (*model.Task, error) {
	if r.taskError != nil {
		return nil, r.taskError
	}
	if r.task == nil {
		return nil, errors.New("task not found")
	}
	copy := *r.task
	return &copy, nil
}

func (r *taskTerminalRepositoryStub) UpdateTaskTerminalDiagnostic(task *model.Task, completedAt time.Time) (bool, error) {
	r.terminalCalls++
	if r.terminalConflict {
		return false, nil
	}
	if r.terminalError != nil {
		return false, r.terminalError
	}
	if r.task != nil {
		*r.task = *task
		r.task.CompletedAt = &completedAt
	}
	return true, nil
}

func TestTaskTerminalConflictDoesNotRefundOrFinalize(t *testing.T) {
	repo := &taskTerminalRepositoryStub{terminalConflict: true}
	billing, replay := &taskTerminalBillingStub{}, &taskTerminalReplayStub{}
	logger := &taskTerminalLoggerStub{}
	c := newTaskTerminalCoordinatorForTest(repo, billing, replay, logger, &taskTerminalOutputStub{})
	task := &model.Task{ID: "task", LeaseOwner: "stale", Status: model.TaskStatusRunning}
	err := c.handleExecutionFailure(task, errors.New("upstream failed"), false, false)
	if !errors.Is(err, repository.ErrTaskStateConflict) {
		t.Fatalf("missing conflict: %v", err)
	}
	if len(billing.refund)+len(billing.uncertain)+billing.settleCalls+len(replay.statuses) != 0 {
		t.Fatal("stale worker performed terminal side effects")
	}
}

func TestTaskTerminalProviderSuccessClassifiesLocalProcessingAcrossTaskKinds(t *testing.T) {
	for _, kind := range []string{"canvas_text", "canvas_image", "canvas_video", "canvas_audio"} {
		t.Run(kind, func(t *testing.T) {
			repo := &taskTerminalRepositoryStub{}
			billing, replay := &taskTerminalBillingStub{}, &taskTerminalReplayStub{}
			logger := &taskTerminalLoggerStub{}
			coordinator := newTaskTerminalCoordinatorForTest(repo, billing, replay, logger, &taskTerminalOutputStub{})
			task := &model.Task{ID: "postprocess-task", Type: kind, Status: model.TaskStatusRunning}
			failure := BadAuthRequest("本地结果转换未完成")
			if err := coordinator.handleExecutionFailure(task, failure, true, false); !errors.Is(err, failure) {
				t.Fatal("original local cause lost", err)
			}
			diagnostic := taskExecutionDiagnostic(task)
			if diagnostic == nil || diagnostic.Phase != "postprocess" || diagnostic.Code != "local_processing_failed" || diagnostic.SubmissionOutcome != "accepted" || diagnostic.RetryClass != "inspect_local_processing" {
				t.Fatalf("provider success was mislabeled as provider failure: %+v", diagnostic)
			}
			if task.Stage != "本地处理待核对" || len(billing.refund) != 0 || len(billing.uncertain) != 1 || diagnostic.Severity != "warning" || diagnostic.Outcome != "not_saved" {
				t.Fatal("processing attribution changed billing facts or hid the failed stage")
			}
		})
	}
}

func TestTaskTerminalProviderSuccessKeepsLocalCancellationAsPostprocessFailure(t *testing.T) {
	for _, latestUnavailable := range []bool{false, true} {
		t.Run(fmt.Sprintf("latest_unavailable_%v", latestUnavailable), func(t *testing.T) {
			task := &model.Task{ID: "postprocess-task", Status: model.TaskStatusRunning, BillingOrderID: "order-1"}
			repo := &taskTerminalRepositoryStub{task: task}
			if latestUnavailable {
				repo.taskError = errors.New("latest state temporarily unavailable")
			}
			billing, replay := &taskTerminalBillingStub{}, &taskTerminalReplayStub{}
			coordinator := newTaskTerminalCoordinatorForTest(repo, billing, replay, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{})
			failure := fmt.Errorf("本地结果转换停止：%w", context.Canceled)
			if err := coordinator.handleExecutionFailure(task, failure, true, false); err != failure {
				t.Fatalf("postprocess failure lost its original cause: %v", err)
			}
			diagnostic := taskExecutionDiagnostic(task)
			if task.Status != model.TaskStatusFailed || task.Stage != "本地处理待核对" || diagnostic == nil || diagnostic.Phase != "postprocess" || diagnostic.Code != "local_processing_failed" || diagnostic.SubmissionOutcome != "accepted" || diagnostic.RetryClass != "inspect_local_processing" || diagnostic.Severity != "warning" {
				t.Fatalf("local cancellation bypassed postprocessing classification: task=%+v diagnostic=%+v", task, diagnostic)
			}
			if task.CancellationSource != "" || task.CancellationRequestedAt != nil || repo.terminalCalls != 1 {
				t.Fatal("local processing failure invented a cancellation receipt or skipped persistence")
			}
			if len(billing.uncertain) != 1 || len(billing.refund) != 0 || billing.settleCalls != 0 || len(replay.statuses) != 1 || replay.statuses[0] != model.TaskStatusFailed {
				t.Fatalf("accepted provider result was refunded or replayed as cancelled: billing=%+v replay=%v", billing, replay.statuses)
			}
		})
	}
}

func TestTaskTerminalConfirmedCancellationRemainsCancelledAfterProviderSuccess(t *testing.T) {
	for _, providerSucceeded := range []bool{false, true} {
		t.Run(fmt.Sprintf("provider_succeeded_%v", providerSucceeded), func(t *testing.T) {
			workerTask := &model.Task{ID: "cancelled-task", Status: model.TaskStatusRunning, BillingOrderID: "order-1"}
			storedTask := *workerTask
			storedTask.Status, storedTask.Error = model.TaskStatusCancelled, "用户已取消"
			repo := &taskTerminalRepositoryStub{task: &storedTask}
			billing, replay := &taskTerminalBillingStub{}, &taskTerminalReplayStub{}
			coordinator := newTaskTerminalCoordinatorForTest(repo, billing, replay, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{})
			if err := coordinator.handleExecutionFailure(workerTask, context.Canceled, providerSucceeded, false); err != nil {
				t.Fatal(err)
			}
			if storedTask.Status != model.TaskStatusCancelled || storedTask.Error != "用户已取消" || repo.terminalCalls != 0 {
				t.Fatal("confirmed user cancellation was overwritten or persisted twice")
			}
			if len(billing.uncertain)+len(billing.refund)+billing.settleCalls != 0 || len(replay.statuses) != 1 || replay.statuses[0] != model.TaskStatusCancelled {
				t.Fatalf("confirmed cancellation repeated billing or lost its replay: billing=%+v replay=%v", billing, replay.statuses)
			}
		})
	}
}

func TestTaskTerminalWorkerCancellationBeforeProviderSuccessPreservesSubmissionBilling(t *testing.T) {
	for _, notSubmitted := range []bool{false, true} {
		t.Run(fmt.Sprintf("not_submitted_%v", notSubmitted), func(t *testing.T) {
			task := &model.Task{ID: "worker-cancelled-task", Status: model.TaskStatusRunning, BillingOrderID: "order-1"}
			repo := &taskTerminalRepositoryStub{task: task}
			billing, replay := &taskTerminalBillingStub{}, &taskTerminalReplayStub{}
			coordinator := newTaskTerminalCoordinatorForTest(repo, billing, replay, &taskTerminalLoggerStub{}, &taskTerminalOutputStub{})
			if err := coordinator.handleExecutionFailure(task, context.Canceled, false, notSubmitted); err != nil {
				t.Fatal(err)
			}
			diagnostic := taskExecutionDiagnostic(task)
			if task.Status != model.TaskStatusCancelled || task.CancellationSource != model.TaskCancellationWorkerContext || task.CancellationRequestedAt == nil || diagnostic == nil || diagnostic.Phase != "cancellation" || diagnostic.Code != "task_cancelled" {
				t.Fatalf("worker cancellation was no longer recorded: %+v", task)
			}
			if notSubmitted {
				if len(billing.refund) != 1 || len(billing.uncertain) != 0 || diagnostic.SubmissionOutcome != "not_submitted" {
					t.Fatalf("unsent request lost its refund: billing=%+v diagnostic=%+v", billing, diagnostic)
				}
			} else if len(billing.refund) != 0 || len(billing.uncertain) != 1 || diagnostic.SubmissionOutcome != "unknown" {
				t.Fatalf("uncertain provider submission was refunded: billing=%+v diagnostic=%+v", billing, diagnostic)
			}
			if len(replay.statuses) != 1 || replay.statuses[0] != model.TaskStatusCancelled || repo.terminalCalls != 1 {
				t.Fatal("worker cancellation did not persist and finalize replay once")
			}
		})
	}
}

type taskTerminalBillingStub struct {
	uncertain      []string
	refund         []string
	settleCalls    int
	review         bool
	settleError    error
	uncertainError error
	refundError    error
}

func (b *taskTerminalBillingStub) MarkBillingUncertain(_ string, reason string) error {
	b.uncertain = append(b.uncertain, reason)
	return b.uncertainError
}

func (b *taskTerminalBillingStub) RefundBilling(_ string, reason string) error {
	b.refund = append(b.refund, reason)
	return b.refundError
}

func (b *taskTerminalBillingStub) BillingFailureRequiresReview(string, string, error) bool {
	return b.review
}

func (b *taskTerminalBillingStub) SettleBilling(string, string) error {
	b.settleCalls++
	return b.settleError
}

type taskTerminalReplayStub struct {
	statuses []model.TaskStatus
}

func (r *taskTerminalReplayStub) finalizeTaskTextReplay(_ string, status model.TaskStatus) error {
	r.statuses = append(r.statuses, status)
	return nil
}

type taskTerminalLoggerStub struct {
	messages []string
}

func (l *taskTerminalLoggerStub) log(_ string, _ string, _ string, message string, _ string) error {
	l.messages = append(l.messages, message)
	return nil
}

type taskTerminalOutputStub struct {
	calls int
	err   error
}

func (o *taskTerminalOutputStub) RegisterTaskOutputFromTask(model.Task) error {
	o.calls++
	return o.err
}

func newTaskTerminalCoordinatorForTest(repo taskTerminalRepository, billing *taskTerminalBillingStub, replay *taskTerminalReplayStub, logger *taskTerminalLoggerStub, outputs *taskTerminalOutputStub) *taskTerminalCoordinator {
	return &taskTerminalCoordinator{
		repo:              repo,
		billing:           billing,
		replay:            replay,
		logger:            logger,
		outputs:           outputs,
		userFacingMessage: func(err error) string { return "public: " + err.Error() },
	}
}

func TestTaskTerminalCoordinatorHandlesCancellation(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1", BillingOrderID: "order-1"}
	repo := &taskTerminalRepositoryStub{task: task}
	billing := &taskTerminalBillingStub{}
	replay := &taskTerminalReplayStub{}
	logger := &taskTerminalLoggerStub{}
	coordinator := newTaskTerminalCoordinatorForTest(repo, billing, replay, logger, &taskTerminalOutputStub{})

	if err := coordinator.handleExecutionFailure(task, context.Canceled, false, false); err != nil {
		t.Fatalf("handleExecutionFailure() error = %v", err)
	}
	if task.Status != model.TaskStatusCancelled || task.Error != "任务已取消" {
		t.Fatalf("unexpected cancelled task state: status=%s error=%q", task.Status, task.Error)
	}
	if len(billing.uncertain) != 1 || len(billing.refund) != 0 {
		t.Fatalf("unexpected billing actions: uncertain=%v refund=%v", billing.uncertain, billing.refund)
	}
	if len(replay.statuses) != 1 || replay.statuses[0] != model.TaskStatusCancelled {
		t.Fatalf("unexpected replay statuses: %v", replay.statuses)
	}
	if len(logger.messages) != 1 || repo.terminalCalls != 1 {
		t.Fatalf("expected cancellation side effects, replay=%v logs=%v terminalCalls=%d", replay.statuses, logger.messages, repo.terminalCalls)
	}
}

func TestTaskTerminalCoordinatorRefundsFailureBeforeProviderRequest(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1", BillingOrderID: "order-1"}
	repo := &taskTerminalRepositoryStub{task: task}
	billing := &taskTerminalBillingStub{}
	replay := &taskTerminalReplayStub{}
	logger := &taskTerminalLoggerStub{}
	coordinator := newTaskTerminalCoordinatorForTest(repo, billing, replay, logger, &taskTerminalOutputStub{})
	failure := errors.New("provider unavailable")

	if err := coordinator.handleExecutionFailure(task, failure, false, true); !errors.Is(err, failure) {
		t.Fatalf("handleExecutionFailure() error = %v, want %v", err, failure)
	}
	if task.Status != model.TaskStatusFailed || task.Error != "public: provider unavailable" {
		t.Fatalf("unexpected failed task state: status=%s error=%q", task.Status, task.Error)
	}
	if len(billing.refund) != 1 || len(billing.uncertain) != 0 {
		t.Fatalf("unexpected billing actions: uncertain=%v refund=%v", billing.uncertain, billing.refund)
	}
	if len(replay.statuses) != 1 || replay.statuses[0] != model.TaskStatusFailed {
		t.Fatalf("unexpected replay statuses: %v", replay.statuses)
	}
}

func TestTaskTerminalCoordinatorLogsUnrecordedProviderFailure(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1", BillingOrderID: "order-1"}
	coordinator := newTaskTerminalCoordinatorForTest(
		&taskTerminalRepositoryStub{task: task},
		&taskTerminalBillingStub{},
		&taskTerminalReplayStub{},
		&taskTerminalLoggerStub{},
		&taskTerminalOutputStub{},
	)
	var loggedTask model.Task
	var loggedErr error
	coordinator.logFailedAttempt = func(value model.Task, err error) {
		loggedTask = value
		loggedErr = err
	}
	failure := errors.New("provider preflight failed")

	if err := coordinator.handleExecutionFailure(task, failure, false, true); !errors.Is(err, failure) {
		t.Fatalf("handleExecutionFailure() error = %v, want %v", err, failure)
	}
	if loggedTask.ID != task.ID || !errors.Is(loggedErr, failure) {
		t.Fatalf("logged failure = task:%#v error:%v", loggedTask, loggedErr)
	}
}

func TestTaskTerminalCoordinatorReturnsTerminalStateWriteError(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1", BillingOrderID: "order-1"}
	terminalError := errors.New("database unavailable")
	repo := &taskTerminalRepositoryStub{task: task, terminalError: terminalError}
	coordinator := newTaskTerminalCoordinatorForTest(
		repo,
		&taskTerminalBillingStub{},
		&taskTerminalReplayStub{},
		&taskTerminalLoggerStub{},
		&taskTerminalOutputStub{},
	)

	providerError := errors.New("provider unavailable")
	if err := coordinator.handleExecutionFailure(task, providerError, false, true); !errors.Is(err, providerError) || !errors.Is(err, terminalError) {
		t.Fatalf("handleExecutionFailure() error = %v, want provider and terminal errors", err)
	}
}

func TestTaskTerminalCoordinatorReturnsBillingRefundError(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1", BillingOrderID: "order-1"}
	billingError := errors.New("billing database unavailable")
	billing := &taskTerminalBillingStub{refundError: billingError}
	coordinator := newTaskTerminalCoordinatorForTest(
		&taskTerminalRepositoryStub{task: task},
		billing,
		&taskTerminalReplayStub{},
		&taskTerminalLoggerStub{},
		&taskTerminalOutputStub{},
	)

	providerError := errors.New("provider unavailable")
	if err := coordinator.handleExecutionFailure(task, providerError, false, true); !errors.Is(err, providerError) || !errors.Is(err, billingError) {
		t.Fatalf("handleExecutionFailure() error = %v, want provider and billing errors", err)
	}
}

func TestTaskTerminalCoordinatorReturnsOutputRegistrationErrorAfterSuccess(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1", BillingOrderID: "order-1"}
	outputError := errors.New("project output unavailable")
	outputs := &taskTerminalOutputStub{err: outputError}
	billing := &taskTerminalBillingStub{}
	coordinator := newTaskTerminalCoordinatorForTest(
		&taskTerminalRepositoryStub{task: task},
		billing,
		&taskTerminalReplayStub{},
		&taskTerminalLoggerStub{},
		outputs,
	)

	if err := coordinator.handleSuccess(task); !errors.Is(err, outputError) {
		t.Fatalf("handleSuccess() error = %v, want %v", err, outputError)
	}
	if outputs.calls != 1 || billing.settleCalls != 1 {
		t.Fatalf("expected output registration and billing settlement, calls=%d settle=%d", outputs.calls, billing.settleCalls)
	}
}

func TestTaskTerminalCoordinatorReturnsTaskReadErrorAfterSuccess(t *testing.T) {
	task := &model.Task{ID: "task-1", UserID: "user-1", BillingOrderID: "order-1"}
	taskError := errors.New("task database unavailable")
	billing := &taskTerminalBillingStub{}
	coordinator := newTaskTerminalCoordinatorForTest(
		&taskTerminalRepositoryStub{taskError: taskError},
		billing,
		&taskTerminalReplayStub{},
		&taskTerminalLoggerStub{},
		&taskTerminalOutputStub{},
	)

	if err := coordinator.handleSuccess(task); !errors.Is(err, taskError) {
		t.Fatalf("handleSuccess() error = %v, want %v", err, taskError)
	}
	if billing.settleCalls != 1 {
		t.Fatalf("billing settlement calls = %d, want 1", billing.settleCalls)
	}
}
