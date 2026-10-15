package app

import (
	"encoding/json"

	"infinite-canvas/backend/internal/model"
)

// CanvasNodeShotView is a read projection, never a second editable shot record.
type CanvasNodeShotView struct {
	LinkID            string              `json:"linkId"`
	NodeID            string              `json:"nodeId"`
	State             string              `json:"state"`
	ShotTitle         string              `json:"shotTitle,omitempty"`
	CurrentRevisionID string              `json:"currentRevisionId,omitempty"`
	Revision          *model.ShotRevision `json:"revision,omitempty"`
	Artifact          *model.ShotArtifact `json:"artifact,omitempty"`
	ResourceAvailable bool                `json:"resourceAvailable"`
}

func (s *Service) CanvasNodeShotMappingViews(userID, projectID, canvasID string) ([]model.CanvasNodeShotLink, []CanvasNodeShotView, error) {
	links, err := s.CanvasNodeShotLinks(userID, projectID, canvasID)
	if err != nil {
		return nil, nil, err
	}
	views := make([]CanvasNodeShotView, 0, len(links))
	if len(links) == 0 {
		return links, views, nil
	}
	canvas, err := s.repo.CanvasProjectForUser(userID, canvasID)
	if err != nil {
		return nil, nil, canvasNodeShotLinkError(err)
	}
	var document struct {
		Nodes []struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal([]byte(canvas.PayloadJSON), &document); err != nil {
		return nil, nil, err
	}
	nodeTypes := make(map[string]string, len(document.Nodes))
	nodeCounts := make(map[string]int, len(document.Nodes))
	for _, node := range document.Nodes {
		nodeTypes[node.ID] = node.Type
		nodeCounts[node.ID]++
	}
	shots, err := s.repo.ProjectShots(projectID)
	if err != nil {
		return nil, nil, err
	}
	revisions, err := s.repo.ProjectShotRevisions(projectID)
	if err != nil {
		return nil, nil, err
	}
	artifacts, err := s.repo.ProjectShotArtifacts(projectID)
	if err != nil {
		return nil, nil, err
	}
	units, err := s.repo.ProjectUnitSummaries(projectID)
	if err != nil {
		return nil, nil, err
	}
	unitLinks, err := s.repo.ProjectCanvasUnitLinks(projectID)
	if err != nil {
		return nil, nil, err
	}
	shotByID := make(map[string]model.Shot, len(shots))
	for _, shot := range shots {
		shotByID[shot.ID] = shot
	}
	revisionByID := make(map[string]model.ShotRevision, len(revisions))
	for _, revision := range revisions {
		revisionByID[revision.ID] = revision
	}
	artifactByID := make(map[string]model.ShotArtifact, len(artifacts))
	for _, artifact := range artifacts {
		artifactByID[artifact.ID] = artifact
	}
	unitIDs := make(map[string]bool, len(units))
	for _, unit := range units {
		unitIDs[unit.ID] = true
	}
	linkedUnits := make(map[string]bool)
	for _, link := range unitLinks {
		if link.CanvasID == canvasID {
			linkedUnits[link.UnitID] = true
		}
	}
	resourceIDs := make([]string, 0, len(links))
	seen := make(map[string]bool)
	for _, link := range links {
		artifact, ok := artifactByID[link.ArtifactID]
		if ok && artifact.ShotID == link.ShotID && artifact.UnitID == link.UnitID && artifact.ResourceID != "" && !seen[artifact.ResourceID] {
			seen[artifact.ResourceID] = true
			resourceIDs = append(resourceIDs, artifact.ResourceID)
		}
	}
	readyResources := make(map[string]bool, len(resourceIDs))
	// Bound SQL parameters on both SQLite and PostgreSQL, without a request per node.
	for start := 0; start < len(resourceIDs); start += 200 {
		resources, err := s.repo.ResourcesForUserIDs(userID, resourceIDs[start:min(start+200, len(resourceIDs))])
		if err != nil {
			return nil, nil, err
		}
		for _, resource := range resources {
			readyResources[resource.ID] = resource.Status == model.ResourceStatusReady
		}
	}
	for _, link := range links {
		view := CanvasNodeShotView{LinkID: link.ID, NodeID: link.NodeID, State: "current"}
		shot, shotExists := shotByID[link.ShotID]
		revision, revisionExists := revisionByID[link.ShotRevisionID]
		artifact, artifactExists := artifactByID[link.ArtifactID]
		if shotExists && shot.UnitID == link.UnitID {
			view.ShotTitle, view.CurrentRevisionID = shot.Title, shot.CurrentRevisionID
			if revisionExists && revision.ShotID == shot.ID {
				view.Revision = &revision
			}
			if artifactExists && artifact.ShotID == shot.ID && artifact.UnitID == link.UnitID && artifact.RevisionID == link.ShotRevisionID {
				view.Artifact = &artifact
				view.ResourceAvailable = readyResources[artifact.ResourceID]
			}
		}
		switch {
		case nodeCounts[link.NodeID] != 1 || nodeTypes[link.NodeID] == "":
			view.State = "node_missing"
		case !unitIDs[link.UnitID] || !linkedUnits[link.UnitID]:
			view.State = "unit_missing"
		case !shotExists || shot.UnitID != link.UnitID:
			view.State = "shot_missing"
		case view.Revision == nil:
			view.State = "revision_missing"
		case shot.CurrentRevisionID != link.ShotRevisionID:
			view.State = "shot_revised"
		case link.ArtifactID != "" && (view.Artifact == nil || artifact.Status != "ready" || !artifact.Selected):
			view.State = "artifact_changed"
		case link.ArtifactID != "" && !canvasShotArtifactMatchesNode(artifact.Type, nodeTypes[link.NodeID]):
			view.State = "node_type_changed"
		case link.ArtifactID != "" && !view.ResourceAvailable:
			view.State = "resource_unavailable"
		}
		views = append(views, view)
	}
	return links, views, nil
}

func canvasShotArtifactMatchesNode(artifactType, nodeType string) bool {
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
