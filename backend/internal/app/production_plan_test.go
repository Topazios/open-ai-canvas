package app

import (
	"encoding/json"
	"strings"
	"testing"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func planFixture(t *testing.T, version ...int) (*Service, *gorm.DB, *CloudAgentRun) {
	t.Helper()
	s, db, run := productionFixture(t, "林岚用旧相机追查照相馆的秘密，最终救回家人。")
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionWorkflow(productionNode(doc, "body"))["step"] = "story.topic"
		for _, id := range []string{"target", "group"} {
			data := productionWorkflow(productionNode(doc, id))
			data["step"], data["stage"] = "story.plan", "story"
			data["parameters"] = map[string]any{"episodeCount": 3, "minutesPerEpisode": "2"}
			if len(version) > 0 {
				data["planVersion"] = version[0]
			}
		}
		productionWorkflow(productionNode(doc, "target"))["sourceNodeIds"] = []string{"body"}
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

func planDocument(key string) map[string]string {
	doc := map[string]string{}
	for _, section := range productionDocumentSections("plan", key) {
		doc[section.Key] = section.Title + "：明确的制作设定，计划出场第1集；创作设计。"
	}
	doc["sound"] = "声音设计：中低音、温暖微哑、中速、普通话；克制表达情绪，紧张时停顿，禁止突然尖嗓。"
	return doc
}

func TestProductionPlanResumeCoverageAndCompletion(t *testing.T) {
	s, _, run := planFixture(t)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": planDocument("story"), "factIds": []string{}}, false)
	assets := []productionPlanAsset{{Key: "C001", Kind: "character", Name: "林岚", Episodes: []int{1, 2, 3}}, {Key: "E001", Kind: "environment", Name: "照相馆", Episodes: []int{1}}}
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{StoryHash: story["hash"].(string), Assets: assets[:1], Absent: map[string]string{"prop": "本版无独立道具", "special": "无超自然设定"}}, false)
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{StoryHash: story["hash"].(string), Assets: assets[1:]}, false)
	check := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if check["valid"] != false || check["missingCount"] != float64(2) {
		t.Fatal(check)
	}
	for _, asset := range assets {
		productionCall(t, s, run.ID, "production_submit", map[string]any{"key": asset.Key, "name": asset.Name, "document": planDocument(asset.Key), "factIds": []string{}}, false)
	}
	check = productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if check["valid"] != true {
		t.Fatal(check)
	}
	// Reload durable state, without retaining the tool conversation.
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	_, manifest, doc, err := productionLoad(s.repo, execution, &state)
	if err != nil || len(manifest.Plan.Assets) != 2 {
		t.Fatal(manifest, err)
	}
	context, err := productionPlanContext(s.repo, execution, manifest, doc)
	if err != nil || context["story"] == nil {
		t.Fatal(context, err)
	}
	if err := productionComplete(s.repo, execution, &state, defaultRuntimePolicy()); err != nil {
		t.Fatal(err)
	}
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	final, _ := creationDocument(canvas.PayloadJSON)
	meta := productionNode(final, "target")["metadata"].(map[string]any)
	if meta["status"] != "success" || !strings.Contains(meta["content"].(string), "2 项计划资产") {
		t.Fatal(meta)
	}
	for _, row := range mustPlanArtifacts(t, s, run.ID) {
		wd := productionWorkflow(productionNode(final, row.NodeID))
		if wd["stage"] != "story" || wd["step"] != "story.plan" || wd["assetProfile"] != nil {
			t.Fatal(wd)
		}
		if row.Key != "story" && wd["planAsset"] == nil {
			t.Fatal("missing planned asset identity")
		}
	}
}

func mustPlanArtifacts(t *testing.T, s *Service, runID string) []model.ProductionAgentArtifact {
	t.Helper()
	rows, err := s.repo.ProductionAgentArtifacts("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

func TestProductionPlanRejectsUnregisteredIncompleteAndStaleWork(t *testing.T) {
	s, db, run := planFixture(t)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "C001", "name": "林岚", "document": planDocument("C001"), "factIds": []string{}}, true)
	story := productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "story", "name": "故事总纲", "document": planDocument("story"), "factIds": []string{}}, false)
	input := productionPlan{StoryHash: "stale", Assets: []productionPlanAsset{{Key: "C001", Kind: "character", Name: "林岚", Episodes: []int{1}}}}
	productionCall(t, s, run.ID, "production_plan_inventory", input, true)
	input.StoryHash = story["hash"].(string)
	input.Assets[0].Episodes = []int{4}
	productionCall(t, s, run.ID, "production_plan_inventory", input, true)
	input.Assets[0].Episodes = []int{1}
	productionCall(t, s, run.ID, "production_plan_inventory", input, false)
	doc := planDocument("C001")
	delete(doc, "sound")
	productionCall(t, s, run.ID, "production_submit", map[string]any{"key": "C001", "name": "林岚", "document": doc, "factIds": []string{}}, true)
	productionCall(t, s, run.ID, "production_facts", map[string]any{"pageId": productionFirstPage(t, s, run.ID), "facts": []any{}}, true)
	check := productionCall(t, s, run.ID, "production_check", map[string]any{}, false)
	if check["valid"] != false {
		t.Fatal(check)
	}
	if len(mustPlanArtifacts(t, s, run.ID)) != 1 {
		t.Fatal("invalid writes created nodes")
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionNode(doc, "body")["metadata"].(map[string]any)["content"] = "用户改选了另一个故事"
	})
	productionCall(t, s, run.ID, "production_status", map[string]any{}, true)
}

func TestProductionPlanManifestRejectsNonTopic(t *testing.T) {
	s, _, run := productionFixture(t)
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	productionWorkflow(productionNode(doc, "target"))["step"] = "story.plan"
	encoded, _ := json.Marshal(doc)
	canvas.PayloadJSON = string(encoded)
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	if _, err := productionSourceManifest(canvas, state.Request); err == nil {
		t.Fatal("accepted body as selected topic")
	}
}

func TestProductionPlanDownstreamInheritsOnlyDeclaredAssetCategory(t *testing.T) {
	s, _, run := productionFixture(t)
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	doc, _ := creationDocument(canvas.PayloadJSON)
	nodes := creationMaps(doc["nodes"])
	for _, kind := range []string{"character", "environment", "prop"} {
		nodes = append(nodes, map[string]any{"id": kind, "title": kind, "type": "text", "metadata": map[string]any{"content": "完整计划设定", "status": "success", "shortDrama": map[string]any{"step": "story.plan", "pipelineId": "story", "assetKey": kind, "planAsset": map[string]any{"kind": kind}}}})
	}
	doc["nodes"] = nodes
	// prop exists on the canvas, but is not in this branch's declared provenance.
	productionWorkflow(productionNode(doc, "target"))["sourceSignatures"] = map[string]any{"body": "fixture", "character": "fixture", "environment": "fixture"}
	encoded, _ := json.Marshal(doc)
	canvas.PayloadJSON = string(encoded)
	execution, _ := s.repo.CloudAgent("user", run.ID)
	state, _ := cloudAgentDecode(execution)
	m, err := productionSourceManifest(canvas, state.Request)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Sources) != 2 {
		t.Fatal(m.Sources)
	}
	for _, source := range m.Sources {
		if source.NodeID != "body" && source.NodeID != "character" {
			t.Fatal(source)
		}
	}
}
