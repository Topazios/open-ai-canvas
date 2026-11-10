package app

import (
	"context"
	"time"
)

// Notifications reduce read pressure, never replace durable state. A bounded
// scan still recovers missed events and completions on a different instance.
func productionFlowWait(ctx context.Context, events <-chan CanvasTaskEventView, work map[string]productionParallelWork) error {
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	active := map[string]bool{}
	for _, w := range work {
		if w.TaskID != "" {
			active[w.TaskID] = true
		}
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return nil
		case event, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			if active[event.TaskID] && cloudAgentTaskTerminal(event.Status) {
				return nil
			}
		}
	}
}
