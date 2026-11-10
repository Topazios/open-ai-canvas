package app

import "testing"

func TestStoryboardManualRetryRestoresOnlyReproduciblePartialProjection(t *testing.T) {
	for _, change := range []string{"stale", "text", "source", "parameters", "deleted"} {
		t.Run(change, func(t *testing.T) {
			s, db, id := sceneStoryboardFixture(t, false)
			state := enqueueSceneWorks(t, s, id)
			_, oldDoc, _ := storyboardState(t, s, id)
			oldMeta := productionNode(oldDoc, "target")["metadata"].(map[string]any)
			work := state.ProductionParallel["S2"]
			task, _ := sceneResult(t, s, id, work, 1)
			if err := s.settleProductionParallel("user", id, work, task); err != nil {
				t.Fatal(err)
			}
			productionEditCanvas(t, s, db, func(doc map[string]any) {
				target := productionNode(doc, "target")
				meta := target["metadata"].(map[string]any)
				meta["content"], meta["storyboard"] = oldMeta["content"], oldMeta["storyboard"]
				switch change {
				case "text":
					meta["content"] = "人工调整内容"
				case "source":
					productionNode(doc, "body")["metadata"].(map[string]any)["content"] = "正文已修改"
				case "parameters":
					productionWorkflow(target)["parameters"].(map[string]any)["shotDurationSeconds"] = 12
				case "deleted":
					target["id"] = "different-node"
				}
			})
			if _, err := s.holdStoryboardCoordinator("user", id, "projection conflict", "failed"); err != nil {
				t.Fatal(err)
			}
			err := s.ControlProductionAgent("user", id, "retry_main")
			if change != "stale" {
				if err == nil {
					t.Fatal("accepted changed inputs or manual output")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			m, _, rows := storyboardState(t, s, id)
			if len(m.Storyboard.Scenes[1].Shots) != 1 || rows[1]["detailStatus"] != "ready" {
				t.Fatal("saved partial shot was not restored")
			}
		})
	}
}
