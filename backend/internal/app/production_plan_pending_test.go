package app

import "testing"

func planNodeForPending(status, content string, workflow map[string]any) map[string]any {
	return map[string]any{"metadata": map[string]any{"status": status, "content": content, "shortDrama": workflow}}
}

func TestProductionPlanPendingToleratesDroppedMarker(t *testing.T) {
	withMarker := planNodeForPending("processing", "等待生成", map[string]any{"planSection": "story", "planGeneration": map[string]any{"runId": "run-1"}})
	droppedMarker := planNodeForPending("processing", "等待生成", map[string]any{"planSection": "story"})
	droppedAsset := planNodeForPending("processing", " 等待生成 ", map[string]any{"planAsset": map[string]any{"key": "CHR-001"}})
	filled := planNodeForPending("success", "正文", map[string]any{"planSection": "story"})
	placeholderTextOnly := planNodeForPending("processing", "等待生成", map[string]any{"step": "story.body"})

	for name, node := range map[string]map[string]any{"marker": withMarker, "dropped": droppedMarker, "asset": droppedAsset} {
		if !productionPlanPending(node) {
			t.Errorf("%s should be pending", name)
		}
	}
	if productionPlanPending(filled) || productionPlanPending(placeholderTextOnly) {
		t.Error("a saved document or an unrelated node must not be pending")
	}
	if !productionPlanPlaceholderOwned(withMarker, "run-1") || productionPlanPlaceholderOwned(withMarker, "run-2") {
		t.Error("a marker must bind the placeholder to its own run")
	}
	if !productionPlanPlaceholderOwned(droppedMarker, "run-2") || productionPlanPlaceholderOwned(filled, "run-1") {
		t.Error("a dropped marker is adopted by the current run, a filled document never is")
	}
}

func TestProductionPlanPlaceholderAdoptedWhenMarkerDropped(t *testing.T) {
	s, _, run := planFixture(t, 5)
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	_, m, doc, err := productionLoad(s.repo, execution, &state)
	if err != nil {
		t.Fatal(err)
	}
	count := func() int {
		total := 0
		for _, node := range creationMaps(doc["nodes"]) {
			if productionWorkflow(node)["planSection"] == "story" {
				total++
			}
		}
		return total
	}
	before := count()
	for _, node := range creationMaps(doc["nodes"]) {
		if workflow := productionWorkflow(node); workflow["planSection"] == "story" {
			delete(workflow, "planGeneration")
		}
	}
	if productionPlanDocumentPlaceholders(m, doc, run.ID, state.Request.Production.TargetNodeID, map[string]bool{}) || count() != before {
		t.Fatalf("a placeholder that lost its marker was duplicated: %d -> %d", before, count())
	}
}
