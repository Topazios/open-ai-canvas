package app

import (
	"errors"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

const productionRunRemovedCode = "production_run_removed"

func productionRunRemovedError(message string) error {
	err := BadAuthRequest(message)
	err.Details = map[string]any{"code": productionRunRemovedCode}
	return err
}

// ensureProductionRunActive accepts a run that was removed by canvas cleanup while
// its target node is still on the canvas, and brings it back. A run whose node is
// really gone keeps failing, now with a machine-readable code.
func (s *Service) ensureProductionRunActive(userID string, task *model.Task, message string) error {
	if task == nil || task.RemovedAt == nil {
		return nil
	}
	target, agent := canvasTaskTarget(*task)
	if target == "" || !agent || task.ProjectID == "" {
		return productionRunRemovedError(message)
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	missing, err := s.canvasTaskTargetMissing(userID, task.ProjectID, task.ID, target, true)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return productionRunRemovedError(message)
		}
		return err
	}
	if missing {
		return productionRunRemovedError(message)
	}
	if err := s.repo.RestoreRemovedCanvasTask(userID, task.ID); err != nil {
		return err
	}
	task.RemovedAt = nil
	return nil
}