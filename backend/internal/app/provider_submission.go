package app

import (
	"context"
	"time"

	"github.com/google/uuid"
	"infinite-canvas/backend/internal/model"
)

type providerSubmissionKeyContext struct{}

const missingDirectSubmissionMessage = "旧任务已尝试执行但缺少提交记录，为避免重复扣费已停止自动重发"

func withProviderSubmissionKey(ctx context.Context, attempt *model.RouteAttempt) context.Context {
	if attempt == nil {
		return ctx
	}
	// Stable for this persisted attempt across worker/process recovery; an
	// explicitly new user retry or a safely rejected route gets a new attempt.
	key := uuid.NewSHA1(uuid.NameSpaceOID, []byte(attempt.TaskID+":"+attempt.ID)).String()
	return context.WithValue(ctx, providerSubmissionKeyContext{}, key)
}

func (s *Service) createDirectTaskAttempt(task *model.Task) (*model.RouteAttempt, error) {
	if task.Attempts > 1 && task.ProviderRequestID == "" {
		return nil, routeDispatchUncertainError{missingDirectSubmissionMessage}
	}
	attempt, err := s.newDirectTaskAttempt(task, task.RouteRun)
	if err != nil {
		return nil, err
	}
	if task.ProviderRequestID != "" {
		attempt.ProviderRequestID, attempt.DispatchState = task.ProviderRequestID, "accepted"
	}
	if err := s.repo.CreateRouteAttempt(attempt); err != nil {
		return nil, err
	}
	return attempt, nil
}

func (s *Service) newDirectTaskAttempt(task *model.Task, routeRun int) (*model.RouteAttempt, error) {
	id, err := s.repo.NextPrefixedID("ATTEMPT")
	if err != nil {
		return nil, err
	}
	return &model.RouteAttempt{ID: id, TaskID: task.ID, RouteRun: routeRun, AttemptNumber: 1, ChannelModelID: task.ChannelModelID, Status: "selected", DispatchState: "not_sent", StartedAt: time.Now()}, nil
}

func unsubmittedDirectRetry(task *model.Task) bool {
	diagnostic := taskExecutionDiagnostic(task)
	return task.LogicalModelID == "" && task.RouteRun > 0 && task.Status == model.TaskStatusFailed &&
		task.Error == missingDirectSubmissionMessage && task.ProviderRequestID == "" && task.ResultJSON == "" &&
		diagnostic != nil && diagnostic.Phase == "preparation" && diagnostic.Code == "preparation_failed" && diagnostic.SubmissionOutcome == "unknown"
}
