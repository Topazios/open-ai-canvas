package repository

import (
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

// Relationship, document ownership and revision advance as one transaction.
func (r *Repository) LinkCanvasUnitAtomic(userID string, link *model.CanvasUnitLink, expectedRevision int64, now time.Time, saveCanvas func(*Repository, *model.CanvasProject, *model.CanvasProject) error) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var project model.Project
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&project, "id = ? AND user_id = ?", link.ProjectID, userID).Error; err != nil {
			return err
		}
		var unit model.ProjectUnit
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&unit, "id = ? AND project_id = ?", link.UnitID, link.ProjectID).Error; err != nil {
			return err
		}
		var canvas model.CanvasProject
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&canvas, "id = ? AND user_id = ?", link.CanvasID, userID).Error; err != nil {
			return err
		}
		if canvas.ProjectID != "" && canvas.ProjectID != link.ProjectID {
			return ErrCanvasRevisionConflict
		}
		if project.Status == model.ProjectStatusArchived {
			return ErrProjectArchived
		}
		var existing model.CanvasUnitLink
		err := tx.First(&existing, "project_id = ? AND canvas_id = ? AND unit_id = ?", link.ProjectID, link.CanvasID, link.UnitID).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var payload map[string]json.RawMessage
		if err := json.Unmarshal([]byte(canvas.PayloadJSON), &payload); err != nil || payload == nil {
			return errors.New("画布快照无效，无法建立章节关联")
		}
		var storedProjectID string
		_ = json.Unmarshal(payload["projectId"], &storedProjectID)
		if err == nil && existing.Role == link.Role && canvas.ProjectID == link.ProjectID && storedProjectID == link.ProjectID {
			*link = existing
			return nil
		}
		if canvas.Revision != expectedRevision {
			return ErrCanvasRevisionConflict
		}
		payload["projectId"], _ = json.Marshal(link.ProjectID)
		payload["updatedAt"], _ = json.Marshal(now.UTC().Format(time.RFC3339Nano))
		payload["revision"], _ = json.Marshal(canvas.Revision + 1)
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		nextCanvas := canvas
		nextCanvas.ProjectID = link.ProjectID
		nextCanvas.PayloadJSON = string(encoded)
		nextCanvas.UpdatedAt = now
		if err := saveCanvas(New(tx), &canvas, &nextCanvas); err != nil {
			return err
		}
		if existing.ID != "" {
			if err := tx.Model(&existing).Update("role", link.Role).Error; err != nil {
				return err
			}
			existing.Role = link.Role
			*link = existing
		} else if err := tx.Create(link).Error; err != nil {
			return err
		}
		return tx.Model(&project).Updates(map[string]any{"revision": gorm.Expr("revision + 1"), "updated_at": now}).Error
	})
}
