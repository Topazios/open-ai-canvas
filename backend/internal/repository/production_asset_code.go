package repository

import (
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

// The existing sequence table survives node and task deletion. Allocation runs
// inside the production tool transaction, alongside the persisted identity.
func (r *Repository) ReserveProductionAssetCode(scope, prefix string) (string, error) {
	row := model.IDSequence{Name: scope, Value: 0}
	if err := r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
		return "", err
	}
	if err := r.db.Model(&row).Where("name = ?", scope).Updates(map[string]any{"value": gorm.Expr("value + 1"), "updated_at": time.Now()}).Error; err != nil {
		return "", err
	}
	if err := r.db.First(&row, "name = ?", scope).Error; err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%04d", prefix, row.Value), nil
}
