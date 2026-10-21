package app

import (
	"fmt"
	"regexp"
	"strings"
)

var storyboardAssetCode = regexp.MustCompile(`^(CHR|SCN|PRP|SPC|AUD)-[0-9]+(-V[0-9]+)?$`)
var storyboardAssetMentions = regexp.MustCompile(`\b(CHR|SCN|PRP|SPC|AUD)-[0-9]+(-V[0-9]+)?\b`)
var regexpStoryboardVariant = regexp.MustCompile(`-V[0-9]+$`)

// Persist one editable episode table at each checkpoint. Task receipts and media
// links survive an unchanged shot; regenerated shots never reuse stale videos.
func materializeStoryboardRows(target map[string]any, m productionManifest, doc map[string]any) {
	meta, _ := target["metadata"].(map[string]any)
	previous, _ := meta["storyboard"].(map[string]any)
	byID := map[string]map[string]any{}
	for _, row := range creationMaps(previous["rows"]) {
		byID[stringValue(row["id"])] = row
	}
	rows := []any{}
	units := storyboardBody(m, doc)
	for _, scene := range m.Storyboard.Scenes {
		shots := scene.Shots
		if !scene.Complete && len(scene.PreviousShots) > 0 {
			shots = scene.PreviousShots
		}
		if len(scene.Layout) > 0 {
			byShot := map[string]productionShot{}
			for _, shot := range scene.Shots {
				byShot[shot.ID] = shot
			}
			shots = nil
			for _, plan := range scene.Layout {
				shot, done := byShot[plan.ID]
				if !done {
					shot = productionShot{ID: plan.ID, Start: plan.Start, End: plan.End, Duration: plan.Duration}
				}
				shots = append(shots, shot)
			}
		}
		for _, shot := range shots {
			id := fmt.Sprintf("%v:%s", target["id"], shot.ID)
			if shot.Visual == "" && len(scene.Layout) > 0 {
				var plan productionShotOutline
				for _, item := range scene.Layout {
					if item.ID == shot.ID {
						plan = item
					}
				}
				row := map[string]any{"id": id, "shotCode": shot.ID, "shotNumber": len(rows) + 1, "durationSeconds": shot.Duration, "sceneId": scene.ID, "sceneDurationSeconds": scene.Duration,
					"detailStatus": "planned", "plannedGoal": plan.Goal, "detailDependencies": plan.DependsOn, "plotDescription": "", "camera": "", "continuityOut": "", "videoMotionPrompt": "", "imageGenerationPrompt": "", "dialogue": "", "audioEffects": "", "assetKeys": []any{}, "assetBindings": []any{}, "characters": []any{}, "mustHave": []any{}, "optionalDetails": []any{}, "status": "idle"}
				for _, field := range []string{"narrativeIntent", "viewerPOV", "performanceBlocking", "shotSize", "emotion", "lightingAndAtmosphere", "motion", "timeBeats", "negativePrompt"} {
					row[field] = ""
				}
				rows = append(rows, row)
				continue
			}
			hash := productionStoredValueHash(shot)
			timingException := ""
			if m.Storyboard.Version != storyboardEpisodeVersion && m.Storyboard.ShotDuration > 0 && len(shots) > 1 && shot.ID == shots[len(shots)-1].ID && shot.Duration < m.Storyboard.ShotDuration-m.Storyboard.ShotTolerance {
				check := scene
				check.Shots = shots
				if validateStoryboardTiming(check, nil, true, m.Storyboard.ShotDuration, m.Storyboard.ShotTolerance) == nil {
					timingException = "scene_tail"
				}
			}
			if old := byID[id]; old != nil && old["sourceShotHash"] == hash {
				old["detailStatus"] = "ready"
				delete(old, "detailError")
				old["shotNumber"] = len(rows) + 1
				old["sceneId"], old["sceneDurationSeconds"] = scene.ID, scene.Duration
				delete(old, "timingException")
				if timingException != "" {
					old["timingException"] = timingException
				}
				rows = append(rows, old)
				continue
			}
			codes := append([]string{}, shot.AssetIDs...)
			if len(codes) == 0 {
				text := strings.Join([]string{shot.Visual, shot.Dialogue}, "\n")
				for i := shot.Start; i <= shot.End && i <= len(units); i++ {
					if i > 0 {
						text += "\n" + units[i-1]
					}
				}
				codes = storyboardAssetMentions.FindAllString(text, -1)
			}
			unique := []string{}
			for _, code := range codes {
				if !cloudAgentContainsString(unique, code) {
					unique = append(unique, code)
				}
			}
			prompt := fmt.Sprintf("镜头 %s · %.1f秒\n画面：%s\n镜头：%s\n对白：%s\n声音：%s\n衔接：%s", shot.ID, shot.Duration, shot.Visual, shot.Camera, shot.Dialogue, shot.Sound, shot.Continuity)
			row := map[string]any{
				"id": id, "shotCode": shot.ID, "shotNumber": len(rows) + 1, "sourceShotHash": hash,
				"sceneId": scene.ID, "sceneDurationSeconds": scene.Duration,
				"durationSeconds": shot.Duration, "plotDescription": shot.Visual, "camera": shot.Camera,
				"dialogue": shot.Dialogue, "audioEffects": shot.Sound, "continuityOut": shot.Continuity,
				"videoMotionPrompt": prompt, "imageGenerationPrompt": shot.Visual + "\n" + shot.Camera,
				"assetKeys": unique, "assetBindings": []any{}, "characters": []any{},
				"mustHave": []any{}, "optionalDetails": []any{}, "status": "idle",
				"detailStatus": "ready",
			}
			if timingException != "" {
				row["timingException"] = timingException
			}
			for _, field := range []string{"narrativeIntent", "viewerPOV", "performanceBlocking", "shotSize", "emotion", "lightingAndAtmosphere", "motion", "timeBeats", "negativePrompt"} {
				row[field] = ""
			}
			rows = append(rows, row)
		}
	}
	target["type"] = "script"
	if width, _ := target["width"].(float64); width < 1120 {
		target["width"] = 1120
	}
	if height, _ := target["height"].(float64); height < 640 {
		target["height"] = 640
	}
	if previous == nil {
		previous = map[string]any{}
	}
	previous["rows"], previous["visibleColumns"] = rows, []string{"shotNumber", "videoMotionPrompt", "assets"}
	if m.Storyboard.Version == storyboardEpisodeVersion {
		previous["executionMode"] = "episode"
	}
	if previous["referenceNodeIds"] == nil {
		previous["referenceNodeIds"] = []any{}
	}
	meta["storyboard"] = previous
}
