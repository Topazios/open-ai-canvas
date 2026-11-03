package app

import (
	"slices"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func planPlaceholders(t *testing.T, s *Service, runID string) (map[string]map[string]any, []string, map[string]any) {
	t.Helper()
	execution, _ := s.repo.CloudAgent("user", runID)
	state, _ := cloudAgentDecode(execution)
	_, m, doc, err := productionLoad(s.repo, execution, &state)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]map[string]any{}
	for _, node := range creationMaps(doc["nodes"]) {
		workflow := productionWorkflow(node)
		if workflow["planSection"] != nil && (node["parentId"] == m.FrameID || (workflow["planSection"] == "story" && stringValue(node["parentId"]) == "")) {
			found[stringValue(workflow["planSection"])] = node
		}
	}
	return found, productionIDs(productionWorkflow(productionNode(doc, m.FrameID))["sourceNodeIds"]), doc
}

func TestProductionPlanInitializeCreatesDocumentPlaceholders(t *testing.T) {
	s, _, run := planFixture(t, 5)
	initial, _, _ := planPlaceholders(t, s, run.ID)
	if len(initial) != 1 || initial["story"] == nil {
		t.Fatalf("a new run must only hold the story placeholder: %v", initial)
	}
	startPlansForTest(t, s, run.ID)
	found, members, _ := planPlaceholders(t, s, run.ID)
	for _, key := range []string{"story", "inventory", "visual", "direction", "generation"} {
		node := found[key]
		if node == nil {
			t.Fatalf("missing placeholder %s: %v", key, found)
		}
		if !slices.Contains(members, stringValue(node["id"])) {
			t.Fatalf("placeholder %s is not a container member", key)
		}
		meta := node["metadata"].(map[string]any)
		if meta["status"] != "processing" || productionWorkflow(node)["assetKey"] != key {
			t.Fatal(meta)
		}
	}
	created, err := s.ensureProductionPlanDocumentPlaceholders("user", run.ID)
	if err != nil || created {
		t.Fatal(created, err)
	}
	again, _, _ := planPlaceholders(t, s, run.ID)
	if len(again) != len(found) {
		t.Fatal(len(again), len(found))
	}
}

func TestProductionPlanSubmitFillsPlaceholderInPlace(t *testing.T) {
	s, _, run := planFixture(t, 5)
	before, _, _ := planPlaceholders(t, s, run.ID)
	storyID := stringValue(before["story"]["id"])
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	storyDocument := orderedPlanDocument("story", "")
	storyDocument["episodeArchitecture"] = productionEpisodeArchitectureFixture(3)
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": storyDocument, "factIds": []string{}}, false)
	after, members, doc := planPlaceholders(t, s, run.ID)
	node := after["story"]
	if node == nil || stringValue(node["id"]) != storyID {
		t.Fatal("story placeholder was not reused", node)
	}
	if productionWorkflow(node)["planGeneration"] != nil || node["metadata"].(map[string]any)["status"] != "success" {
		t.Fatal(node["metadata"])
	}
	count := 0
	for _, n := range creationMaps(doc["nodes"]) {
		if productionWorkflow(n)["planSection"] == "story" {
			count++
		}
	}
	if count != 1 || len(after) != len(before) {
		t.Fatal(count, len(after), len(before))
	}
	seen := map[string]bool{}
	for _, id := range members {
		if seen[id] {
			t.Fatal("duplicate member", id)
		}
		seen[id] = true
	}
}

func TestProductionPlanRegroupKeepsDocumentPlaceholders(t *testing.T) {
	s, _, run := planFixture(t, 5)
	if _, err := s.ensureProductionPlanGroups("user", run.ID); err != nil {
		t.Fatal(err)
	}
	found, members, _ := planPlaceholders(t, s, run.ID)
	for key, node := range found {
		if !slices.Contains(members, stringValue(node["id"])) {
			t.Fatalf("placeholder %s dropped from container members", key)
		}
	}
}

func TestProductionPlanSectionsAreCreatedOnlyAfterExplicitTrigger(t *testing.T) {
	s, _, run := planFixture(t, 5)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	storyDocument := orderedPlanDocument("story", "")
	storyDocument["episodeArchitecture"] = productionEpisodeArchitectureFixture(3)
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": storyDocument, "factIds": []string{}}, false)

	before, _, _ := planPlaceholders(t, s, run.ID)
	if len(before) != 1 || before["story"] == nil {
		t.Fatalf("submitting the story must not create other plan nodes: %v", before)
	}
	execution, _ := s.repo.CloudAgent("user", run.ID)
	if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		current.Status = "completed"
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}

	s.disablePiRuntime = true
	if err := s.ControlProductionAgent("user", run.ID, "generate_plans"); err != nil {
		t.Fatal(err)
	}
	found, members, _ := planPlaceholders(t, s, run.ID)
	for _, key := range []string{"story", "inventory", "visual", "direction", "generation"} {
		node := found[key]
		if node == nil {
			t.Fatalf("placeholder %s missing after the explicit trigger: %v", key, found)
		}
		if !slices.Contains(members, stringValue(node["id"])) {
			t.Fatalf("placeholder %s is not a container member", key)
		}
	}
}