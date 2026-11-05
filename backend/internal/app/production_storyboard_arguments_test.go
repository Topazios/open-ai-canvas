package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/repository"
)

func TestStoryboardArgumentFieldPaths(t *testing.T) {
	for _, test := range []struct{ name, tool, raw, path string }{
		{"delimiter", "production_storyboard_plan", `{"scenes":[{"id":"S1","},{" : []}]}`, "parameters.scenes[0]"},
		{"checkpoint", "production_storyboard_plan", `{"scenes":[{"id":"S1","complete":true}]}`, "parameters.scenes[0]"},
		{"cross_tool", "production_storyboard_plan", `{"scenes":[],"review":"ignored"}`, "parameters"},
		{"layout", "production_storyboard_layout", `{"layouts":[{"sceneId":"S1","shots":[{"id":"S1-001","secret-value":123}]}]}`, "parameters.layouts[0].shots[0]"},
		{"expand", "production_storyboard_expand", `{"sceneId":"S1","shot":{"id":"S1-001","private-token":123}}`, "parameters.shot"},
		{"submit", "production_storyboard_submit", `{"shots":[{"id":"S1-001","private-token":123}]}`, "parameters.shots[0]"},
	} {
		t.Run(test.name, func(t *testing.T) {
			call := cloudAgentCall{}
			call.Function.Name, call.Function.Arguments = test.tool, test.raw
			err := validateStoryboardArgumentFields(call)
			var fieldErr *cloudAgentFieldArgumentError
			if !errors.As(err, &fieldErr) || fieldErr.Field != test.path || fieldErr.Issue != "unexpected_field" {
				t.Fatalf("missing safe path: %v", err)
			}
			if strings.Contains(err.Error(), "secret-value") || strings.Contains(err.Error(), "private-token") {
				t.Fatal("echoed an untrusted field")
			}
		})
	}
}

func TestStoryboardMalformedPlanCorrectsWithoutPartialWrite(t *testing.T) {
	s, db, run := storyboardFixture(t)
	productionCall(t, s, run.ID, "production_storyboard_brief", map[string]any{"brief": "保留剧情与动作连续性", "sourceIds": []string{}}, false)
	scenes := []productionScene{{ID: "S1", Title: "开场", Start: 1, End: 1, Goal: "建立回归", Duration: 10, Entry: "门外", Exit: "馆内"}}
	args := storyboardPlanArgs(scenes)
	args["scenes"].([]map[string]any)[0]["},{"] = []any{}
	receipt := productionCall(t, s, run.ID, "production_storyboard_plan", args, true)
	if receipt["field"] != "parameters.scenes[0]" || receipt["reason"] != "invalid_tool_arguments" || receipt["retryable"] != true || receipt["requiredAction"] != "fix_arguments" {
		t.Fatal(receipt)
	}
	job, _ := s.repo.ProductionAgentJob("user", run.ID)
	var manifest productionManifest
	_ = json.Unmarshal([]byte(job.ManifestJSON), &manifest)
	if len(manifest.Storyboard.Scenes) != 0 {
		t.Fatal("partial plan was saved")
	}
	// Merely deleting the malformed key must not bypass complete source coverage.
	productionCall(t, s, run.ID, "production_storyboard_plan", storyboardPlanArgs(scenes), true)
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	storyboardFixturePlan(t, restarted, run.ID)
	job, _ = restarted.repo.ProductionAgentJob("user", run.ID)
	_ = json.Unmarshal([]byte(job.ManifestJSON), &manifest)
	if len(manifest.Storyboard.Scenes) != 2 {
		t.Fatal("corrected plan was not saved")
	}
	_, state := productionRuntimeState(t, restarted, run.ID)
	if _, exists := state.ToolRepairs["production_storyboard_plan"]; exists {
		t.Fatal("successful correction left retry open")
	}
}

func TestStoryboardLayoutCoverageErrorCanBeCorrectedWithoutPartialWrite(t *testing.T) {
	s, _, run := storyboardFixtureWithTiming(t, 10, 3)
	storyboardFixturePlan(t, s, run.ID)
	raw, state := productionRuntimeState(t, s, run.ID)
	if err := s.upgradeStoryboardLayout(raw, &state); err != nil {
		t.Fatal(err)
	}
	layouts := storyboardLayouts()
	layouts[1].Shots[1].Start, layouts[1].Shots[1].End = 2, 2
	receipt := productionCall(t, s, run.ID, "production_storyboard_layout", map[string]any{"layouts": layouts}, true)
	if receipt["field"] != "parameters.layouts" || receipt["reason"] != "invalid_tool_arguments" || receipt["retryable"] != true || receipt["requiredAction"] != "fix_arguments" {
		t.Fatal(receipt)
	}
	job, err := s.repo.ProductionAgentJob("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var manifest productionManifest
	if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
		t.Fatal(err)
	}
	for _, scene := range manifest.Storyboard.Scenes {
		if len(scene.Layout) != 0 {
			t.Fatal("invalid layout partially persisted")
		}
	}
	productionCall(t, s, run.ID, "production_storyboard_layout", map[string]any{"layouts": storyboardLayouts()}, false)
	job, _ = s.repo.ProductionAgentJob("user", run.ID)
	if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
		t.Fatal(err)
	}
	if !storyboardHasLayout(manifest.Storyboard) {
		t.Fatal("corrected layout was not persisted")
	}
}

func TestStoryboardInvalidRebudgetCanBeCorrectedWithoutPartialWrite(t *testing.T) {
	s, _, run := storyboardFixtureWithTiming(t, 10, 3)
	storyboardFixturePlan(t, s, run.ID)
	job, err := s.repo.ProductionAgentJob("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var manifest productionManifest
	if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Storyboard.Version = storyboardEpisodeVersion
	manifest.Storyboard.MinDuration, manifest.Storyboard.MaxDuration = 180, 300
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, string(encoded)); err != nil {
		t.Fatal(err)
	}

	invalid := []productionScene{
		{ID: "S1", Title: "入场", Start: 1, End: 1, Goal: "建立回归", Duration: 150, Entry: "门外", Exit: "馆内"},
		{ID: "S2", Title: "回归", Start: 2, End: 3, Goal: "确认情绪", Duration: 175, Entry: "馆内", Exit: "放下相机"},
	}
	receipt := productionCall(t, s, run.ID, "production_storyboard_plan", storyboardPlanArgs(invalid), true)
	if receipt["field"] != "parameters.scenes" || receipt["reason"] != "invalid_tool_arguments" || receipt["retryable"] != true || receipt["requiredAction"] != "fix_arguments" {
		t.Fatal(receipt)
	}
	job, _ = s.repo.ProductionAgentJob("user", run.ID)
	if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Storyboard.Scenes[0].Duration != 10 || manifest.Storyboard.Scenes[1].Duration != 20 {
		t.Fatal("invalid rebudget partially changed the saved plan")
	}
	valid := []productionScene{
		{ID: "S1", Title: "入场", Start: 1, End: 1, Goal: "建立回归", Duration: 140, Entry: "门外", Exit: "馆内"},
		{ID: "S2", Title: "回归", Start: 2, End: 3, Goal: "确认情绪", Duration: 140, Entry: "馆内", Exit: "放下相机"},
	}
	productionCall(t, s, run.ID, "production_storyboard_plan", storyboardPlanArgs(valid), false)
	job, _ = s.repo.ProductionAgentJob("user", run.ID)
	if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Storyboard.Scenes[0].Duration != 140 || manifest.Storyboard.Scenes[1].Duration != 140 {
		t.Fatal("corrected rebudget was not persisted")
	}
}

func TestStoryboardWholeEpisodeRebudgetPreservesCompletedShots(t *testing.T) {
	s, _, run := storyboardFixture(t)
	storyboardFixturePlan(t, s, run.ID)
	job, err := s.repo.ProductionAgentJob("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var manifest productionManifest
	if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Storyboard.Version = storyboardEpisodeVersion
	manifest.Storyboard.MinDuration, manifest.Storyboard.MaxDuration = 40, 60
	manifest.Storyboard.Scenes[0].Duration = 25
	manifest.Storyboard.Scenes[0].Shots = []productionShot{storyboardShot("S1", 1, 1, 1, 25)}
	manifest.Storyboard.Scenes[0].Complete = true
	manifest.Storyboard.Scenes[1].PreviousShots = []productionShot{storyboardShot("S2", 1, 2, 2, 25)}
	manifest.Storyboard.Scenes[1].Complete = false
	manifest.Storyboard.Review = "S02增加必要时长后，全集预算需同步压缩S01。"
	manifest.Storyboard.ReviewHash = ""
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, string(encoded)); err != nil {
		t.Fatal(err)
	}

	plan := []productionScene{
		{ID: "S1", Title: "入场", Start: 1, End: 1, Goal: "建立回归", Duration: 20, Entry: "门外", Exit: "馆内"},
		{ID: "S2", Title: "回归", Start: 2, End: 3, Goal: "确认情绪", Duration: 30, Entry: "馆内", Exit: "放下相机"},
	}
	productionCall(t, s, run.ID, "production_storyboard_plan", storyboardPlanArgs(plan), false)
	job, _ = s.repo.ProductionAgentJob("user", run.ID)
	manifest = productionManifest{}
	if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
		t.Fatal(err)
	}
	first, second := manifest.Storyboard.Scenes[0], manifest.Storyboard.Scenes[1]
	if first.Duration != 20 || first.Complete || len(first.Shots) != 0 || len(first.PreviousShots) != 1 {
		t.Fatalf("changed completed scene was not safely reopened: %+v", first)
	}
	if second.Duration != 30 || len(second.PreviousShots) != 1 || second.Complete {
		t.Fatalf("incomplete scene draft was not preserved across rebudget: %+v", second)
	}
	layouts := storyboardLayouts()
	layouts[0].Shots[0].Duration = 20
	layouts[1].Shots[0].Duration, layouts[1].Shots[1].Duration = 15, 15
	productionCall(t, s, run.ID, "production_storyboard_layout", map[string]any{"layouts": layouts}, false)
	productionCall(t, s, run.ID, "production_storyboard_submit", storyboardSubmitArgs(t, s, run.ID, "S1", 0, []productionShot{storyboardShot("S1", 1, 1, 1, 20)}, true), false)
	productionCall(t, s, run.ID, "production_storyboard_submit", storyboardSubmitArgs(t, s, run.ID, "S2", 0, []productionShot{storyboardShot("S2", 1, 2, 2, 15), storyboardShot("S2", 2, 3, 3, 15)}, true), false)
	ctx := productionCall(t, s, run.ID, "production_storyboard_context", map[string]any{}, false)
	productionCall(t, s, run.ID, "production_storyboard_review", map[string]any{"hash": ctx["hash"], "review": "整集重分配后已核对完整覆盖与时长。", "repairSceneIds": []string{}}, false)
	completed, _, _ := storyboardState(t, s, run.ID)
	if storyboardCoverage(completed)["valid"] != true {
		t.Fatal("rebudgeted episode could not finish its review")
	}
}
