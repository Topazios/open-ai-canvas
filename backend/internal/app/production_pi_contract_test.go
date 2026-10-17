package app

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestProductionPiContractEnvelopePreservesScopedModelSchema(t *testing.T) {
	s, _, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	execution, state := productionRuntimeState(t, s, run.ID)
	_, manifest, _, err := productionLoad(s.repo, execution, &state)
	if err != nil {
		t.Fatal(err)
	}
	next, err := productionPlanRunNextAction(s.repo, "user", run.ID, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if next["key"] != "story" {
		t.Fatalf("fixture must be at the story checkpoint: %#v", next)
	}
	state.Canonical.Tools = productionRuntimeTools(manifest, map[string]any{"nextAction": next})
	productionRuntimeAssertTools(t, state.Canonical.Tools, productionRuntimePlanNames)
	before, err := json.Marshal(state.Canonical.Tools)
	if err != nil {
		t.Fatal(err)
	}
	request, err := s.buildEnhancedPiRequest(context.Background(), EnhancedPiRequestParams{
		UserID: "user", RunID: run.ID, CanvasID: "agent-canvas", ModelID: "text-test",
		RuntimeState: &state, Canonical: &state.Canonical, SessionDir: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Check the serialized subprocess envelope, not just the in-memory map.
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Tools []struct {
			Name       string         `json:"name"`
			Parameters map[string]any `json:"parameters"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	expected := map[string]bool{}
	for _, tool := range piToolDefinitions(productionAgentTools()) {
		expected[stringValue(tool["name"])] = true
	}
	if len(wire.Tools) != len(expected) {
		t.Fatalf("static registry lost tools: got %d, want %d", len(wire.Tools), len(expected))
	}
	for _, tool := range wire.Tools {
		if !expected[tool.Name] {
			t.Fatalf("unexpected or duplicate static tool %q", tool.Name)
		}
		delete(expected, tool.Name)
		if !reflect.DeepEqual(tool.Parameters, map[string]any{"type": "object", "additionalProperties": true}) {
			t.Fatalf("%s retains a stale static schema: %#v", tool.Name, tool.Parameters)
		}
	}
	after, err := json.Marshal(state.Canonical.Tools)
	if err != nil || string(before) != string(after) {
		t.Fatalf("building Pi registry mutated model schemas: %v", err)
	}
	found := false
	for _, tool := range state.Canonical.Tools {
		fn := tool["function"].(map[string]any)
		if fn["name"] != "production_submit" {
			continue
		}
		found = true
		parameters := fn["parameters"].(map[string]any)
		properties := parameters["properties"].(map[string]any)
		key := properties["key"].(map[string]any)
		if !reflect.DeepEqual(productionIDs(key["enum"]), []string{"story"}) || parameters["additionalProperties"] != false {
			t.Fatalf("model submit constraints were relaxed: %#v", parameters)
		}
		document := properties["document"].(map[string]any)
		want := strings.Fields("facts premise motivation world worldRules conflict plot arcs characterArcs relationships ending foreshadowing continuity uncertainties")
		if !reflect.DeepEqual(productionIDs(document["required"]), want) || document["additionalProperties"] != false {
			t.Fatalf("model document lost required fields: %#v", document)
		}
		fields := document["properties"].(map[string]any)
		if fields["plot"].(map[string]any)["maxLength"] != nil {
			t.Fatal("model schema imposes a stale per-field length limit")
		}
	}
	if !found {
		t.Fatal("model schema omitted production_submit")
	}
}

func TestProductionPiContractGoSaveLongStoryAndRejectMissingFields(t *testing.T) {
	s, _, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	longPlot := strings.Repeat("Lin follows the photographs and discovers the family secret. ", 80)
	for _, missing := range []string{"plot", "name"} {
		t.Run("missing_"+missing, func(t *testing.T) {
			document := orderedPlanDocument("story", "")
			document["plot"] = longPlot
			args := map[string]any{"key": "story", "name": "Story", "document": document, "factIds": []string{}}
			if missing == "plot" {
				delete(document, missing)
			} else {
				delete(args, missing)
			}
			result := productionCall(t, s, run.ID, "production_submit", args, true)
			if result["requiredAction"] != "fix_arguments" || !strings.Contains(stringValue(result["error"]), missing) {
				t.Fatalf("missing field was not rejected by Go validation: %#v", result)
			}
			if rows := mustPlanArtifacts(t, s, run.ID); len(rows) != 0 {
				t.Fatalf("invalid document persisted %d artifacts", len(rows))
			}
		})
	}
	document := orderedPlanDocument("story", "")
	document["plot"] = longPlot
	want, err := productionRenderPlanDocument("story", "", document)
	if err != nil {
		t.Fatal(err)
	}
	receipt := productionCall(t, s, run.ID, "production_submit", map[string]any{
		"key": "story", "name": "Story", "document": document, "factIds": []string{},
	}, false)
	rows := mustPlanArtifacts(t, s, run.ID)
	if len(rows) != 1 || rows[0].Key != "story" || rows[0].NodeID != receipt["nodeId"] {
		t.Fatalf("long story was not saved exactly once: %#v", rows)
	}
	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	canvasDoc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	node := productionNode(canvasDoc, rows[0].NodeID)
	if got := node["metadata"].(map[string]any)["content"]; got != want {
		t.Fatal("saved story was truncated or changed")
	}
}
