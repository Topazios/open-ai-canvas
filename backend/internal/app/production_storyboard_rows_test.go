package app

import (
	"strings"
	"testing"
)

func TestStoryboardCompositionSurvivesIncrementalSubmission(t *testing.T) {
	s, _, run := storyboardFixture(t)
	storyboardFixturePlan(t, s, run.ID)
	shot := storyboardShot("S1", 1, 1, 1, 10)
	shot.Visual = "【起幅状态】甲站门外，双手垂下。【动作过程】甲进门放下包。【落幅状态】甲站桌边，包在桌上。"
	shot.Camera = "【构图基准】甲画左，门在后景右侧，中景腰部以上，人物约占画幅六成。【起幅机位】门内平视。【落幅机位】门内平视。【机位运动】固定机位。"
	shot.Continuity = "下一镜连续衔接，甲与包保持原位。"
	productionCall(t, s, run.ID, "production_storyboard_submit", storyboardSubmitArgs(t, s, run.ID, "S1", 0, []productionShot{shot}, true), false)
	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := creationDocument(canvas.PayloadJSON)
	meta := productionNode(doc, "target")["metadata"].(map[string]any)
	row := creationMaps(meta["storyboard"].(map[string]any)["rows"])[0]
	if row["plotDescription"] != shot.Visual || row["camera"] != shot.Camera || row["continuityOut"] != shot.Continuity {
		t.Fatal("endpoint or composition fields lost during persistence")
	}
	for _, fragment := range []string{shot.Visual, shot.Camera, shot.Continuity} {
		if !strings.Contains(stringValue(row["videoMotionPrompt"]), fragment) {
			t.Fatal("video prompt lost spatial contract")
		}
	}
}

func TestStoryboardRowsPersistEditsAndReceiptsAcrossCheckpoints(t *testing.T) {
	shot := storyboardShot("S1", 1, 1, 1, 5)
	shot.Visual = "CHR-0001 推门进入 SCN-0001"
	shot.AssetIDs = []string{"CHR-0001", "SCN-0001"}
	m := productionManifest{Storyboard: &productionStoryboard{Scenes: []productionScene{{ID: "S1", Complete: true, Shots: []productionShot{shot}}}}}
	meta := map[string]any{}
	target := map[string]any{"id": "table", "type": "text", "width": float64(400), "height": float64(280), "metadata": meta}
	materializeStoryboardRows(target, m, map[string]any{})
	table := meta["storyboard"].(map[string]any)
	rows := creationMaps(table["rows"])
	if target["type"] != "script" || len(rows) != 1 || rows[0]["id"] != "table:S1-001" || rows[0]["shotCode"] != "S1-001" || stringValue(rows[0]["videoMotionPrompt"]) == "" {
		t.Fatalf("not a usable episode table: %+v", target)
	}
	rows[0]["videoNodeId"] = "generated-video"
	rows[0]["videoMotionPrompt"] = "人工调整后的镜头提示词"
	table["rows"] = []any{rows[0]}
	m.Storyboard.Scenes = append(m.Storyboard.Scenes, productionScene{ID: "S2", Complete: true, Shots: []productionShot{storyboardShot("S2", 1, 2, 2, 5)}})
	materializeStoryboardRows(target, m, map[string]any{})
	rows = creationMaps(table["rows"])
	if len(rows) != 2 || rows[0]["videoNodeId"] != "generated-video" || rows[0]["videoMotionPrompt"] != "人工调整后的镜头提示词" || rows[1]["id"] != "table:S2-001" {
		t.Fatalf("checkpoint overwrote media or edits: %+v", rows)
	}
	m.Storyboard.Scenes[0].Shots[0].Visual = "CHR-0001 退出 SCN-0001"
	materializeStoryboardRows(target, m, map[string]any{})
	rows = creationMaps(table["rows"])
	if rows[0]["videoNodeId"] != nil || rows[0]["videoMotionPrompt"] == "人工调整后的镜头提示词" {
		t.Fatal("regenerated shot incorrectly reused stale media")
	}
}

func TestProductionStoryboardCheckpointProducesEpisodeTable(t *testing.T) {
	s, _, run := storyboardFixture(t)
	storyboardFixturePlan(t, s, run.ID)
	shot := storyboardShot("S1", 1, 1, 1, 10)
	productionCall(t, s, run.ID, "production_storyboard_submit", storyboardSubmitArgs(t, s, run.ID, "S1", 0, []productionShot{shot}, true), false)
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	target := productionNode(doc, "target")
	meta := target["metadata"].(map[string]any)
	table := meta["storyboard"].(map[string]any)
	rows := creationMaps(table["rows"])
	if target["type"] != "script" || len(rows) != 1 || rows[0]["shotCode"] != "S1-001" || meta["status"] != "loading" {
		t.Fatalf("incremental table unavailable: %+v", target)
	}
	// A syntactically valid but invented code must not reach video generation.
	invalid := storyboardShot("S2", 1, 2, 3, 20)
	invalid.AssetIDs = []string{"CHR-9999"}
	productionCall(t, s, run.ID, "production_storyboard_submit", storyboardSubmitArgs(t, s, run.ID, "S2", 0, []productionShot{invalid}, true), true)
}

func TestStoryboardRowsLabelOnlyUnavoidableTailAndPreserveMedia(t *testing.T) {
	m := productionManifest{Storyboard: &productionStoryboard{ShotDuration: 10, ShotTolerance: 3, Scenes: []productionScene{{
		ID: "S1", Duration: 13.5, Complete: true,
		Shots: []productionShot{storyboardShot("S1", 1, 1, 1, 10), storyboardShot("S1", 2, 1, 1, 3.5)},
	}}}}
	meta := map[string]any{}
	target := map[string]any{"id": "table", "metadata": meta}
	materializeStoryboardRows(target, m, map[string]any{})
	table := meta["storyboard"].(map[string]any)
	rows := creationMaps(table["rows"])
	if rows[0]["timingException"] != nil || rows[1]["timingException"] != "scene_tail" || rows[1]["sceneId"] != "S1" || rows[1]["sceneDurationSeconds"] != 13.5 {
		t.Fatalf("true tail not labeled: %+v", rows)
	}
	rows[1]["videoNodeId"] = "existing-video"
	rows[1]["frames"] = []any{map[string]any{"imageNodeId": "existing-image"}}
	rows[1]["videoMotionPrompt"] = "人工保留的提示词"
	table["rows"] = []any{rows[0], rows[1]}
	// A budget-only edit must remove a stale exception without replacing media.
	m.Storyboard.Scenes[0].Duration = 13
	materializeStoryboardRows(target, m, map[string]any{})
	rows = creationMaps(table["rows"])
	if rows[1]["timingException"] != nil || rows[1]["videoNodeId"] != "existing-video" || rows[1]["frames"] == nil || rows[1]["videoMotionPrompt"] != "人工保留的提示词" {
		t.Fatalf("budget change lost media or kept a false exception: %+v", rows[1])
	}
	for _, test := range []struct {
		duration float64
		shots    []productionShot
	}{
		{12, []productionShot{storyboardShot("S1", 1, 1, 1, 7), storyboardShot("S1", 2, 1, 1, 5)}},
		{13, []productionShot{storyboardShot("S1", 1, 1, 1, 7), storyboardShot("S1", 2, 1, 1, 6)}},
		{5, []productionShot{storyboardShot("S1", 1, 1, 1, 5)}},
	} {
		m.Storyboard.Scenes[0].Duration, m.Storyboard.Scenes[0].Shots = test.duration, test.shots
		materializeStoryboardRows(target, m, map[string]any{})
		for _, row := range creationMaps(table["rows"]) {
			if row["timingException"] != nil {
				t.Fatalf("avoidable short tail falsely labeled: %+v", row)
			}
		}
	}
}
