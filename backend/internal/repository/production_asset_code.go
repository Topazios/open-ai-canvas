package repository

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

func productionCodeSequenceName(prefix, scope string) string {
	hash := sha256.Sum256([]byte(scope))
	return prefix + hex.EncodeToString(hash[:16])
}

// A namespace is allocated once per drama, independent of user and run. The
// mapping and counters are durable even when canvas nodes or tasks are deleted.
func (r *Repository) ProductionDramaCode(scope string) (string, error) {
	if strings.TrimSpace(scope) == "" {
		return "", errors.New("制作编号缺少剧范围")
	}
	name := productionCodeSequenceName("drama:", scope)
	var mapping model.IDSequence
	err := r.db.Transaction(func(tx *gorm.DB) error {
		// Acquire the namespace row before reading it. This serializes a new
		// drama across processes without upgrading a SQLite read snapshot.
		placeholder := model.IDSequence{Name: name, UpdatedAt: time.Now()}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&placeholder).Error; err != nil {
			return err
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&mapping, "name = ?", name).Error; err != nil {
			return err
		}
		if mapping.Value > 0 {
			return nil
		}
		value, err := reserveProductionCodeRange(tx, "production:dramas", 1)
		if err != nil {
			return err
		}
		mapping.Value, mapping.UpdatedAt = value, time.Now()
		return tx.Model(&mapping).Updates(map[string]any{"value": value, "updated_at": mapping.UpdatedAt}).Error
	})
	if err != nil {
		return "", err
	}
	if mapping.Value <= 0 {
		return "", errors.New("剧编号状态无效")
	}
	return fmt.Sprintf("D%03d", mapping.Value), nil
}

// Reserve the entire batch in one atomic upsert, rather than reading a maximum
// from asset documents or incrementing once per model output. RETURNING belongs
// to the write, so concurrent processes cannot observe the same allocation.
func (r *Repository) ReserveProductionCodeRange(scope string, count int64) (int64, error) {
	if strings.TrimSpace(scope) == "" {
		return 0, errors.New("制作编号缺少分配范围")
	}
	return reserveProductionCodeRange(r.db, productionCodeSequenceName("pcode:", scope), count)
}

func reserveProductionCodeRange(db *gorm.DB, name string, count int64) (int64, error) {
	if count < 1 {
		return 0, errors.New("制作编号数量必须为正整数")
	}
	row := model.IDSequence{Name: name, Value: count, UpdatedAt: time.Now()}
	result := db.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "name"}},
		DoUpdates: clause.Assignments(map[string]any{
			"value": gorm.Expr("id_sequences.value + ?", count), "updated_at": row.UpdatedAt,
		}),
		Where: clause.Where{Exprs: []clause.Expression{clause.Expr{SQL: "id_sequences.value <= ?", Vars: []any{int64(math.MaxInt64) - count}}}},
	}, clause.Returning{Columns: []clause.Column{{Name: "value"}}}).Create(&row)
	if result.Error != nil {
		return 0, result.Error
	}
	if result.RowsAffected != 1 || row.Value < count {
		return 0, errors.New("制作编号序列已达到上限")
	}
	return row.Value - count + 1, nil
}
