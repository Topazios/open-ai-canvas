package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func storyboardFixture(t *testing.T) (*Service, *gorm.DB, *CloudAgentRun) {
	t.Helper()
	s, db, run := productionFixture(t, "林岚进入照相馆。\n林岚说：我回来了。\n她放下相机。")
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		target := productionNode(doc, "target")
		target["title"] = "第1集分镜"
		data := productionWorkflow(target)
		data["step"] = "direction.shots"
		data["stage"] = "storyboard"
		delete(data, "assetKey")
		delete(data, "assetOutput")
		frame := productionWorkflow(productionNode(doc, "group"))
		delete(frame, "assetGroup")
		frame["step"] = "direction.shots"
	})
	if err := db.Where("run_id = ?", run.ID).Delete(&model.ProductionAgentJob{}).Error; err != nil {
		t.Fatal(err)
	}
	execution, _ := s.repo.CloudAgent("user", run.ID)
	if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, _ := cloudAgentDecode(current)
		state.Request.Production.InputVersion = ""
		state.PiAssistantResponses = 1
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.initializeProductionAgent("user", run.ID); err != nil {
		t.Fatal(err)
	}
	return s, db, run
}
func storyboardFixturePlan(t *testing.T, s *Service, runID string) {
	productionCall(t, s, runID, "production_storyboard_brief", map[string]any{"brief": "依据正文，保持相机与人物动作连续，未提供额外美术约束。", "sourceIds": []string{}}, false)
	productionCall(t, s, runID, "production_storyboard_plan", map[string]any{"scenes": []productionScene{
		{ID: "S1", Title: "入场", Start: 1, End: 1, Goal: "建立回归", Duration: 10, Entry: "门外", Exit: "馆内", AssetIDs: []string{}},
		{ID: "S2", Title: "回归", Start: 2, End: 3, Goal: "确认情绪", Duration: 20, Entry: "馆内", Exit: "放下相机", AssetIDs: []string{}},
	}}, false)
}
func storyboardShot(scene string, index, start, end int, duration float64) productionShot {
	return productionShot{ID: scene + "-00" + string(rune('0'+index)), Start: start, End: end, Duration: duration, Visual: "人物完成一个动作", Camera: "中景，平视，固定", Dialogue: "", Sound: "环境声", Continuity: "保持相机位置与视线", AssetIDs: []string{}}
}
func storyboardSubmitArgs(t *testing.T, s *Service, runID, scene string, offset int, shots []productionShot, complete bool) map[string]any {
	context := productionCall(t, s, runID, "production_storyboard_context", map[string]any{}, false)
	return map[string]any{"sceneId": scene, "offset": offset, "expectedHash": context["expectedHash"], "shots": shots, "complete": complete}
}
func TestProductionStoryboardCheckpointsResumeAndCompletion(t *testing.T) {
	s, db, run := storyboardFixture(t)
	storyboardFixturePlan(t, s, run.ID)
	first := storyboardSubmitArgs(t, s, run.ID, "S1", 0, []productionShot{storyboardShot("S1", 1, 1, 1, 10)}, true)
	productionCall(t, s, run.ID, "production_storyboard_submit", first, false)
	restarted := &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	if receipt := productionCall(t, restarted, run.ID, "production_storyboard_submit", first, false); receipt["reused"] != true {
		t.Fatal(receipt)
	}
	context := productionCall(t, restarted, run.ID, "production_storyboard_context", map[string]any{}, false)
	if context["phase"] != "scene" || context["scene"].(map[string]any)["id"] != "S2" {
		t.Fatal(context)
	}
	encoded, _ := json.Marshal(context["source"])
	if strings.Contains(string(encoded), "进入照相馆") {
		t.Fatal("previous scene leaked into current source")
	}
	part := storyboardSubmitArgs(t, restarted, run.ID, "S2", 0, []productionShot{storyboardShot("S2", 1, 2, 2, 10)}, false)
	productionCall(t, restarted, run.ID, "production_storyboard_submit", part, false)
	if err := restarted.completeCloudAgentPiRun("user", run.ID); err == nil {
		t.Fatal("incomplete scene accepted")
	}
	part = storyboardSubmitArgs(t, restarted, run.ID, "S2", 1, []productionShot{storyboardShot("S2", 2, 3, 3, 10)}, true)
	productionCall(t, restarted, run.ID, "production_storyboard_submit", part, false)
	context = productionCall(t, restarted, run.ID, "production_storyboard_context", map[string]any{}, false)
	productionCall(t, restarted, run.ID, "production_storyboard_review", map[string]any{"hash": context["hash"], "review": "三段剧情均有镜头，出入场和相机动作连续。", "repairSceneIds": []string{}}, false)
	if err := restarted.completeCloudAgentPiRun("user", run.ID); err != nil {
		t.Fatal(err)
	}
	finished, err := restarted.CloudAgentRun("user", run.ID)
	if err != nil || finished.Status != "completed" || finished.Production.ProcessedPages != 2 || finished.Production.ArtifactCount != 3 {
		t.Fatalf("%+v %v", finished, err)
	}
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	meta := productionNode(doc, "target")["metadata"].(map[string]any)
	if meta["status"] != "success" || !strings.Contains(stringValue(meta["content"]), "S2-002") || len(creationMaps(doc["nodes"])) != 4 {
		t.Fatal("lost shots or created extra nodes")
	}
}
func TestProductionStoryboardRejectsMissingCoverageAndStaleWrites(t *testing.T) {
	s, db, run := storyboardFixture(t)
	storyboardFixturePlan(t, s, run.ID)
	args := storyboardSubmitArgs(t, s, run.ID, "S1", 0, []productionShot{storyboardShot("S1", 1, 1, 1, 10)}, true)
	args["expectedHash"] = "stale"
	productionCall(t, s, run.ID, "production_storyboard_submit", args, true)
	args = storyboardSubmitArgs(t, s, run.ID, "S1", 0, []productionShot{storyboardShot("S1", 1, 1, 1, 10)}, true)
	productionCall(t, s, run.ID, "production_storyboard_submit", args, false)
	args = storyboardSubmitArgs(t, s, run.ID, "S2", 0, []productionShot{storyboardShot("S2", 1, 2, 2, 20)}, true)
	productionCall(t, s, run.ID, "production_storyboard_submit", args, true)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionNode(doc, "target")["metadata"].(map[string]any)["content"] = "人工修改"
	})
	productionCall(t, s, run.ID, "production_storyboard_context", map[string]any{}, true)
}
func TestProductionStoryboardStopsOnSourceChangeAndDeletion(t *testing.T) {
	for _, kind := range []string{"source", "target"} {
		t.Run(kind, func(t *testing.T) {
			s, db, run := storyboardFixture(t)
			storyboardFixturePlan(t, s, run.ID)
			productionEditCanvas(t, s, db, func(doc map[string]any) {
				if kind == "source" {
					productionNode(doc, "body")["metadata"].(map[string]any)["content"] = "新版正文"
					return
				}
				nodes := creationMaps(doc["nodes"])
				var kept []map[string]any
				for _, node := range nodes {
					if node["id"] != "target" {
						kept = append(kept, node)
					}
				}
				doc["nodes"] = kept
			})
			productionCall(t, s, run.ID, "production_storyboard_context", map[string]any{}, true)
		})
	}
}
func TestProductionStoryboardPlanValidation(t *testing.T) {
	s, _, run := storyboardFixture(t)
	productionCall(t, s, run.ID, "production_storyboard_brief", map[string]any{"brief": "保留剧情", "sourceIds": []string{}}, false)
	for _, scenes := range [][]productionScene{
		{{ID: "S1", Title: "漏段", Start: 2, End: 3, Goal: "x", Duration: 20, Entry: "a", Exit: "b"}},
		{{ID: "S1", Title: "虚构资产", Start: 1, End: 3, Goal: "x", Duration: 20, Entry: "a", Exit: "b", AssetIDs: []string{"foreign"}}},
	} {
		productionCall(t, s, run.ID, "production_storyboard_plan", map[string]any{"scenes": scenes}, true)
	}
}

func TestProductionStoryboardRepairPreservesPriorOutputAndOtherScenes(t *testing.T) {
	s, _, run := storyboardFixture(t)
	storyboardFixturePlan(t, s, run.ID)
	productionCall(t, s, run.ID, "production_storyboard_submit", storyboardSubmitArgs(t, s, run.ID, "S1", 0, []productionShot{storyboardShot("S1", 1, 1, 1, 10)}, true), false)
	productionCall(t, s, run.ID, "production_storyboard_submit", storyboardSubmitArgs(t, s, run.ID, "S2", 0, []productionShot{storyboardShot("S2", 1, 2, 3, 20)}, true), false)
	current := productionCall(t, s, run.ID, "production_storyboard_context", map[string]any{}, false)
	productionCall(t, s, run.ID, "production_storyboard_review", map[string]any{"hash": current["hash"], "review": "补足回归情绪", "repairSceneIds": []string{"S2"}}, false)
	load := func() productionManifest {
		job, err := s.repo.ProductionAgentJob("user", run.ID)
		if err != nil {
			t.Fatal(err)
		}
		var m productionManifest
		if err := json.Unmarshal([]byte(job.ManifestJSON), &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	original := renderStoryboard(load())
	if !strings.Contains(original, "S2-001") || !load().Storyboard.Scenes[0].Complete {
		t.Fatal("repair removed prior output or reopened another scene")
	}
	shot := storyboardShot("S2", 1, 2, 3, 20)
	shot.Visual = "修订后的动作"
	productionCall(t, s, run.ID, "production_storyboard_submit", storyboardSubmitArgs(t, s, run.ID, "S2", 0, []productionShot{shot}, false), false)
	current = productionCall(t, s, run.ID, "production_storyboard_context", map[string]any{}, false)
	productionCall(t, s, run.ID, "production_storyboard_reset", map[string]any{"sceneId": "S2", "expectedHash": current["expectedHash"], "review": "修订稿还需调整"}, false)
	if strings.Contains(renderStoryboard(load()), "修订后的动作") {
		t.Fatal("partial repair replaced complete prior draft")
	}
	productionCall(t, s, run.ID, "production_storyboard_submit", storyboardSubmitArgs(t, s, run.ID, "S2", 0, []productionShot{shot}, false), false)
	productionCall(t, s, run.ID, "production_storyboard_submit", storyboardSubmitArgs(t, s, run.ID, "S2", 1, []productionShot{}, true), false)
	m := load()
	if len(m.Storyboard.Scenes[1].PreviousShots) != 0 || !strings.Contains(renderStoryboard(m), "修订后的动作") || storyboardCoverage(m)["valid"] == true {
		t.Fatal("repair did not switch drafts or incorrectly bypassed review")
	}
}

func TestProductionStoryboardBriefIsolationAndDuration(t *testing.T) {
	s, _, run := storyboardFixture(t)
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	_, m, doc, err := productionLoad(s.repo, execution, &state)
	if err != nil {
		t.Fatal(err)
	}
	original := m.Storyboard.BriefPageID
	productionWorkflow(productionNode(doc, "target"))["parameters"] = map[string]any{"minutesPerEpisode": "2.5"}
	if err := initializeStoryboardBrief(s.repo, execution, &state, &m, doc); err != nil {
		t.Fatal(err)
	}
	if m.Storyboard.BriefPageID != original || m.Storyboard.Duration != 150 {
		t.Fatal("same version did not reuse brief or duration not inherited")
	}
	state.Request.Model += "-different"
	if err := initializeStoryboardBrief(s.repo, execution, &state, &m, doc); err != nil {
		t.Fatal(err)
	}
	if m.Storyboard.BriefPageID == original {
		t.Fatal("different model reused brief")
	}
	scenes := []productionScene{{ID: "S1", Title: "整场", Start: 1, End: 3, Goal: "目标", Duration: 30, Entry: "入", Exit: "出"}}
	if validateStoryboardPlan(scenes, m, doc) == nil {
		t.Fatal("episode duration budget ignored")
	}
	scenes[0].Duration = 150
	if err := validateStoryboardPlan(scenes, m, doc); err != nil {
		t.Fatal(err)
	}
}

func TestProductionModelTimingSeparatesQueueAndExecution(t *testing.T) {
	created := time.Now().UTC()
	started, finished := created.Add(5*time.Second), created.Add(17*time.Second)
	payload := productionModelCompletedPayload(&model.Task{ID: "task", CreatedAt: created, StartedAt: &started, CompletedAt: &finished}, 1, "done")
	if payload["queueMs"] != int64(5000) || payload["executionMs"] != int64(12000) {
		t.Fatal(payload)
	}
}

func TestProductionStoryboardIncludesDeclaredAncestorRules(t *testing.T) {
	s, db, run := storyboardFixture(t)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		pipeline := productionWorkflow(productionNode(doc, "target"))["pipelineId"]
		plan := map[string]any{"id": "plan", "type": "text", "title": "制作方案", "metadata": map[string]any{"status": "success", "content": "每集两分半，保持固定视觉规范", "shortDrama": map[string]any{"step": "story.plan", "pipelineId": pipeline}}}
		doc["nodes"] = append(creationMaps(doc["nodes"]), plan)
		productionWorkflow(productionNode(doc, "target"))["sourceSignatures"] = map[string]any{"plan": "declared-ancestor"}
	})
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	m, err := productionSourceManifest(canvas, state.Request)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, source := range m.Sources {
		found = found || source.NodeID == "plan"
	}
	if !found {
		t.Fatal("declared upstream production plan missing")
	}
}

func TestProductionStoryboardManifestIgnoresAssetsNestedInEpisodeBody(t *testing.T) {
	s, db, run := storyboardFixture(t)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		nodes := creationMaps(doc["nodes"])
		bodyContainer := productionNode(doc, "bodies")
		bodyWorkflow := productionWorkflow(bodyContainer)
		bodyWorkflow["sourceNodeIds"] = []string{"body", "asset-bundle"}
		nodes = append(nodes,
			map[string]any{
				"id":       "character-assets",
				"type":     "text",
				"title":    "林岚人物资产",
				"parentId": "asset-bundle",
				"metadata": map[string]any{"content": "人物提示词、声音提示词和生成结果", "status": "success", "shortDrama": map[string]any{
					"pipelineId": "story", "step": "assets.characters", "stage": "assets", "role": "document",
				}},
			},
			map[string]any{
				"id":       "asset-bundle",
				"type":     "frame",
				"title":    "资产分组",
				"parentId": "bodies",
				"metadata": map[string]any{"shortDrama": map[string]any{
					"pipelineId": "story", "step": "assets.environments", "stage": "assets", "role": "collection", "sourceNodeIds": []string{"character-assets"},
				}},
			},
		)
		doc["nodes"] = nodes
	})

	execution, err := s.repo.CloudAgent("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, err := cloudAgentDecode(execution)
	if err != nil {
		t.Fatal(err)
	}
	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := productionSourceManifest(canvas, state.Request)
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Sources) != 1 || manifest.Sources[0].NodeID != "body" || manifest.Sources[0].Step != "story.body" {
		t.Fatalf("storyboard manifest included non-episode sources: %#v", manifest.Sources)
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	if err := initializeStoryboardBrief(s.repo, execution, &state, &manifest, doc); err != nil {
		t.Fatal(err)
	}
	context, err := storyboardContext(s.repo, "user", manifest, doc)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(context)
	if strings.Contains(string(encoded), "catalog") || strings.Contains(string(encoded), "character-assets") || strings.Contains(string(encoded), "asset-bundle") {
		t.Fatalf("storyboard context leaked asset catalog: %s", encoded)
	}
}
