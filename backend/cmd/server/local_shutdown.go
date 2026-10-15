package main

import (
	"context"
	"log/slog"
	"os"
	"time"
)

// The Windows local launcher supplies a unique path for this process only.
// No HTTP shutdown endpoint is exposed; deployments without the variable use signals.
func localShutdownContext(parent context.Context, requestPath string) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	if requestPath != "" {
		go watchLocalShutdown(ctx, requestPath, 250*time.Millisecond, cancel)
	}
	return ctx, cancel
}

func watchLocalShutdown(ctx context.Context, requestPath string, interval time.Duration, cancel context.CancelFunc) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if info, err := os.Stat(requestPath); err == nil && info.Mode().IsRegular() {
				slog.Info("local launcher requested graceful shutdown")
				cancel()
				return
			}
		}
	}
}
