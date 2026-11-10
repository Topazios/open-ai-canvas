package app

import (
	"errors"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// resumeQuietHeldProduction pulls a run that an older build parked in
// waiting_user back to running, so the automatic retry rounds can take over.
// It reports whether the run was moved.
func (s *Service) resumeQuietHeldProduction(userID, runID string) bool {
	moved := false
	for attempt := 0; attempt < 4; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil || run.Status != "waiting_user" {
			return false
		}
		moved = false
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			state, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			if state.Request.Production == nil || state.ProductionPaused || !productionParallelQuietHeld(state) {
				return nil
			}
			for _, work := range state.ProductionParallel {
				if work.SceneID != "" || productionRequiresManualRetry(work) {
					return nil
				}
			}
			productionBlockRuntime(current, &state)
			moved = true
			return cloudAgentSave(current, &state)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		if err != nil {
			return false
		}
		break
	}
	if moved {
		s.projectProductionAgentStatus(userID, runID)
	}
	return moved
}

func productionRequiresManualRetry(work productionParallelWork) bool {
	return work.QuietHold && (work.FlowUnitID != "" || (work.Key == "story" && work.AutoRetryRounds >= productionParallelAutoRetryRounds) || (work.Key == "inventory" && work.InventoryNoProgress >= 3))
}
