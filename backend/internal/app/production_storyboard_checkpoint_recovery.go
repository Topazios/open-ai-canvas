package app

import "encoding/json"

// A stale browser can restore an earlier subset of generated shots. Only an
// explicit retry may restore it, and only when the text is exactly reproducible
// from the durable shots and every input/binding still matches the saved hash.
func productionStoryboardPartialCheckpointCanRecover(target map[string]any, runID string, m productionManifest) bool {
	if target == nil || m.Storyboard == nil || m.Storyboard.Version != storyboardSceneVersion || stringValue(target["parentId"]) != m.FrameID {
		return false
	}
	workflow := productionWorkflow(target)
	agent, _ := workflow["productionAgent"].(map[string]any)
	if agent["runId"] != runID {
		return false
	}
	raw, _ := json.Marshal(target)
	var copy map[string]any
	if json.Unmarshal(raw, &copy) != nil {
		return false
	}
	meta, _ := copy["metadata"].(map[string]any)
	oldContent, _ := meta["content"].(string)
	meta["content"] = renderStoryboard(m)
	if productionTargetHash(copy) != m.TargetHash {
		return false
	}
	board, _ := meta["storyboard"].(map[string]any)
	ready := map[string]bool{}
	for _, row := range creationMaps(board["rows"]) {
		if row["detailStatus"] == "ready" {
			ready[stringValue(row["shotCode"])] = true
		}
	}
	raw, _ = json.Marshal(m.Storyboard)
	var partial productionStoryboard
	if json.Unmarshal(raw, &partial) != nil {
		return false
	}
	partial.Review = ""
	for i := range partial.Scenes {
		scene := &partial.Scenes[i]
		if len(scene.PreviousShots) > 0 {
			return false
		}
		var shots []productionShot
		for _, shot := range scene.Shots {
			if ready[shot.ID] {
				shots = append(shots, shot)
				delete(ready, shot.ID)
			}
		}
		scene.Shots = shots
	}
	if len(ready) != 0 {
		return false
	}
	m.Storyboard = &partial
	return oldContent != "" && oldContent == renderStoryboard(m)
}
