package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestStoryboardCameraSummaryFromCompleteDetails(t *testing.T) {
	s, _, id := sceneStoryboardFixture(t, false)
	state := enqueueSceneWorks(t, s, id)
	work := state.ProductionParallel["S1"]
	task, call := sceneResult(t, s, id, work, 0)
	var args map[string]any
	if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
		t.Fatal(err)
	}
	shots := creationMaps(args["shots"])
	delete(shots[0], "camera")
	shots[0]["shotSize"], shots[0]["cameraAngle"] = "中景", "柜台内侧平视，不越轴"
	shots[0]["movement"], shots[0]["blocking"] = "固定机位", "两人分立柜台左右"
	raw, _ := json.Marshal(args)
	call.Function.Arguments = string(raw)
	task.ResultJSON = productionRuntimeResult(t, call)
	if err := s.settleProductionParallel("user", id, work, task); err != nil {
		t.Fatal(err)
	}
	m, _, _ := storyboardState(t, s, id)
	shot := storyboardSceneByID(m, "S1").Shots[0]
	if shot.Camera != "中景；柜台内侧平视，不越轴；固定机位；两人分立柜台左右" {
		t.Fatal(shot.Camera)
	}
	if shot.Visual == "" || shot.Continuity == "" {
		t.Fatal("lost content")
	}
}

func TestStoryboardMissingCameraIsActionableWithoutInventingDetails(t *testing.T) {
	shot := storyboardShot("S1", 1, 1, 1, 10)
	shot.Camera, shot.ShotSize = "", "中景"
	storyboardComposeCamera(&shot)
	if shot.Camera != "" {
		t.Fatal("invented camera details")
	}
	err := validateStoryboardShot(productionScene{ID: "S1", Start: 1, End: 1}, shot, 1)
	if err == nil || !strings.Contains(err.Error(), "S1-001") || !strings.Contains(err.Error(), "camera") {
		t.Fatal(err)
	}
	shot.Camera = "保留人工机位"
	storyboardComposeCamera(&shot)
	if shot.Camera != "保留人工机位" {
		t.Fatal("replaced authored camera")
	}
}
