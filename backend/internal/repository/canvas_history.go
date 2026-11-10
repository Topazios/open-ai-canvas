package repository

import (
	"encoding/json"
	"errors"
	"fmt"
	"infinite-canvas/backend/internal/canvas/integrity"
	"slices"
	"time"

	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrCanvasHistoryResourceMissing = errors.New("画布历史引用的资源不存在")
var ErrCanvasHistoryResourceReferenced = errors.New("资源仍被画布历史引用，无法删除")

type CanvasHistoryResourceMissingError struct {
	ResourceIDs []string
	References  []assets.DocumentResourceReference
}

func (e *CanvasHistoryResourceMissingError) Error() string {
	return fmt.Sprintf("canvas history resources missing: %v", e.ResourceIDs)
}

func (e *CanvasHistoryResourceMissingError) Unwrap() error {
	return ErrCanvasHistoryResourceMissing
}

const canvasSnapshotSummaryColumns = "id, canvas_id, user_id, revision, title, node_count, connection_count, payload_bytes, reason, content_updated_at, created_at"

func canvasDocumentNodeIDs(payload string) ([]string, error) {
	var document struct {
		Nodes []struct {
			ID string `json:"id"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal([]byte(payload), &document); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(document.Nodes))
	for _, node := range document.Nodes {
		if node.ID != "" {
			ids = append(ids, node.ID)
		}
	}
	return ids, nil
}

func filterCanvasDeletionReceipts(payload string, receipts []model.CanvasNodeDeletionReceipt) (string, []string, error) {
	deleted := make(map[string]bool, len(receipts))
	for _, receipt := range receipts {
		deleted[receipt.NodeID] = true
	}
	return integrity.CleanJSON(payload, deleted)
}

func (r *Repository) CanvasProjectMetadata(userID, id string) (*model.CanvasProject, error) {
	var project model.CanvasProject
	err := r.db.Omit("payload_json").Where("id = ? AND user_id = ?", id, userID).First(&project).Error
	return &project, err
}

func (r *Repository) CanvasSnapshots(userID, canvasID string, limit int) ([]model.CanvasSnapshot, error) {
	items := []model.CanvasSnapshot{}
	err := r.db.Select(canvasSnapshotSummaryColumns).Where("user_id = ? AND canvas_id = ?", userID, canvasID).
		Order("revision DESC").Limit(limit).Find(&items).Error
	return items, err
}

func (r *Repository) CanvasSnapshot(userID, canvasID, id string) (*model.CanvasSnapshot, error) {
	var item model.CanvasSnapshot
	err := r.db.Where("id = ? AND user_id = ? AND canvas_id = ?", id, userID, canvasID).First(&item).Error
	return &item, err
}

func (r *Repository) CanvasNodeDeletionReceipts(userID, canvasID string) ([]model.CanvasNodeDeletionReceipt, error) {
	var rows []model.CanvasNodeDeletionReceipt
	err := r.db.Where("user_id = ? AND canvas_id = ?", userID, canvasID).Find(&rows).Error
	return rows, err
}

func (r *Repository) AddCanvasNodeDeletionReceipts(userID, canvasID string, nodeIDs []string) (bool, error) {
	rows := make([]model.CanvasNodeDeletionReceipt, 0, len(nodeIDs))
	now := time.Now().UTC()
	for _, id := range nodeIDs {
		if id == "" {
			continue
		}
		rows = append(rows, model.CanvasNodeDeletionReceipt{UserID: userID, CanvasID: canvasID, NodeID: id, CreatedAt: now})
	}
	if len(rows) == 0 {
		return false, nil
	}
	result := r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&rows)
	return result.RowsAffected > 0, result.Error
}

func (r *Repository) DeleteCanvasNodeDeletionReceipts(userID, canvasID string, nodeIDs []string) error {
	if len(nodeIDs) == 0 {
		return nil
	}
	return r.db.Where("user_id = ? AND canvas_id = ? AND node_id IN ?", userID, canvasID, nodeIDs).Delete(&model.CanvasNodeDeletionReceipt{}).Error
}

// The successful CAS takes the canvas row lock before inspecting the history.
// Snapshot creation, reference protection and retention commit with the content.
func (r *Repository) SaveCanvasWithSnapshot(project *model.CanvasProject, snapshot *model.CanvasSnapshot, resourceIDs, currentResourceIDs []string, cutoff time.Time, limit int, reason string, force bool) error {
	next := *project
	err := r.db.Transaction(func(tx *gorm.DB) error {
		if err := New(tx).UpsertCanvasProject(&next); err != nil {
			return err
		}
		// Only an explicit history restore can intentionally bring tombstoned node
		// IDs back. A normal client save may contain stale nodes from an in-flight
		// refresh and must not remove the fence before filtering them below.
		if reason == "before_restore" {
			ids, err := canvasDocumentNodeIDs(project.PayloadJSON)
			if err != nil {
				return err
			}
			if len(ids) > 0 {
				if err := tx.Where("user_id = ? AND canvas_id = ? AND node_id IN ?", project.UserID, project.ID, ids).Delete(&model.CanvasNodeDeletionReceipt{}).Error; err != nil {
					return err
				}
			}
		}
		var receipts []model.CanvasNodeDeletionReceipt
		if err := tx.Where("user_id = ? AND canvas_id = ?", project.UserID, project.ID).Find(&receipts).Error; err != nil {
			return err
		}
		{
			filtered, removed, err := filterCanvasDeletionReceipts(project.PayloadJSON, receipts)
			if err != nil {
				return err
			}
			if _, err := New(tx).AddCanvasNodeDeletionReceipts(project.UserID, project.ID, removed); err != nil {
				return err
			}
			next.PayloadJSON = filtered
			if filtered != project.PayloadJSON {
				refs := map[string]struct{}{}
				if err := assets.CollectOwnedDocumentReferences(filtered, refs); err != nil {
					return err
				}
				currentResourceIDs = assets.SortedIDs(refs)
				if err := tx.Model(&model.CanvasProject{}).Where("id = ? AND user_id = ? AND revision = ?", project.ID, project.UserID, next.Revision).Update("payload_json", filtered).Error; err != nil {
					return err
				}
			}
		}
		capture := false
		if snapshot != nil {
			var last model.CanvasSnapshot
			err := tx.Select("id", "revision", "created_at").Where("canvas_id = ?", project.ID).Order("revision DESC").First(&last).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			capture = err != nil || (last.Revision != snapshot.Revision && (force || !last.CreatedAt.After(cutoff)))
		}
		requiredIDs := append([]string{}, currentResourceIDs...)
		if capture {
			requiredIDs = append(requiredIDs, resourceIDs...)
		}
		slices.Sort(requiredIDs)
		requiredIDs = slices.Compact(requiredIDs)
		if len(requiredIDs) > 0 {
			var resources []model.Resource
			query := tx.Select("id").Where("id IN ? AND user_id = ? AND status = ?", requiredIDs, project.UserID, model.ResourceStatusReady).Order("id")
			if r.Dialect() == "postgres" {
				query = query.Clauses(clause.Locking{Strength: "UPDATE"})
			}
			if err := query.Find(&resources).Error; err != nil {
				return err
			}
			found := make(map[string]struct{}, len(resources))
			for _, resource := range resources {
				found[resource.ID] = struct{}{}
			}
			missingIDs := make([]string, 0)
			allowDamagedPreimage := snapshot != nil && (snapshot.Reason == "before_resource_repair" || snapshot.Reason == "before_restore")
			for _, id := range requiredIDs {
				if _, exists := found[id]; !exists {
					if allowDamagedPreimage && !slices.Contains(currentResourceIDs, id) {
						continue
					}
					missingIDs = append(missingIDs, id)
				}
			}
			if len(missingIDs) > 0 {
				missingSet := make(map[string]struct{}, len(missingIDs))
				for _, id := range missingIDs {
					missingSet[id] = struct{}{}
				}
				missingRefs := make([]assets.DocumentResourceReference, 0)
				documents := map[string]string{"current": next.PayloadJSON}
				if capture {
					documents["history"] = snapshot.PayloadJSON
				}
				for _, source := range []string{"current", "history"} {
					refs, collectErr := assets.CollectDocumentResourceReferences(documents[source])
					if collectErr != nil {
						return collectErr
					}
					for _, ref := range refs {
						if _, missing := missingSet[ref.ResourceID]; missing {
							ref.Source = source
							missingRefs = append(missingRefs, ref)
						}
					}
				}
				for _, id := range missingIDs {
					if !containsResourceReference(missingRefs, id) {
						missingRefs = append(missingRefs, assets.DocumentResourceReference{ResourceID: id, Path: "history", ReferenceType: "snapshot"})
					}
				}
				return &CanvasHistoryResourceMissingError{ResourceIDs: missingIDs, References: missingRefs}
			}
			if allowDamagedPreimage {
				resourceIDs = slices.DeleteFunc(slices.Clone(resourceIDs), func(id string) bool {
					_, exists := found[id]
					return !exists
				})
			}
		}
		if !capture {
			return nil
		}
		if err := tx.Create(snapshot).Error; err != nil {
			return err
		}
		refs := make([]model.CanvasSnapshotResource, 0, len(resourceIDs))
		for _, id := range resourceIDs {
			refs = append(refs, model.CanvasSnapshotResource{SnapshotID: snapshot.ID, ResourceID: id})
		}
		if len(refs) > 0 {
			if err := tx.CreateInBatches(refs, 200).Error; err != nil {
				return err
			}
		}
		var expired []string
		if err := tx.Model(&model.CanvasSnapshot{}).Where("canvas_id = ?", project.ID).Order("revision DESC").Offset(limit).Limit(100).Pluck("id", &expired).Error; err != nil {
			return err
		}
		return deleteCanvasSnapshots(tx, expired)
	})
	if err == nil {
		*project = next
	}
	return err
}

func (r *Repository) CanvasHistoryReferencesObject(resource *model.Resource) (bool, error) {
	var count int64
	aliases := r.db.Model(&model.Resource{}).Select("id").Where("endpoint = ? AND bucket = ? AND object_key = ?", resource.Endpoint, resource.Bucket, resource.ObjectKey)
	err := r.db.Model(&model.CanvasSnapshotResource{}).
		Where("resource_id = ? OR resource_id IN (?)", resource.ID, aliases).
		Count(&count).Error
	return count > 0, err
}

func containsResourceReference(references []assets.DocumentResourceReference, resourceID string) bool {
	for _, reference := range references {
		if reference.ResourceID == resourceID {
			return true
		}
	}
	return false
}

func deleteCanvasSnapshots(tx *gorm.DB, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	if err := tx.Where("snapshot_id IN ?", ids).Delete(&model.CanvasSnapshotResource{}).Error; err != nil {
		return err
	}
	return tx.Where("id IN ?", ids).Delete(&model.CanvasSnapshot{}).Error
}

func (r *Repository) CanvasHistoryResourceReferences(resourceIDs []string) ([]ResourceDirectReference, error) {
	refs := []ResourceDirectReference{}
	if len(resourceIDs) == 0 {
		return refs, nil
	}
	err := r.db.Table("canvas_snapshot_resources AS refs").
		Select("'画布历史版本' AS kind, snapshots.canvas_id AS id, snapshots.title, refs.resource_id").
		Joins("JOIN canvas_snapshots AS snapshots ON snapshots.id = refs.snapshot_id").
		Where("refs.resource_id IN ?", resourceIDs).Distinct().Scan(&refs).Error
	return refs, err
}

func (r *Repository) RequireNoCanvasHistoryReferences(resourceIDs []string) error {
	if len(resourceIDs) == 0 {
		return nil
	}
	var resources []model.Resource
	query := r.db.Select("id").Where("id IN ?", resourceIDs).Order("id")
	if r.Dialect() == "postgres" {
		query = query.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	if err := query.Find(&resources).Error; err != nil {
		return err
	}
	refs, err := r.CanvasHistoryResourceReferences(resourceIDs)
	if err != nil {
		return err
	}
	if len(refs) > 0 {
		return ErrCanvasHistoryResourceReferenced
	}
	return nil
}
