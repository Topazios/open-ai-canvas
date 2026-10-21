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
	if receipt["field"] != "parameters.scenes[0]" || receipt["reason"] != "invalid_tool_arguments" || receipt["retry"].(map[string]any)["status"] != "retrying" {
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
