package app

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/repository"
)

func TestProductionStoryboardTimingRangeAndRealTail(t *testing.T) {
	for _, test := range []struct {
		name            string
		duration        float64
		prior           []productionShot
		shots           []productionShot
		complete, valid bool
	}{
		{"continuous action", 20, nil, []productionShot{{Duration: 10}, {Duration: 10}}, true, true},
		{"permitted variation", 20, nil, []productionShot{{Duration: 7}, {Duration: 13}}, true, true},
		{"fragmentation", 20, nil, []productionShot{{Duration: 2}}, false, false},
		{"excessive duration", 20, nil, []productionShot{{Duration: 20}}, true, false},
		{"avoidable scene tail", 12, nil, []productionShot{{Duration: 10}, {Duration: 2}}, true, false},
		{"avoidable tail after checkpoint", 12, []productionShot{{Duration: 10}}, []productionShot{{Duration: 2}}, true, false},
		{"reported 7 plus 5", 12, nil, []productionShot{{Duration: 7}, {Duration: 5}}, true, false},
		{"reported 7 plus 6", 13, nil, []productionShot{{Duration: 7}, {Duration: 6}}, true, false},
		{"single twelve seconds", 12, nil, []productionShot{{Duration: 12}}, true, true},
		{"single thirteen seconds", 13, nil, []productionShot{{Duration: 13}}, true, true},
		{"unavoidable fractional tail", 13.5, nil, []productionShot{{Duration: 10}, {Duration: 3.5}}, true, true},
		{"unavoidable tail after checkpoint", 13.5, []productionShot{{Duration: 10}}, []productionShot{{Duration: 3.5}}, true, true},
		{"wrong fractional tail", 13.5, []productionShot{{Duration: 10}}, []productionShot{{Duration: 3}}, true, false},
		{"one short scene is not a tail", 5, nil, []productionShot{{Duration: 5}}, true, false},
		{"partial batch must leave legal remainder", 12, nil, []productionShot{{Duration: 7}}, false, false},
		{"empty close rechecks saved shots", 12, []productionShot{{Duration: 7}, {Duration: 5}}, nil, true, false},
		{"full legal empty close", 12, []productionShot{{Duration: 12}}, nil, true, true},
		{"saved invalid prefix rechecked", 20, []productionShot{{Duration: 5}}, []productionShot{{Duration: 10}}, false, false},
		{"nan", 20, nil, []productionShot{{Duration: math.NaN()}}, false, false},
		{"infinite", 20, nil, []productionShot{{Duration: math.Inf(1)}}, false, false},
		{"fake short tail with missing time", 20, []productionShot{{Duration: 10}}, []productionShot{{Duration: 2}}, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateStoryboardTiming(productionScene{Duration: test.duration, Shots: test.prior}, test.shots, test.complete, 10, 3)
			if (err == nil) != test.valid {
				t.Fatalf("valid=%v, err=%v", test.valid, err)
			}
		})
	}
	if err := validateStoryboardTiming(productionScene{Duration: 2}, []productionShot{{Duration: 2}}, true, 0, 0); err != nil {
		t.Fatal("old checkpoint unexpectedly constrained", err)
	}
}

func TestStoryboardTimingParametersAndEpisodeRanges(t *testing.T) {
	for _, test := range []struct {
		name       string
		parameters map[string]any
		min, max   float64
		target     float64
		tolerance  float64
		invalid    bool
	}{
		{"range", map[string]any{"minutesPerEpisode": "1-2", "shotDurationSeconds": "10", "shotDurationToleranceSeconds": "3"}, 60, 120, 10, 3, false},
		{"unicode range", map[string]any{"minutesPerEpisode": "1.5～2 分钟"}, 90, 120, 0, 0, false},
		{"fixed numeric", map[string]any{"minutesPerEpisode": 2.5, "shotDurationSeconds": 10}, 150, 150, 10, 3, false},
		{"fixed string", map[string]any{"minutesPerEpisode": "2.5"}, 150, 150, 0, 0, false},
		{"legacy missing", nil, 0, 0, 0, 0, false},
		{"invalid target text", map[string]any{"shotDurationSeconds": "auto"}, 0, 0, 0, 0, true},
		{"invalid target type", map[string]any{"shotDurationSeconds": true}, 0, 0, 0, 0, true},
		{"invalid zero tolerance", map[string]any{"shotDurationSeconds": 10, "shotDurationToleranceSeconds": 0}, 0, 0, 0, 0, true},
		{"invalid tolerance", map[string]any{"shotDurationSeconds": 10, "shotDurationToleranceSeconds": "6"}, 0, 0, 0, 0, true},
		{"invalid minutes", map[string]any{"minutesPerEpisode": "1-2 extra"}, 0, 0, 0, 0, true},
		{"reverse minutes", map[string]any{"minutesPerEpisode": "2-1"}, 0, 0, 0, 0, true},
		{"zero minutes", map[string]any{"minutesPerEpisode": "0"}, 0, 0, 0, 0, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := &productionStoryboard{}
			err := restoreStoryboardTiming(s, test.parameters)
			if (err != nil) != test.invalid {
				t.Fatal(err)
			}
			if !test.invalid && (s.MinDuration != test.min || s.MaxDuration != test.max || s.ShotDuration != test.target || s.ShotTolerance != test.tolerance) {
				t.Fatalf("unexpected parsed timing: %+v", s)
			}
		})
	}
	s := &productionStoryboard{ShotDuration: 10, ShotTolerance: 3}
	if restoreStoryboardTiming(s, map[string]any{"shotDurationSeconds": 12, "shotDurationToleranceSeconds": "bad"}) == nil || s.ShotDuration != 10 {
		t.Fatal("invalid parameters partially overwrote the checkpoint")
	}
}

func TestStoryboardPlanCannotUseSmallScenesToBypassTiming(t *testing.T) {
	s := &productionStoryboard{ShotDuration: 10, ShotTolerance: 3, MinDuration: 60, MaxDuration: 120}
	for _, durations := range [][]float64{{27, 12, 18, 16, 14, 13, 29}, {55, 5}, {math.Inf(1)}, {math.NaN()}} {
		scenes := []productionScene{}
		for _, duration := range durations {
			scenes = append(scenes, productionScene{ID: "scene", Duration: duration})
		}
		if validateStoryboardPlanTiming(scenes, s) == nil {
			t.Fatalf("invalid plan accepted: %v", durations)
		}
	}
	for _, total := range []float64{60, 90, 119, 120} {
		if err := validateStoryboardPlanTiming([]productionScene{{ID: "scene", Duration: total}}, s); err != nil {
			t.Fatal(err)
		}
	}
}

func storyboardReplaceManifest(t *testing.T, s *Service, runID string, edit func(*productionManifest)) productionManifest {
	t.Helper()
	job, err := s.repo.ProductionAgentJob("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	var m productionManifest
	if err := json.Unmarshal([]byte(job.ManifestJSON), &m); err != nil {
		t.Fatal(err)
	}
	edit(&m)
	encoded, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.repo.UpdateProductionAgentManifest("user", runID, string(encoded)); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestStoryboardResumeRestoresExplicitTimingAndRetainsOldResults(t *testing.T) {
	s, db, run := storyboardFixtureWithTiming(t, 10, 3)
	storyboardFixturePlan(t, s, run.ID)
	old := storyboardReplaceManifest(t, s, run.ID, func(m *productionManifest) {
		m.Storyboard.ShotDuration, m.Storyboard.ShotTolerance = 0, 0
		m.Storyboard.Scenes[0].Duration = 12
		m.Storyboard.Scenes[0].Shots = []productionShot{storyboardShot("S1", 1, 1, 1, 7), storyboardShot("S1", 2, 1, 1, 5)}
		m.Storyboard.Scenes[0].Complete = true
	})
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	context := productionCall(t, restarted, run.ID, "production_storyboard_context", map[string]any{}, false)
	if context["phase"] != "review" || context["shotTiming"].(map[string]any)["minSeconds"] != float64(7) || len(creationMaps(context["timingIssues"])) == 0 {
		t.Fatalf("resume failed to expose invalid old timing: %+v", context)
	}
	productionCall(t, restarted, run.ID, "production_storyboard_review", map[string]any{"hash": context["hash"], "review": "12秒不能拆成7+5秒，保留旧稿重新规划动作。", "repairSceneIds": []string{"S1"}}, false)
	stored := storyboardReplaceManifest(t, s, run.ID, func(m *productionManifest) {})
	if stored.Storyboard.ShotDuration != 10 || len(stored.Storyboard.Scenes[0].PreviousShots) != 2 || len(stored.Storyboard.Scenes[1].Shots) != len(old.Storyboard.Scenes[1].Shots) {
		t.Fatal("timing was not persisted or old results lost")
	}
	productionCall(t, restarted, run.ID, "production_storyboard_submit", storyboardSubmitArgs(t, restarted, run.ID, "S1", 0, []productionShot{storyboardShot("S1", 1, 1, 1, 12)}, true), false)
}

func TestStoryboardSubmissionAndReviewRecheckPersistedShots(t *testing.T) {
	s, _, run := storyboardFixtureWithTiming(t, 10, 3)
	storyboardFixturePlan(t, s, run.ID)
	storyboardReplaceManifest(t, s, run.ID, func(m *productionManifest) {
		m.Storyboard.Scenes[0].Duration = 12
		m.Storyboard.Scenes[0].Shots = []productionShot{storyboardShot("S1", 1, 1, 1, 7), storyboardShot("S1", 2, 1, 1, 5)}
	})
	productionCall(t, s, run.ID, "production_storyboard_submit", storyboardSubmitArgs(t, s, run.ID, "S1", 2, nil, true), true)
	m := storyboardReplaceManifest(t, s, run.ID, func(m *productionManifest) {
		m.Storyboard.Scenes[0].Complete = true
		m.Storyboard.Scenes[1].Shots = []productionShot{storyboardShot("S2", 1, 2, 3, 10), storyboardShot("S2", 2, 2, 3, 10)}
		m.Storyboard.Scenes[1].Complete = true
		m.Storyboard.Review = "旧版通过"
		m.Storyboard.ReviewHash = storyboardReviewHash(*m)
	})
	if storyboardCoverage(m)["valid"] == true {
		t.Fatal("old review bypassed repaired timing validation")
	}
	context := productionCall(t, s, run.ID, "production_storyboard_context", map[string]any{}, false)
	productionCall(t, s, run.ID, "production_storyboard_review", map[string]any{"hash": context["hash"], "review": "假装通过", "repairSceneIds": []string{}}, true)
}

func TestStoryboardResumeRebudgetsRangeWithoutDiscardingShots(t *testing.T) {
	s, _, run := storyboardFixtureWithTiming(t, 10, 3)
	storyboardFixturePlan(t, s, run.ID)
	storyboardReplaceManifest(t, s, run.ID, func(m *productionManifest) {
		m.Storyboard.MinDuration, m.Storyboard.MaxDuration = 60, 120
		m.Storyboard.Scenes[0].Duration = 12
		m.Storyboard.Scenes[0].Shots = []productionShot{storyboardShot("S1", 1, 1, 1, 12)}
		m.Storyboard.Scenes[0].Complete = true
		m.Storyboard.Scenes[1].Duration = 117
	})
	context := productionCall(t, s, run.ID, "production_storyboard_context", map[string]any{}, false)
	if context["phase"] != "plan" || !strings.Contains(stringValue(context["planTimingIssue"]), "129.0") {
		t.Fatal(context)
	}
	productionCall(t, s, run.ID, "production_storyboard_plan", storyboardPlanArgs([]productionScene{
		{ID: "S1", Title: "入场", Start: 1, End: 1, Goal: "建立回归", Duration: 12, Entry: "门外", Exit: "馆内"},
		{ID: "S2", Title: "回归", Start: 2, End: 3, Goal: "确认情绪", Duration: 108, Entry: "馆内", Exit: "放下相机"},
	}), false)
	m := storyboardReplaceManifest(t, s, run.ID, func(m *productionManifest) {})
	if !m.Storyboard.Scenes[0].Complete || m.Storyboard.Scenes[0].Shots[0].Duration != 12 || m.Storyboard.Scenes[1].Duration != 108 {
		t.Fatal("re-budgeting discarded unchanged results")
	}
}

func TestStoryboardRangeInitializesAndSurvivesRestart(t *testing.T) {
	s, db, run := storyboardFixtureWithTiming(t, 10, 3)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionWorkflow(productionNode(doc, "target"))["parameters"].(map[string]any)["minutesPerEpisode"] = "1-2"
	})
	// Simulate a pre-range checkpoint whose explicit parameter was saved but
	// whose old ParseFloat("1-2") silently recorded a zero duration.
	storyboardReplaceManifest(t, s, run.ID, func(m *productionManifest) {
		canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
		if err != nil {
			t.Fatal(err)
		}
		doc, err := creationDocument(canvas.PayloadJSON)
		if err != nil {
			t.Fatal(err)
		}
		m.TargetHash = productionTargetHash(productionNode(doc, "target"))
		m.Storyboard.Duration = 0
	})
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	context := productionCall(t, restarted, run.ID, "production_storyboard_context", map[string]any{}, false)
	budget := context["episodeTiming"].(map[string]any)
	if budget["minSeconds"] != float64(60) || budget["maxSeconds"] != float64(120) {
		t.Fatal(context)
	}
	scenes := []productionScene{{ID: "S1", Title: "整场", Start: 1, End: 3, Goal: "完整剧情", Duration: 129, Entry: "入", Exit: "出"}}
	productionCall(t, restarted, run.ID, "production_storyboard_plan", storyboardPlanArgs(scenes), true)
	scenes[0].Duration = 119
	productionCall(t, restarted, run.ID, "production_storyboard_plan", storyboardPlanArgs(scenes), false)
	m := storyboardReplaceManifest(t, s, run.ID, func(m *productionManifest) {})
	if m.Storyboard.MinDuration != 60 || m.Storyboard.MaxDuration != 120 || m.Storyboard.Scenes[0].Duration != 119 {
		t.Fatal("range not persisted after resume")
	}
}

func TestStoryboardPlanRebudgetKeepsValidPartialCheckpoint(t *testing.T) {
	s, _, run := storyboardFixtureWithTiming(t, 10, 3)
	storyboardFixturePlan(t, s, run.ID)
	storyboardReplaceManifest(t, s, run.ID, func(m *productionManifest) {
		m.Storyboard.MinDuration, m.Storyboard.MaxDuration = 60, 120
		m.Storyboard.Scenes[0].Duration = 20
		m.Storyboard.Scenes[0].Shots = []productionShot{storyboardShot("S1", 1, 1, 1, 10)}
		m.Storyboard.Scenes[1].Duration = 109
	})
	productionCall(t, s, run.ID, "production_storyboard_plan", storyboardPlanArgs([]productionScene{
		{ID: "S1", Title: "入场", Start: 1, End: 1, Goal: "建立回归", Duration: 20, Entry: "门外", Exit: "馆内"},
		{ID: "S2", Title: "回归", Start: 2, End: 3, Goal: "确认情绪", Duration: 100, Entry: "馆内", Exit: "放下相机"},
	}), false)
	m := storyboardReplaceManifest(t, s, run.ID, func(m *productionManifest) {})
	if len(m.Storyboard.Scenes[0].Shots) != 1 || len(m.Storyboard.Scenes[0].PreviousShots) != 0 || m.Storyboard.Scenes[0].Complete {
		t.Fatal("valid partial checkpoint unexpectedly reset")
	}
}

func TestProductionStoryboardTimingSurvivesRestartAndRejectsFragments(t *testing.T) {
	s, db, run := storyboardFixtureWithTiming(t, 10, 3)
	storyboardFixturePlan(t, s, run.ID)
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	context := productionCall(t, restarted, run.ID, "production_storyboard_context", map[string]any{}, false)
	timing, ok := context["shotTiming"].(map[string]any)
	if !ok || timing["targetSeconds"] != float64(10) || timing["minSeconds"] != float64(7) || timing["maxSeconds"] != float64(13) {
		t.Fatal(context)
	}
	args := storyboardSubmitArgs(t, restarted, run.ID, "S1", 0, []productionShot{storyboardShot("S1", 1, 1, 1, 2)}, false)
	productionCall(t, restarted, run.ID, "production_storyboard_submit", args, true)
	args = storyboardSubmitArgs(t, restarted, run.ID, "S1", 0, []productionShot{storyboardShot("S1", 1, 1, 1, 10)}, true)
	productionCall(t, restarted, run.ID, "production_storyboard_submit", args, false)
}
