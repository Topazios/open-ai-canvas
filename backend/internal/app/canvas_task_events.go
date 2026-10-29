package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
)

// CanvasTaskEventView is intentionally smaller than Task. The event tells the
// browser what changed; the batch task endpoint remains the source of the safe
// public task read model.
type CanvasTaskEventView struct {
	Seq       int64            `json:"seq"`
	ProjectID string           `json:"projectId"`
	TaskID    string           `json:"taskId"`
	EventType string           `json:"eventType"`
	Status    model.TaskStatus `json:"status"`
	Stage     string           `json:"stage,omitempty"`
	Progress  int              `json:"progress"`
	UpdatedAt time.Time        `json:"updatedAt"`
	CreatedAt time.Time        `json:"createdAt"`
}

type canvasTaskEventSubscriber struct {
	ch chan CanvasTaskEventView
}

type canvasTaskEventHub struct {
	mu          sync.Mutex
	subscribers map[string]map[*canvasTaskEventSubscriber]struct{}
}

const canvasTaskEventMaxSubscribersPerProject = 32

var errCanvasTaskEventSubscriberLimit = errors.New("画布任务事件连接数已达到上限")

func newCanvasTaskEventHub() *canvasTaskEventHub {
	return &canvasTaskEventHub{subscribers: make(map[string]map[*canvasTaskEventSubscriber]struct{})}
}

func (h *canvasTaskEventHub) subscribe(ctx context.Context, userID, projectID string, maxSubscribers int) (<-chan CanvasTaskEventView, func(), error) {
	subscriber := &canvasTaskEventSubscriber{ch: make(chan CanvasTaskEventView, 32)}
	key := canvasTaskEventSubscriptionKey(userID, projectID)
	h.mu.Lock()
	projectSubscribers := h.subscribers[key]
	if projectSubscribers == nil {
		projectSubscribers = make(map[*canvasTaskEventSubscriber]struct{})
	}
	if maxSubscribers <= 0 || maxSubscribers > canvasTaskEventMaxSubscribersPerProject {
		maxSubscribers = canvasTaskEventMaxSubscribersPerProject
	}
	if len(projectSubscribers) >= maxSubscribers {
		h.mu.Unlock()
		return nil, func() {}, errCanvasTaskEventSubscriberLimit
	}
	projectSubscribers[subscriber] = struct{}{}
	h.subscribers[key] = projectSubscribers
	h.mu.Unlock()

	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			h.mu.Lock()
			if projectSubscribers := h.subscribers[key]; projectSubscribers != nil {
				delete(projectSubscribers, subscriber)
				if len(projectSubscribers) == 0 {
					delete(h.subscribers, key)
				}
			}
			h.mu.Unlock()
		})
	}
	// The HTTP handler owns the subscription lifetime and calls cleanup with
	// defer. Do not start one waiting goroutine per SSE connection: the request
	// context already wakes the handler select and keeps the hub bounded.
	_ = ctx
	return subscriber.ch, cleanup, nil
}

func canvasTaskEventSubscriptionKey(userID, projectID string) string {
	return userID + "\x00" + projectID
}

func (h *canvasTaskEventHub) publish(event CanvasTaskEventView, userID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for subscriber := range h.subscribers[canvasTaskEventSubscriptionKey(userID, event.ProjectID)] {
		select {
		case subscriber.ch <- event:
		default:
			// Keep the stream bounded. A later batch refresh will provide the
			// complete read model if an intermediate progress event is coalesced.
			select {
			case <-subscriber.ch:
			default:
			}
			select {
			case subscriber.ch <- event:
			default:
			}
		}
	}
}

func (s *Service) canvasTaskEventBus() *canvasTaskEventHub {
	if s.canvasTaskEvents != nil {
		return s.canvasTaskEvents
	}
	s.canvasTaskEventsMu.Lock()
	defer s.canvasTaskEventsMu.Unlock()
	if s.canvasTaskEvents == nil {
		s.canvasTaskEvents = newCanvasTaskEventHub()
	}
	return s.canvasTaskEvents
}

func (s *Service) subscribeCanvasTaskEvents(ctx context.Context, userID, projectID string) (<-chan CanvasTaskEventView, func(), error) {
	return s.canvasTaskEventBus().subscribe(ctx, userID, projectID, s.canvasTaskEventPolicy().TaskEventMaxConnectionsPerUser)
}

// publishCanvasTaskEvent persists before notifying live subscribers. A failed
// live notification can therefore be repaired by replaying the durable cursor.
func (s *Service) publishCanvasTaskEvent(taskID string) {
	if s == nil || s.repo == nil || taskID == "" {
		return
	}
	task, err := s.repo.Task(taskID)
	if err != nil || task.ProjectID == "" || !strings.HasPrefix(task.Type, "canvas_") {
		return
	}
	payload, err := json.Marshal(map[string]any{
		"taskId":    task.ID,
		"projectId": task.ProjectID,
		"status":    task.Status,
		"stage":     task.Stage,
		"progress":  task.Progress,
		"updatedAt": task.UpdatedAt,
	})
	if err != nil {
		return
	}
	event := &model.CanvasTaskEvent{
		UserID:    task.UserID,
		ProjectID: task.ProjectID,
		TaskID:    task.ID,
		EventType: "task.changed",
		Payload:   string(payload),
		CreatedAt: time.Now(),
	}
	retention := s.canvasTaskEventPolicy().TaskEventRetentionHours
	if retention < 1 {
		retention = 168
	}
	event.ExpiresAt = event.CreatedAt.Add(time.Duration(retention) * time.Hour)
	created, err := s.repo.CreateCanvasTaskEventIfChanged(event)
	if err != nil {
		slog.Warn("canvas task event persistence failed", "task_id", task.ID, "project_id", task.ProjectID, "error", err)
		return
	}
	if !created {
		return
	}
	s.canvasTaskEventBus().publish(CanvasTaskEventView{
		Seq: event.Seq, ProjectID: event.ProjectID, TaskID: event.TaskID,
		EventType: event.EventType, Status: task.Status, Stage: task.Stage,
		Progress: task.Progress, UpdatedAt: task.UpdatedAt, CreatedAt: event.CreatedAt,
	}, task.UserID)
}

func (s *Service) canvasTaskEventViews(userID, projectID string, after int64, limit int) ([]CanvasTaskEventView, error) {
	events, err := s.repo.CanvasTaskEventsForUser(userID, projectID, after, limit)
	if err != nil {
		return nil, err
	}
	result := make([]CanvasTaskEventView, 0, len(events))
	for _, event := range events {
		view := CanvasTaskEventView{Seq: event.Seq, ProjectID: event.ProjectID, TaskID: event.TaskID, EventType: event.EventType, CreatedAt: event.CreatedAt}
		var payload struct {
			Status    model.TaskStatus `json:"status"`
			Stage     string           `json:"stage"`
			Progress  int              `json:"progress"`
			UpdatedAt time.Time        `json:"updatedAt"`
		}
		if json.Unmarshal([]byte(event.Payload), &payload) == nil {
			view.Status, view.Stage, view.Progress, view.UpdatedAt = payload.Status, payload.Stage, payload.Progress, payload.UpdatedAt
		}
		result = append(result, view)
	}
	return result, nil
}

func (s *Service) CanvasTaskEvents(userID, projectID string, after int64, limit int) ([]CanvasTaskEventView, error) {
	if _, err := s.repo.CanvasProjectForUser(userID, projectID); err != nil {
		return nil, err
	}
	return s.canvasTaskEventViews(userID, projectID, after, limit)
}

func (s *Service) SubscribeCanvasTaskEvents(ctx context.Context, userID, projectID string) (<-chan CanvasTaskEventView, func(), error) {
	if _, err := s.repo.CanvasProjectForUser(userID, projectID); err != nil {
		return nil, func() {}, err
	}
	return s.subscribeCanvasTaskEvents(ctx, userID, projectID)
}

func (s *Service) canvasTaskEventPolicy() platform.RuntimeCanvasPolicy {
	if s != nil {
		if policy, err := s.RuntimePolicy(); err == nil {
			return policy.Canvas
		}
	}
	return platform.DefaultRuntimePolicy().Canvas
}

func (s *Service) CanvasTaskEventReplayLimit() int {
	limit := s.canvasTaskEventPolicy().TaskEventMaxReplayEvents
	if limit < 1 {
		return 200
	}
	return limit
}

func (s *Service) CanvasTaskEventHeartbeat() time.Duration {
	seconds := s.canvasTaskEventPolicy().TaskEventHeartbeatSeconds
	if seconds < 5 {
		seconds = 15
	}
	return time.Duration(seconds) * time.Second
}

func (s *Service) startCanvasTaskEventCleanup(ctx context.Context) {
	s.runWorkerLoop(func(ctx context.Context) {
		prune := func() {
			if err := s.repo.PruneCanvasTaskEvents(time.Now(), 1000); err != nil {
				slog.Warn("canvas task event cleanup failed", "error", err)
			}
		}
		prune()
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				prune()
			}
		}
	})
}
