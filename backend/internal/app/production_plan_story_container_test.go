package app

import (
	"slices"
	"testing"
)

func storyEdgeCount(doc map[string]any, from, to string) int {
	count := 0
	for _, edge := range creationMaps(doc["connections"]) {
		if stringValue(edge["fromNodeId"]) == from && stringValue(edge["toNodeId"]) == to {
			count++
		}
	}
	return count
}

func TestProductionPlanStoryPlaceholderLivesInContainer(t *testing.T) {
	s, _, run := planFixture(t, 5)
	startPlansForTest(t, s, run.ID)
	found, members, doc := planPlaceholders(t, s, run.ID)
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	_, m, _, err := productionLoad(s.repo, execution, &state)
	if err != nil {
		t.Fatal(err)
	}
	story := found["story"]
	if story == nil {
		t.Fatalf("missing story placeholder: %v", found)
	}
	if stringValue(story["parentId"]) != m.FrameID {
		t.Fatalf("story placeholder must sit in the container, got parent %q", stringValue(story["parentId"]))
	}
	if !slices.Contains(members, stringValue(story["id"])) {
		t.Fatal("story must be listed in the container sourceNodeIds")
	}
	inside := 0
	for _, node := range creationMaps(doc["nodes"]) {
		if productionWorkflow(node)["planSection"] != nil && stringValue(node["parentId"]) == m.FrameID {
			inside++
		}
	}
	if inside != 5 {
		t.Fatalf("container should hold 5 document nodes, got %d", inside)
	}
	if storyEdgeCount(doc, stringValue(story["id"]), m.FrameID) != 0 {
		t.Fatal("story inside the container must not be linked to it")
	}
}

func TestProductionPlanParentMatchesLegacyAndContainerStory(t *testing.T) {
	node := func(parent string) map[string]any {
		if parent == "" {
			return map[string]any{}
		}
		return map[string]any{"parentId": parent}
	}
	current := productionManifest{FrameID: "frame", Plan: &productionPlan{Version: 5}}
	for _, parent := range []string{"", "frame"} {
		if !productionPlanParentMatches(current, "story", node(parent)) {
			t.Fatalf("v5 story must accept parent %q", parent)
		}
	}
	if productionPlanParentMatches(current, "story", node("other")) {
		t.Fatal("v5 story must reject a foreign parent")
	}
	if !productionPlanParentMatches(current, "inventory", node("frame")) || productionPlanParentMatches(current, "inventory", node("")) {
		t.Fatal("other documents must stay bound to the container")
	}
	legacy := productionManifest{FrameID: "frame", Plan: &productionPlan{Version: 1}}
	if !productionPlanParentMatches(legacy, "story", node("frame")) {
		t.Fatal("legacy story keeps its container parent")
	}
	if productionPlanParentMatches(legacy, "story", node("")) {
		t.Fatal("legacy story must still require the container parent")
	}
}

func TestProductionPlanRegroupKeepsStoryInContainer(t *testing.T) {
	s, _, run := planFixture(t, 5)
	before, _, _ := planPlaceholders(t, s, run.ID)
	storyID := stringValue(before["story"]["id"])
	for i := 0; i < 2; i++ {
		if _, err := s.ensureProductionPlanGroups("user", run.ID); err != nil {
			t.Fatal(err)
		}
	}
	after, members, doc := planPlaceholders(t, s, run.ID)
	story := after["story"]
	if story == nil || stringValue(story["id"]) != storyID {
		t.Fatalf("regroup lost the story node: %v", after)
	}
	m, _, _ := orderedPlanState(t, s, run.ID)
	if stringValue(story["parentId"]) != m.FrameID {
		t.Fatalf("regroup moved the story out of the container: %q", stringValue(story["parentId"]))
	}
	if !slices.Contains(members, storyID) {
		t.Fatal("regroup dropped the story from container members")
	}
	if storyEdgeCount(doc, storyID, m.FrameID) != 0 {
		t.Fatal("regroup linked the story to its own container")
	}
}

func TestProductionPlanStorySubmitFillsNodeInContainer(t *testing.T) {
	s, _, run := planFixture(t, 5)
	before, _, _ := planPlaceholders(t, s, run.ID)
	storyID := stringValue(before["story"]["id"])
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	storyDocument := orderedPlanDocument("story", "")
	storyDocument["episodeArchitecture"] = productionEpisodeArchitectureFixture(3)
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": storyDocument, "factIds": []string{}}, false)
	after, members, doc := planPlaceholders(t, s, run.ID)
	story := after["story"]
	if story == nil || stringValue(story["id"]) != storyID {
		t.Fatal("submit must fill the placeholder in place")
	}
	m, _, _ := orderedPlanState(t, s, run.ID)
	if stringValue(story["parentId"]) != m.FrameID {
		t.Fatalf("submitted story must stay in the container, got %q", stringValue(story["parentId"]))
	}
	if !slices.Contains(members, storyID) {
		t.Fatal("story dropped from container members")
	}
	if storyEdgeCount(doc, storyID, m.FrameID) != 0 {
		t.Fatal("submit linked the story to its own container")
	}
}
