package app

import (
	"encoding/json"
	"fmt"
)

// Discard only known, unowned layout slots. Never relabel a shot, repair its
// narrative, or silently change an assigned shot's source range or duration.
func storyboardScopeCall(m productionManifest, work productionParallelWork, call cloudAgentCall) (cloudAgentCall, error) {
	if work.SceneID == "" || call.Function.Name != "production_storyboard_submit" {
		return call, nil
	}
	var args map[string]any
	if err := decodeCloudAgentJSONObject(call.Function.Arguments, &args); err != nil {
		return call, cloudAgentJSONArgumentError(err)
	}
	if stringValue(args["sceneId"]) != work.SceneID || numberValue(args["offset"], -1) != float64(work.BatchOffset) {
		return call, BadAuthRequest("场次或批次不属于当前任务分配")
	}
	var selected []any
	seen := map[string]bool{}
	items, ok := args["shots"].([]any)
	if !ok {
		return call, cloudAgentFieldError("parameters.shots", "invalid_type", "shots必须是当前分配镜头的对象数组")
	}
	for _, item := range items {
		shot, ok := item.(map[string]any)
		if !ok {
			return call, cloudAgentFieldError("parameters.shots", "invalid_type", "shots中的每一项都必须是完整镜头对象")
		}
		id := stringValue(shot["id"])
		scene, plan := storyboardPlannedShot(m, id)
		if plan == nil || scene.ID != work.SceneID || seen[id] {
			return call, cloudAgentFieldError("parameters.shots", "assignment_range", "提交包含未知、重复或其他场次镜头；只允许当前场次规划中的唯一镜号")
		}
		seen[id] = true
		if !cloudAgentContainsString(work.ShotIDs, id) {
			continue
		}
		// Layout-only echoes have no writable meaning in an expansion. Drop
		// them only when they exactly match the authoritative plan.
		raw, _ := json.Marshal(plan)
		var outline map[string]any
		_ = json.Unmarshal(raw, &outline)
		for _, key := range []string{"goal", "entry", "exit", "dependsOn", "taskGroup"} {
			if value, ok := shot[key]; ok && productionStoredValueHash(value) == productionStoredValueHash(outline[key]) {
				delete(shot, key)
			}
		}
		selected = append(selected, shot)
	}
	args["shots"] = selected
	if err := storyboardSceneCallError(work, args); err != nil {
		return call, err
	}
	raw, err := json.Marshal(args)
	call.Function.Arguments = string(raw)
	return call, err
}

func storyboardScopedDraft(m productionManifest, work productionParallelWork) map[string]any {
	var args map[string]any
	if json.Unmarshal(work.StoryboardDraft, &args) != nil {
		return nil
	}
	var shots []map[string]any
	for _, shot := range creationMaps(args["shots"]) {
		if !cloudAgentContainsString(work.ShotIDs, stringValue(shot["id"])) {
			continue
		}
		_, plan := storyboardPlannedShot(m, stringValue(shot["id"]))
		if plan == nil {
			continue
		}
		// A replan can reuse IDs for a different beat. Do not feed that stale
		// draft back as an apparent template for the new source assignment.
		if numberValue(shot["start"], -1) != float64(plan.Start) || numberValue(shot["end"], -1) != float64(plan.End) || numberValue(shot["duration"], -1) != plan.Duration {
			continue
		}
		shots = append(shots, shot)
	}
	return map[string]any{"shots": shots, "instruction": "仅为本次范围内的未通过草稿，不是提交模板。元数据以plannedShots为准；不得补回被省略的镜头。"}
}

// Limit the advertised schema as well as the prompt. The commit path retains
// its own ownership, generation, source-version and content validation gates.
func storyboardScopeTools(tools []map[string]any, work productionParallelWork, m productionManifest) {
	if work.SceneID == "" {
		return
	}
	for _, tool := range tools {
		fn, _ := tool["function"].(map[string]any)
		if fn["name"] != "production_storyboard_submit" {
			continue
		}
		schema := fn["parameters"].(map[string]any)
		props := schema["properties"].(map[string]any)
		props["sceneId"] = map[string]any{"type": "string", "enum": []string{work.SceneID}}
		props["offset"] = map[string]any{"type": "integer", "enum": []int{work.BatchOffset}}
		shots := props["shots"].(map[string]any)
		shots["maxItems"] = len(work.ShotIDs)
		shots["description"] = fmt.Sprintf("只提交 %v 的连续前缀；不能提交整场或其他工作组。", work.ShotIDs)
		item := shots["items"].(map[string]any)
		fields := item["properties"].(map[string]any)
		fields["id"] = map[string]any{"type": "string", "enum": work.ShotIDs}
		var starts, ends []int
		var durations []float64
		for _, id := range work.ShotIDs {
			_, plan := storyboardPlannedShot(m, id)
			if plan == nil {
				continue
			}
			starts = append(starts, plan.Start)
			ends = append(ends, plan.End)
			durations = append(durations, plan.Duration)
		}
		if len(starts) > 0 {
			fields["start"] = map[string]any{"type": "integer", "enum": storyboardUniqueValues(starts), "description": "当前镜号在plannedShots中的start，原文段号，不是秒数"}
			fields["end"] = map[string]any{"type": "integer", "enum": storyboardUniqueValues(ends), "description": "当前镜号在plannedShots中的end，原文段号，不是秒数"}
			fields["duration"] = map[string]any{"type": "number", "enum": storyboardUniqueValues(durations), "description": "当前镜号在plannedShots中的duration，单位秒，不得沿用旧稿或审查意见中的旧预算"}
		}
	}
}

func storyboardUniqueValues[T comparable](values []T) []T {
	result := make([]T, 0, len(values))
	seen := map[T]bool{}
	for _, value := range values {
		if !seen[value] {
			result = append(result, value)
			seen[value] = true
		}
	}
	return result
}
