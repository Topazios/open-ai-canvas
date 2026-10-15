package repository

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

var ErrCanvasNodeShotLinkConflict = errors.New("节点映射已变化，请刷新预览")
var ErrCanvasNodeShotLinkInvalid = errors.New("节点映射无效")

func (r *Repository) CanvasNodeShotLinks(projectID, canvasID string) ([]model.CanvasNodeShotLink, error) {
	var links []model.CanvasNodeShotLink
	err := r.db.Where("project_id = ? AND canvas_id = ?", projectID, canvasID).Order("created_at asc, id asc").Find(&links).Error
	return links, err
}

func canvasNodeType(payloadJSON, nodeID string) (string, error) {
	var document struct {
		Nodes []struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal([]byte(payloadJSON), &document); err != nil {
		return "", fmt.Errorf("%w: 画布快照无法读取", ErrCanvasNodeShotLinkInvalid)
	}
	nodeType := ""
	for _, node := range document.Nodes {
		if node.ID != nodeID {
			continue
		}
		if nodeType != "" || node.Type == "" {
			return "", fmt.Errorf("%w: 节点标识重复或类型无效", ErrCanvasNodeShotLinkInvalid)
		}
		nodeType = node.Type
	}
	if nodeType == "" {
		return "", fmt.Errorf("%w: 画布节点已删除，请重新选择", ErrCanvasNodeShotLinkInvalid)
	}
	return nodeType, nil
}

func artifactMatchesCanvasNode(artifactType, nodeType string) bool {
	switch artifactType {
	case "video", "delivery":
		return nodeType == "video"
	case "audio":
		return nodeType == "audio"
	case "storyboard", "action_board", "start_frame", "end_frame":
		return nodeType == "image"
	default:
		return false
	}
}

// The mapping is a project relation. It never mutates the canvas snapshot or shot content.
func (r *Repository) UpsertCanvasNodeShotLinkAtomic(userID string, desired model.CanvasNodeShotLink, expectedCanvasRevision, expectedProjectRevision int64, now time.Time) (model.CanvasNodeShotLink, error) {
	var saved model.CanvasNodeShotLink
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var project model.Project
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&project, "id = ? AND user_id = ?", desired.ProjectID, userID).Error; err != nil {
			return err
		}
		if project.Status == model.ProjectStatusArchived {
			return ErrProjectArchived
		}
		var canvas model.CanvasProject
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&canvas, "id = ? AND user_id = ? AND project_id = ?", desired.CanvasID, userID, desired.ProjectID).Error; err != nil {
			return err
		}
		nodeType, err := canvasNodeType(canvas.PayloadJSON, desired.NodeID)
		if err != nil {
			return err
		}
		var unit model.ProjectUnit
		if err := tx.First(&unit, "id = ? AND project_id = ?", desired.UnitID, desired.ProjectID).Error; err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			return fmt.Errorf("%w: 目标章节已删除或不属于当前项目", ErrCanvasNodeShotLinkInvalid)
		}
		var unitLink model.CanvasUnitLink
		if err := tx.First(&unitLink, "project_id = ? AND canvas_id = ? AND unit_id = ?", desired.ProjectID, desired.CanvasID, desired.UnitID).Error; err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			return fmt.Errorf("%w: 请先将画布关联到目标章节", ErrCanvasNodeShotLinkInvalid)
		}
		var shot model.Shot
		if err := tx.First(&shot, "id = ? AND project_id = ? AND unit_id = ?", desired.ShotID, desired.ProjectID, desired.UnitID).Error; err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			return fmt.Errorf("%w: 镜头不属于目标章节", ErrCanvasNodeShotLinkInvalid)
		}
		if shot.CurrentRevisionID == "" {
			return fmt.Errorf("%w: 镜头尚无可关联的修订版本", ErrCanvasNodeShotLinkInvalid)
		}
		var revision model.ShotRevision
		if err := tx.First(&revision, "id = ? AND shot_id = ?", shot.CurrentRevisionID, shot.ID).Error; err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
			return fmt.Errorf("%w: 镜头修订版本已失效，请刷新镜头", ErrCanvasNodeShotLinkInvalid)
		}
		if desired.ArtifactID != "" {
			var artifact model.ShotArtifact
			if err := tx.First(&artifact, "id = ? AND project_id = ? AND unit_id = ? AND shot_id = ?", desired.ArtifactID, desired.ProjectID, desired.UnitID, shot.ID).Error; err != nil {
				if !errors.Is(err, gorm.ErrRecordNotFound) {
					return err
				}
				return fmt.Errorf("%w: 产物不属于目标镜头", ErrCanvasNodeShotLinkInvalid)
			}
			if artifact.Status != "ready" || !artifact.Selected || artifact.RevisionID != shot.CurrentRevisionID || artifact.ResourceID == "" || !artifactMatchesCanvasNode(artifact.Type, nodeType) {
				return fmt.Errorf("%w: 请选择当前镜头已采用且类型匹配的就绪产物", ErrCanvasNodeShotLinkInvalid)
			}
			var resource model.Resource
			if err := tx.First(&resource, "id = ? AND user_id = ? AND status = ?", artifact.ResourceID, userID, model.ResourceStatusReady).Error; err != nil {
				if !errors.Is(err, gorm.ErrRecordNotFound) {
					return err
				}
				return fmt.Errorf("%w: 产物资源已失效，请刷新镜头", ErrCanvasNodeShotLinkInvalid)
			}
		}
		var existing model.CanvasNodeShotLink
		err = tx.First(&existing, "canvas_id = ? AND node_id = ?", desired.CanvasID, desired.NodeID).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if err == nil && existing.ProjectID == desired.ProjectID && existing.UnitID == desired.UnitID && existing.ShotID == desired.ShotID && existing.ShotRevisionID == shot.CurrentRevisionID && existing.ArtifactID == desired.ArtifactID {
			saved = existing
			return nil
		}
		if canvas.Revision != expectedCanvasRevision || project.Revision != expectedProjectRevision {
			return ErrCanvasNodeShotLinkConflict
		}
		desired.ShotRevisionID = shot.CurrentRevisionID
		desired.UpdatedAt = now
		if err == nil {
			result := tx.Model(&model.CanvasNodeShotLink{}).Where("id = ? AND project_id = ? AND canvas_id = ?", existing.ID, desired.ProjectID, desired.CanvasID).Updates(map[string]any{
				"unit_id": desired.UnitID, "shot_id": desired.ShotID, "shot_revision_id": desired.ShotRevisionID, "artifact_id": desired.ArtifactID, "updated_at": now,
			})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return ErrCanvasNodeShotLinkConflict
			}
			existing.UnitID, existing.ShotID, existing.ShotRevisionID, existing.ArtifactID, existing.UpdatedAt = desired.UnitID, desired.ShotID, desired.ShotRevisionID, desired.ArtifactID, now
			saved = existing
		} else {
			desired.CreatedAt = now
			if err := tx.Create(&desired).Error; err != nil {
				return err
			}
			saved = desired
		}
		result := tx.Model(&model.Project{}).Where("id = ? AND user_id = ? AND revision = ?", desired.ProjectID, userID, expectedProjectRevision).Updates(map[string]any{
			"revision": gorm.Expr("revision + 1"), "updated_at": now,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrCanvasNodeShotLinkConflict
		}
		return nil
	})
	return saved, err
}

func (r *Repository) DeleteCanvasNodeShotLinkAtomic(userID, projectID, canvasID, nodeID, expectedLinkID string, expectedProjectRevision int64, now time.Time) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var project model.Project
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&project, "id = ? AND user_id = ?", projectID, userID).Error; err != nil {
			return err
		}
		if project.Status == model.ProjectStatusArchived {
			return ErrProjectArchived
		}
		var canvas model.CanvasProject
		if err := tx.First(&canvas, "id = ? AND user_id = ? AND project_id = ?", canvasID, userID, projectID).Error; err != nil {
			return err
		}
		var existing model.CanvasNodeShotLink
		err := tx.First(&existing, "project_id = ? AND canvas_id = ? AND node_id = ?", projectID, canvasID, nodeID).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if existing.ID != expectedLinkID || project.Revision != expectedProjectRevision {
			return ErrCanvasNodeShotLinkConflict
		}
		if err := tx.Delete(&existing).Error; err != nil {
			return err
		}
		result := tx.Model(&model.Project{}).Where("id = ? AND user_id = ? AND revision = ?", projectID, userID, expectedProjectRevision).Updates(map[string]any{
			"revision": gorm.Expr("revision + 1"), "updated_at": now,
		})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrCanvasNodeShotLinkConflict
		}
		return nil
	})
}
