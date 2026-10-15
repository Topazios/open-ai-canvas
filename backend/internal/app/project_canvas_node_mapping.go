package app

import (
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type LinkCanvasNodeShotRequest struct {
	UnitID                  string `json:"unitId"`
	NodeID                  string `json:"nodeId"`
	ShotID                  string `json:"shotId"`
	ArtifactID              string `json:"artifactId"`
	ExpectedCanvasRevision  int64  `json:"expectedCanvasRevision"`
	ExpectedProjectRevision int64  `json:"expectedProjectRevision"`
}

type UnlinkCanvasNodeShotRequest struct {
	ExpectedLinkID          string `json:"expectedLinkId"`
	ExpectedProjectRevision int64  `json:"expectedProjectRevision"`
}

func (s *Service) CanvasNodeShotLinks(userID, projectID, canvasID string) ([]model.CanvasNodeShotLink, error) {
	if _, err := s.repo.ProjectForUser(userID, projectID); err != nil {
		return nil, canvasNodeShotLinkError(err)
	}
	canvas, err := s.repo.CanvasProjectForUser(userID, strings.TrimSpace(canvasID))
	if err != nil {
		return nil, canvasNodeShotLinkError(err)
	}
	if canvas.ProjectID != projectID {
		return nil, BadAuthRequest("画布不属于当前项目")
	}
	return s.repo.CanvasNodeShotLinks(projectID, canvas.ID)
}

func (s *Service) LinkCanvasNodeShot(userID, projectID, canvasID string, req LinkCanvasNodeShotRequest) (model.CanvasNodeShotLink, error) {
	unitID, nodeID, shotID, artifactID := strings.TrimSpace(req.UnitID), strings.TrimSpace(req.NodeID), strings.TrimSpace(req.ShotID), strings.TrimSpace(req.ArtifactID)
	canvasID = strings.TrimSpace(canvasID)
	if canvasID == "" || unitID == "" || nodeID == "" || shotID == "" || len(nodeID) > 160 || len(artifactID) > 36 || req.ExpectedCanvasRevision < 1 || req.ExpectedProjectRevision < 1 {
		return model.CanvasNodeShotLink{}, BadAuthRequest("节点、镜头或预览版本无效，请重新预览")
	}
	link := model.CanvasNodeShotLink{ID: newID(), ProjectID: projectID, CanvasID: canvasID, UnitID: unitID, NodeID: nodeID, ShotID: shotID, ArtifactID: artifactID}
	saved, err := s.repo.UpsertCanvasNodeShotLinkAtomic(userID, link, req.ExpectedCanvasRevision, req.ExpectedProjectRevision, time.Now())
	if err != nil {
		return model.CanvasNodeShotLink{}, canvasNodeShotLinkError(err)
	}
	return saved, nil
}

func (s *Service) UnlinkCanvasNodeShot(userID, projectID, canvasID, nodeID string, req UnlinkCanvasNodeShotRequest) error {
	if strings.TrimSpace(canvasID) == "" || strings.TrimSpace(nodeID) == "" || strings.TrimSpace(req.ExpectedLinkID) == "" || req.ExpectedProjectRevision < 1 {
		return BadAuthRequest("待解除的节点映射或预览版本无效")
	}
	err := s.repo.DeleteCanvasNodeShotLinkAtomic(userID, projectID, strings.TrimSpace(canvasID), strings.TrimSpace(nodeID), strings.TrimSpace(req.ExpectedLinkID), req.ExpectedProjectRevision, time.Now())
	return canvasNodeShotLinkError(err)
}

func canvasNodeShotLinkError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return NewAppError(404, "项目或画布不存在")
	}
	if errors.Is(err, repository.ErrCanvasNodeShotLinkConflict) {
		return NewAppError(409, err.Error())
	}
	if errors.Is(err, repository.ErrCanvasNodeShotLinkInvalid) {
		return BadAuthRequest(strings.TrimPrefix(err.Error(), repository.ErrCanvasNodeShotLinkInvalid.Error()+": "))
	}
	if errors.Is(err, repository.ErrProjectArchived) {
		return BadAuthRequest(err.Error())
	}
	return err
}
