package app

import (
	"context"
	"testing"
)

func TestCanvasTaskEventHubScopesAndCleansSubscriptions(t *testing.T) {
	hub := newCanvasTaskEventHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first, cleanupFirst, err := hub.subscribe(ctx, "user-1", "canvas-1", canvasTaskEventMaxSubscribersPerProject)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanupFirst()
	other, cleanupOther, err := hub.subscribe(ctx, "user-2", "canvas-1", canvasTaskEventMaxSubscribersPerProject)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanupOther()

	hub.publish(CanvasTaskEventView{Seq: 1, ProjectID: "canvas-1", TaskID: "task-1"}, "user-1")
	select {
	case event := <-first:
		if event.TaskID != "task-1" {
			t.Fatalf("unexpected event: %#v", event)
		}
	case <-ctx.Done():
		t.Fatal("scoped subscriber did not receive event")
	}
	select {
	case event := <-other:
		t.Fatalf("cross-user event leaked: %#v", event)
	default:
	}

	cleanupFirst()
	hub.mu.Lock()
	if len(hub.subscribers[canvasTaskEventSubscriptionKey("user-1", "canvas-1")]) != 0 {
		t.Fatal("cleanup left subscriber retained")
	}
	hub.mu.Unlock()
}

func TestCanvasTaskEventHubBoundsSubscribersAndQueue(t *testing.T) {
	hub := newCanvasTaskEventHub()
	ctx := context.Background()
	cleanups := make([]func(), 0, canvasTaskEventMaxSubscribersPerProject)
	for i := 0; i < canvasTaskEventMaxSubscribersPerProject; i++ {
		_, cleanup, err := hub.subscribe(ctx, "user-1", "canvas-1", canvasTaskEventMaxSubscribersPerProject)
		if err != nil {
			t.Fatal(err)
		}
		cleanups = append(cleanups, cleanup)
	}
	if _, cleanup, err := hub.subscribe(ctx, "user-1", "canvas-1", canvasTaskEventMaxSubscribersPerProject); err == nil {
		cleanup()
		t.Fatal("subscriber limit was not enforced")
	}
	for _, cleanup := range cleanups {
		cleanup()
	}

	stream, cleanup, err := hub.subscribe(ctx, "user-1", "canvas-1", canvasTaskEventMaxSubscribersPerProject)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	for seq := int64(1); seq <= 64; seq++ {
		hub.publish(CanvasTaskEventView{Seq: seq, ProjectID: "canvas-1", TaskID: "task-1"}, "user-1")
	}
	count := 0
	for {
		select {
		case <-stream:
			count++
		default:
			if count > 32 {
				t.Fatalf("event queue grew beyond its bound: %d", count)
			}
			return
		}
	}
}
