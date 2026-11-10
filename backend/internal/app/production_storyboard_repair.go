package app

// A changed predecessor invalidates only its explicit downstream consumers.
// Layout and unrelated accepted shots remain intact throughout local repair.
func storyboardRepairShots(m productionManifest, ids, sceneIDs []string) error {
	if len(ids) == 0 && (len(sceneIDs) == 0 || m.Storyboard.Version != storyboardSceneVersion) {
		return nil
	}
	if m.Storyboard.Version != storyboardSceneVersion {
		return BadAuthRequest("当前分镜模式不支持逐镜返修")
	}
	repair := map[string]bool{}
	for _, id := range ids {
		scene, plan := storyboardPlannedShot(m, id)
		if plan == nil || !storyboardShotDone(m, id) {
			return BadAuthRequest("返修镜头不存在或尚未保存：" + id)
		}
		if cloudAgentContainsString(sceneIDs, scene.ID) {
			return BadAuthRequest("整场返修与逐镜返修范围不能重叠")
		}
		repair[id] = true
	}
	for _, scene := range m.Storyboard.Scenes {
		for _, plan := range scene.Layout {
			if cloudAgentContainsString(sceneIDs, scene.ID) {
				repair[plan.ID] = true
			}
			for _, dep := range plan.DependsOn {
				if repair[dep] {
					repair[plan.ID] = true
				}
			}
		}
	}
	for i := range m.Storyboard.Scenes {
		scene := &m.Storyboard.Scenes[i]
		if cloudAgentContainsString(sceneIDs, scene.ID) {
			continue
		}
		kept := make([]productionShot, 0, len(scene.Shots))
		for _, shot := range scene.Shots {
			if repair[shot.ID] {
				previous := make([]productionShot, 0, len(scene.PreviousShots)+1)
				for _, old := range scene.PreviousShots {
					if old.ID != shot.ID {
						previous = append(previous, old)
					}
				}
				scene.PreviousShots = append(previous, shot)
				scene.Complete = false
			} else {
				kept = append(kept, shot)
			}
		}
		scene.Shots = kept
	}
	return nil
}
