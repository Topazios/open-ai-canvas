package app

import (
	"errors"
	"slices"
	"testing"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// legacyShapeStory rewrites the canvas into the old layout: the outline sits
// outside the container and is wired to it, the real source feeds the outline.
func legacyShapeStory(t *testing.T, s *Service, db *gorm.DB, runID string, edit func(node map[string]any)) (storyID, frameID string) {
	t.Helper()
	found, _, _ := planPlaceholders(t, s, runID)
	m, _, _ := orderedPlanState(t, s, runID)
	storyID, frameID = stringValue(found["story"]["id"]), m.FrameID
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		node := productionNode(doc, storyID)
		delete(node, "parentId")
		if edit != nil {
			edit(node)
		}
		data := productionWorkflow(productionNode(doc, frameID))
		members := []any{}
		for _, id := range stringSlice(data["sourceNodeIds"]) {
			if id != storyID {
				members = append(members, id)
			}
		}
		data["sourceNodeIds"] = members
		kept := []map[string]any{}
		for _, edge := range creationMaps(doc["connections"]) {
			if stringValue(edge["fromNodeId"]) == "body" && stringValue(edge["toNodeId"]) == frameID {
				continue
			}
			kept = append(kept, edge)
		}
		kept = append(kept,
			map[string]any{"id": "legacy-in", "fromNodeId": "body", "toNodeId": storyID},
			map[string]any{"id": "legacy-out", "fromNodeId": storyID, "toNodeId": frameID},
		)
		doc["connections"] = kept
	})
	return storyID, frameID
}

func submitStoryForTest(t *testing.T, s *Service, runID string) {
	t.Helper()
	productionCall(t, s, runID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, runID)}, false)
	d := orderedPlanDocument("story", "")
	d["episodeArchitecture"] = productionEpisodeArchitectureFixture(3)
	productionCall(t, s, runID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": d, "factIds": []string{}}, false)
}

func storyReceipt(t *testing.T, s *Service, runID string) (model.ProductionAgentArtifact, bool) {
	t.Helper()
	rows, err := s.repo.ProductionAgentArtifacts("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.Key == "story" {
			return row, true
		}
	}
	return model.ProductionAgentArtifact{}, false
}

func canvasPayload(t *testing.T, s *Service) string {
	t.Helper()
	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	return canvas.PayloadJSON
}

func TestProductionAttachLegacyStoryMovesSubmittedOutlineIntoContainer(t *testing.T) {
	s, db, run := planFixture(t, 5)
	submitStoryForTest(t, s, run.ID)
	storyID, frameID := legacyShapeStory(t, s, db, run.ID, nil)

	migrated, err := s.productionAttachLegacyStory("user", run.ID)
	if err != nil || !migrated {
		t.Fatalf("migrated=%v err=%v", migrated, err)
	}
	found, members, doc := planPlaceholders(t, s, run.ID)
	story := found["story"]
	if stringValue(story["id"]) != storyID || stringValue(story["parentId"]) != frameID {
		t.Fatalf("outline not inside the container: %v", story)
	}
	count := 0
	for _, id := range members {
		if id == storyID {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("outline listed %d times in sourceNodeIds", count)
	}
	data := productionWorkflow(productionNode(doc, frameID))
	if !slices.Contains(stringSlice(data["sourceNodeIds"]), storyID) {
		t.Fatal("stringSlice cannot read the migrated sourceNodeIds")
	}
	if storyEdgeCount(doc, storyID, frameID) != 0 || storyEdgeCount(doc, frameID, storyID) != 0 {
		t.Fatal("container and outline must not stay linked")
	}
	if storyEdgeCount(doc, "body", frameID) != 1 {
		t.Fatalf("source must feed the container once, got %d", storyEdgeCount(doc, "body", frameID))
	}
	row, ok := storyReceipt(t, s, run.ID)
	if !ok || row.ContentHash != productionArtifactHash(productionNode(doc, row.NodeID)) {
		t.Fatal("receipt does not match the moved outline")
	}
}

func TestProductionAttachLegacyStoryKeepsHandEditedText(t *testing.T) {
	s, db, run := planFixture(t, 5)
	submitStoryForTest(t, s, run.ID)
	before, _ := storyReceipt(t, s, run.ID)
	const edited = "手改后的总纲正文"
	legacyShapeStory(t, s, db, run.ID, func(node map[string]any) {
		meta, _ := node["metadata"].(map[string]any)
		meta["content"] = edited
	})
	migrated, err := s.productionAttachLegacyStory("user", run.ID)
	if err != nil || !migrated {
		t.Fatalf("migrated=%v err=%v", migrated, err)
	}
	found, _, _ := planPlaceholders(t, s, run.ID)
	meta, _ := found["story"]["metadata"].(map[string]any)
	if meta["content"] != edited {
		t.Fatalf("hand edit was overwritten: %v", meta["content"])
	}
	after, _ := storyReceipt(t, s, run.ID)
	if after.ContentHash == before.ContentHash || after.ContentHash != productionArtifactHash(found["story"]) {
		t.Fatal("receipt must be recomputed for the edited outline")
	}
}

func TestProductionAttachLegacyStoryMovesPlaceholder(t *testing.T) {
	s, db, run := planFixture(t, 5)
	storyID, frameID := legacyShapeStory(t, s, db, run.ID, nil)
	migrated, err := s.productionAttachLegacyStory("user", run.ID)
	if err != nil || !migrated {
		t.Fatalf("migrated=%v err=%v", migrated, err)
	}
	found, members, _ := planPlaceholders(t, s, run.ID)
	if stringValue(found["story"]["parentId"]) != frameID || !slices.Contains(members, storyID) {
		t.Fatal("placeholder outline was not moved into the container")
	}
}

func TestProductionAttachLegacyStoryIsIdempotent(t *testing.T) {
	s, db, run := planFixture(t, 5)
	submitStoryForTest(t, s, run.ID)
	legacyShapeStory(t, s, db, run.ID, nil)
	if migrated, err := s.productionAttachLegacyStory("user", run.ID); err != nil || !migrated {
		t.Fatalf("first run migrated=%v err=%v", migrated, err)
	}
	payload := canvasPayload(t, s)
	migrated, err := s.productionAttachLegacyStory("user", run.ID)
	if err != nil || migrated {
		t.Fatalf("second run migrated=%v err=%v", migrated, err)
	}
	if canvasPayload(t, s) != payload {
		t.Fatal("second run rewrote the canvas")
	}
}

func TestProductionAttachLegacyStoryWaitsForRunningWork(t *testing.T) {
	s, db, run := planFixture(t, 5)
	submitStoryForTest(t, s, run.ID)
	legacyShapeStory(t, s, db, run.ID, nil)
	child := model.Task{ID: "model-child", UserID: "user", ProjectID: "agent-canvas", Status: model.TaskStatusQueued, Operation: "cloud_agent_step"}
	if err := db.Create(&child).Error; err != nil {
		t.Fatal(err)
	}
	exec, _ := s.repo.CloudAgent("user", run.ID)
	if err := s.repo.MutateCloudAgent("user", run.ID, exec.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		state.ActiveTaskID = child.ID
		state.TaskIDs = append(state.TaskIDs, child.ID)
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	payload := canvasPayload(t, s)
	migrated, err := s.productionAttachLegacyStory("user", run.ID)
	if !errors.Is(err, repository.ErrCreationConflict) || migrated {
		t.Fatalf("migrated=%v err=%v", migrated, err)
	}
	if canvasPayload(t, s) != payload {
		t.Fatal("a conflicting run must not touch the canvas")
	}
}

func TestProductionAttachLegacyStorySkipsFinishedRun(t *testing.T) {
	s, db, run := planFixture(t, 5)
	submitStoryForTest(t, s, run.ID)
	legacyShapeStory(t, s, db, run.ID, nil)
	if err := db.Model(&model.CloudAgentExecution{}).Where("id = ?", run.ID).Update("status", "completed").Error; err != nil {
		t.Fatal(err)
	}
	payload := canvasPayload(t, s)
	migrated, err := s.productionAttachLegacyStory("user", run.ID)
	if err != nil || migrated {
		t.Fatalf("migrated=%v err=%v", migrated, err)
	}
	if canvasPayload(t, s) != payload {
		t.Fatal("a finished run must keep its canvas")
	}
}
