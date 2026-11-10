package repository

import (
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

func (r *Repository) ProductionFlowUnits(userID, runID, root, source string) ([]model.ProductionFlowUnit, error) {
	rows := []model.ProductionFlowUnit{}
	q := r.db.Where("user_id = ? AND run_id = ?", userID, runID)
	if root != "" {
		q = q.Where("root = ?", root)
	}
	if source != "" {
		q = q.Where("source_hash = ?", source)
	}
	err := q.Order("created_at, key").Find(&rows).Error
	return rows, err
}

func (r *Repository) EnsureProductionFlowUnit(row *model.ProductionFlowUnit) error {
	return r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(row).Error
}

func (r *Repository) ProductionFlowUnit(userID, runID, id string) (*model.ProductionFlowUnit, error) {
	var row model.ProductionFlowUnit
	err := r.db.Where("user_id = ? AND run_id = ? AND id = ?", userID, runID, id).First(&row).Error
	return &row, err
}

func (r *Repository) ProductionFlowUnitsByIDs(userID, runID string, ids []string) ([]model.ProductionFlowUnit, error) {
	rows := []model.ProductionFlowUnit{}
	for start := 0; start < len(ids); start += 300 {
		var batch []model.ProductionFlowUnit
		if err := r.db.Where("user_id = ? AND run_id = ? AND id IN ?", userID, runID, ids[start:min(start+300, len(ids))]).Find(&batch).Error; err != nil {
			return nil, err
		}
		rows = append(rows, batch...)
	}
	return rows, nil
}

// All updates are fenced by the claimed task and generation, including retries.
func (r *Repository) SaveProductionFlowUnit(row *model.ProductionFlowUnit, taskID string, generation int) error {
	result := r.db.Model(&model.ProductionFlowUnit{}).
		Where("user_id = ? AND run_id = ? AND id = ? AND task_id = ? AND generation = ?", row.UserID, row.RunID, row.ID, taskID, generation).
		Select("Status", "TaskID", "Generation", "Attempts", "ResultJSON", "IssuesJSON", "SplitJSON", "UpdatedAt").Updates(row)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrCreationConflict
	}
	return nil
}

func (r *Repository) CreateProductionFlowReceipt(row *model.ProductionFlowReceipt) error {
	return r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(row).Error
}

func (r *Repository) ProductionFlowReceipts(userID, runID, unitID string) ([]model.ProductionFlowReceipt, error) {
	var rows []model.ProductionFlowReceipt
	err := r.db.Where("user_id = ? AND run_id = ? AND unit_id = ?", userID, runID, unitID).Order("created_at, id").Find(&rows).Error
	return rows, err
}
