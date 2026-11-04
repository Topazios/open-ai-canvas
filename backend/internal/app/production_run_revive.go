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

// ensureProductionRunActive accepts a run removed by cleanup only while its target
// is still present and has no deletion receipt. Tombstones fence stale canvas saves
// and must also fence idempotent task retries from reviving deleted work.
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
	receipts, err := s.repo.CanvasNodeDeletionReceipts(userID, task.ProjectID)
	if err != nil {
		return err
	}
	deleted := make(map[string]bool, len(receipts))
	for _, receipt := range receipts {
		deleted[receipt.NodeID] = true
	}
	canvas, err := s.repo.CanvasProjectForUser(userID, task.ProjectID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return productionRunRemovedError(message)
		}
		return err
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		return err
	}
	if canvasAgentDeletedByReceipt(doc, target, deleted) {
		return productionRunRemovedError(message)
	}
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
