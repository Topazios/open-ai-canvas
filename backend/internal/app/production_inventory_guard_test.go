package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func submitStoryForInventoryTest(t *testing.T, s *Service, runID string) map[string]any {
	t.Helper()
	storyDocument := orderedPlanDocument("story", "")
	storyDocument["episodeArchitecture"] = productionEpisodeArchitectureFixture(3)
	return productionCall(t, s, runID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": storyDocument, "factIds": []string{}}, false)
}

func TestProductionDropAdvisoryArgument(t *testing.T) {
	if got := productionDropAdvisoryArgument("not json", "independent"); got != "not json" {
		t.Fatalf("non-object input changed: %q", got)
	}
	if got := productionDropAdvisoryArgument(`[1,2]`, "independent"); got != `[1,2]` {
		t.Fatalf("array input changed: %q", got)
	}
	raw := `{"complete":true}`
	if got := productionDropAdvisoryArgument(raw, "independent"); got != raw {
		t.Fatalf("missing key changed input: %q", got)
	}
	got := productionDropAdvisoryArgument(`{"complete":true,"independent":true}`, "independent")
	var fields map[string]any
	if err := json.Unmarshal([]byte(got), &fields); err != nil {
		t.Fatal(err)
	}
	if _, ok := fields["independent"]; ok || fields["complete"] != true {
		t.Fatalf("key not stripped cleanly: %q", got)
	}
}

func TestProductionInventoryGuardReportsDistinctReasons(t *testing.T) {
	s, _, run := planFixture(t, 5)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := submitStoryForInventoryTest(t, s, run.ID)
	m, _, _ := orderedPlanState(t, s, run.ID)
	if m.Plan == nil || m.Plan.Version < 5 || m.Plan.InventoryReviewVersion == 0 {
		t.Fatalf("fixture does not exercise the v5 review guard: %+v", m.Plan)
	}
	assets := []productionPlanAsset{{Key: "hero", Kind: "character", Name: "主角", Priority: 1, Episodes: []int{1}, Purpose: "承载行动", PlannedRange: "全剧"}}
	absent := map[string]string{"environment": "无独立场景", "prop": "无剧情道具", "sound": "无独立复用声音"}

	incomplete := fmt.Sprint(productionCall(t, s, run.ID, "production_plan_inventory", map[string]any{"storyHash": story["hash"], "assets": assets, "absent": absent, "complete": false}, true))
	missing := fmt.Sprint(productionCall(t, s, run.ID, "production_plan_inventory", map[string]any{"storyHash": story["hash"], "assets": assets, "absent": absent, "complete": true}, true))
	unknown := fmt.Sprint(productionCall(t, s, run.ID, "production_plan_inventory", map[string]any{"storyHash": story["hash"], "assets": assets, "absent": absent, "complete": true, "unexpected": 1}, true))

	if !strings.Contains(incomplete, "complete=true") {
		t.Fatalf("incomplete message lost its reason: %s", incomplete)
	}
	if !strings.Contains(missing, "inventoryReview") {
		t.Fatalf("missing-review message lost its reason: %s", missing)
	}
	if !strings.Contains(missing, "episodeArchitecture/EP-001") || !strings.Contains(missing, "\"requirements\"") {
		t.Fatalf("missing-review message does not list the sections to review or the entry shape: %s", missing)
	}
	if strings.Contains(missing, "complete=true") || strings.Contains(incomplete, "inventoryReview") {
		t.Fatalf("messages are not distinct:\n%s\n%s", incomplete, missing)
	}
	if unknown == missing || unknown == incomplete {
		t.Fatalf("unknown-field error reuses another message: %s", unknown)
	}
}

func TestProductionInventoryAcceptsEchoedIndependentField(t *testing.T) {
	s, _, run := planFixture(t, 5)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := submitStoryForInventoryTest(t, s, run.ID)
	assets := []productionPlanAsset{{Key: "hero", Kind: "character", Name: "主角", Priority: 1, Episodes: []int{1}, Purpose: "承载行动", PlannedRange: "全剧"}}
	productionCall(t, s, run.ID, "production_plan_inventory", map[string]any{
		"storyHash": story["hash"], "assets": assets, "complete": true, "independent": true,
		"absent":          map[string]string{"environment": "无独立场景", "prop": "无剧情道具", "sound": "无独立复用声音"},
		"inventoryReview": productionInventoryReviewForTest(t, s, run.ID, assets),
	}, false)
	m, _, _ := orderedPlanState(t, s, run.ID)
	if !m.Plan.Complete || len(m.Plan.Assets) != 1 {
		t.Fatalf("inventory not saved: %+v", m.Plan)
	}
}
