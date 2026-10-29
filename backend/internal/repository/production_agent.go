package repository

import (
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

func (r *Repository) ProductionAgentJob(userID, runID string) (*model.ProductionAgentJob, error) {
	var row model.ProductionAgentJob
	err := r.db.First(&row, "user_id = ? AND run_id = ?", userID, runID).Error
	return &row, err
}
func (r *Repository) ProductionAgentJobsForCanvas(userID, canvasID string) ([]model.ProductionAgentJob, error) {
	var rows []model.ProductionAgentJob
	err := r.db.Where("user_id = ? AND canvas_id = ?", userID, canvasID).Order("created_at, run_id").Find(&rows).Error
	return rows, err
}
func (r *Repository) CreateProductionAgentJob(row *model.ProductionAgentJob) error {
	return r.db.Create(row).Error
}
func (r *Repository) UpdateProductionAgentManifest(userID, runID, manifest string) error {
	return r.db.Model(&model.ProductionAgentJob{}).Where("user_id = ? AND run_id = ?", userID, runID).Update("manifest_json", manifest).Error
}

func (r *Repository) RestoreProductionAgentScope(userID, runID, previous, manifest string) error {
	result := r.db.Model(&model.ProductionAgentJob{}).
		Where("user_id = ? AND run_id = ? AND manifest_json = ?", userID, runID, previous).
		Updates(map[string]any{"manifest_json": manifest, "validated": false})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrCreationConflict
	}
	return nil
}
func (r *Repository) ProductionAgentTransaction(fn func(*Repository) error) error {
	return r.db.Transaction(func(tx *gorm.DB) error { return fn(New(tx)) })
}
func (r *Repository) UpdateProductionAgentArtifact(row *model.ProductionAgentArtifact) error {
	return r.db.Save(row).Error
}

func (r *Repository) ActiveProductionAgentJobs(userID, canvasID string) ([]model.ProductionAgentJob, error) {
	rows := []model.ProductionAgentJob{}
	err := r.db.Where("user_id = ? AND canvas_id = ? AND run_id IN (SELECT id FROM cloud_agent_executions WHERE user_id = ? AND status IN ?)", userID, canvasID, userID, []string{"running", "queued"}).Order("created_at, run_id").Limit(100).Find(&rows).Error
	return rows, err
}

func (r *Repository) ProductionAgentStorageBytes(userID string) (int64, error) {
	var bytes int64
	query := `SELECT COALESCE(SUM(length(manifest_json)),0) FROM production_agent_jobs WHERE user_id = ?`
	if err := r.db.Raw(query, userID).Scan(&bytes).Error; err != nil {
		return 0, err
	}
	var pages int64
	if err := r.db.Raw(`SELECT COALESCE(SUM(length(text)+length(facts_json)),0) FROM production_agent_pages WHERE user_id = ?`, userID).Scan(&pages).Error; err != nil {
		return 0, err
	}
	// UTF-8 characters occupy at most four bytes on both supported databases.
	var receipts int64
	if err := r.db.Raw(`SELECT COALESCE(SUM(length(fact_ids_json)+length(key)+length(content_hash)),0) FROM production_agent_artifacts WHERE user_id = ?`, userID).Scan(&receipts).Error; err != nil {
		return 0, err
	}
	return (bytes + pages + receipts) * 4, nil
}

func (r *Repository) DeleteProductionAgentCanvas(userID, canvasID string) error {
	if !r.db.Migrator().HasTable(&model.ProductionAgentJob{}) {
		return nil
	}
	jobs := r.db.Model(&model.ProductionAgentJob{}).Select("run_id").Where("user_id = ? AND canvas_id = ?", userID, canvasID)
	if err := r.db.Where("user_id = ? AND run_id IN (?)", userID, jobs).Delete(&model.ProductionAgentArtifact{}).Error; err != nil {
		return err
	}
	if err := r.db.Where("user_id = ? AND canvas_id = ?", userID, canvasID).Delete(&model.ProductionAgentJob{}).Error; err != nil {
		return err
	}
	return r.db.Where("user_id = ? AND canvas_id = ?", userID, canvasID).Delete(&model.ProductionAgentPage{}).Error
}
func (r *Repository) ValidateProductionAgentJob(userID, runID string, valid bool) error {
	return r.db.Model(&model.ProductionAgentJob{}).Where("user_id = ? AND run_id = ?", userID, runID).Update("validated", valid).Error
}
func (r *Repository) ProductionAgentPage(userID, id string) (*model.ProductionAgentPage, error) {
	var row model.ProductionAgentPage
	err := r.db.First(&row, "user_id = ? AND id = ?", userID, id).Error
	return &row, err
}
func (r *Repository) EnsureProductionAgentPage(row *model.ProductionAgentPage) error {
	return r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(row).Error
}
func (r *Repository) CompleteProductionAgentPage(userID, id, facts string) error {
	result := r.db.Model(&model.ProductionAgentPage{}).Where("user_id = ? AND id = ? AND processed = ?", userID, id, false).
		Updates(map[string]any{"facts_json": facts, "processed": true})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrCreationConflict
	}
	return nil
}
func (r *Repository) ProductionAgentArtifacts(userID, runID string) ([]model.ProductionAgentArtifact, error) {
	rows := []model.ProductionAgentArtifact{}
	err := r.db.Where("user_id = ? AND run_id = ?", userID, runID).Order("created_at, key").Find(&rows).Error
	return rows, err
}
func (r *Repository) CreateProductionAgentArtifact(row *model.ProductionAgentArtifact) error {
	return r.db.Create(row).Error
}

func (r *Repository) DeleteProductionAgentArtifact(userID, runID, key, nodeID string) error {
	return r.db.Where("user_id = ? AND run_id = ? AND key = ? AND node_id = ?", userID, runID, key, nodeID).Delete(&model.ProductionAgentArtifact{}).Error
}
