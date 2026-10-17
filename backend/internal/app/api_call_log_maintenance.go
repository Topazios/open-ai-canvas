package app

import (
	"context"
	"log/slog"
	"time"
)

const (
	apiCallLogCompactionBodyLimit = 32 << 10
	apiCallLogCompactionBatchSize = 100
	apiCallLogCompactionPasses    = 8
)

func (s *Service) startAPICallLogMaintenanceWorker(ctx context.Context) {
	s.runWorkerLoop(func(ctx context.Context) {
		s.compactAPICallLogBodies(apiCallLogCompactionPasses)
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.compactAPICallLogBodies(apiCallLogCompactionPasses)
			}
		}
	})
}

func (s *Service) compactAPICallLogBodies(maxPasses int) {
	if s == nil || s.repo == nil {
		return
	}
	for pass := 0; pass < maxPasses; pass++ {
		count, err := s.repo.CompactAPICallLogBodies(apiCallLogCompactionBodyLimit, apiCallLogCompactionBatchSize)
		if err != nil {
			slog.Warn("api call log body compaction failed", "error", err)
			return
		}
		if count == 0 || count < apiCallLogCompactionBatchSize {
			return
		}
	}
}
