package app

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func inventoryReviewFixture(t *testing.T) (productionPlan, map[string]any, []model.ProductionAgentArtifact) {
	t.Helper()
	fields := map[string]string{}
	for _, section := range productionPlanDocumentSectionsForSchema("story", "", 2) {
		fields[section.Key] = "该节记录不新增独立制作对象的项目原则。"
	}
	fields["plot"] = "主角疏散客人。住户口头邀请主角进门。"
	fields["episodeArchitecture"] = productionEpisodeArchitectureFixture(2)
	content, err := productionRenderPlanDocumentForSchema("story", "", fields, 2)
	if err != nil {
		t.Fatal(err)
	}
	node := map[string]any{"id": "story-node", "parentId": "root", "metadata": map[string]any{"content": content}}
	hash := productionArtifactHash(node)
	plan := productionPlan{Version: 4, InventoryReviewVersion: 1, StoryHash: hash, Assets: []productionPlanAsset{{Key: "hero", Name: "主角", Kind: "character"}, {Key: "guest", Name: "散场客人", Kind: "character"}, {Key: "resident", Name: "住户", Kind: "character"}}}
	keys, _ := productionInventoryReviewSources(plan, content)
	for _, key := range keys {
		review := productionInventorySectionReview{Section: key, NoAssetsReason: "该节仅重述已核对对象或项目原则，无新增制作对象。"}
		if key == "plot" {
			review.NoAssetsReason = ""
			for _, key := range []string{"hero", "guest", "resident"} {
				quote := "住户口头邀请主角进门。"
				if key == "guest" {
					quote = "主角疏散客人。"
				}
				review.Requirements = append(review.Requirements, productionInventoryRequirement{Subject: key, Quote: quote, AssetKey: key, Disposition: "asset", Reason: "承担关键动作，保留独立身份。"})
			}
		}
		plan.InventoryReview = append(plan.InventoryReview, review)
	}
	return plan, map[string]any{"nodes": []any{node}}, []model.ProductionAgentArtifact{{Key: "story", NodeID: "story-node", ContentHash: hash}}
}

func productionInventoryReviewForTest(t *testing.T, s *Service, runID string, assets []productionPlanAsset) []productionInventorySectionReview {
	t.Helper()
	m, doc, artifacts := orderedPlanState(t, s, runID)
	var story string
	for _, artifact := range artifacts {
		if artifact.Key != "story" {
			continue
		}
		meta, _ := productionNode(doc, artifact.NodeID)["metadata"].(map[string]any)
		story = stringValue(meta["content"])
		break
	}
	sections, bodies := productionInventoryReviewSources(*m.Plan, story)
	reviews := make([]productionInventorySectionReview, 0, len(sections))
	for i, section := range sections {
		review := productionInventorySectionReview{Section: section, NoAssetsReason: "测试故事本节无新增资产需求。"}
		if i == 0 && len(assets) > 0 {
			quote := truncateRunes(bodies[section], 250)
			review.NoAssetsReason = ""
			for _, asset := range assets {
				review.Requirements = append(review.Requirements, productionInventoryRequirement{
					Subject: asset.Name, Quote: quote, AssetKey: asset.Key,
					Disposition: "asset", Reason: "测试用资产来源映射。",
				})
			}
		}
		reviews = append(reviews, review)
	}
	return reviews
}

func TestProductionInventoryReviewRejectsMissingEpisodeAndUnregisteredActor(t *testing.T) {
	plan, doc, rows := inventoryReviewFixture(t)
	if err := productionValidateInventoryReview(plan, doc, "root", rows, true); err != nil {
		t.Fatal(err)
	}
	plan.InventoryReview = plan.InventoryReview[:len(plan.InventoryReview)-1]
	if err := productionValidateInventoryReview(plan, doc, "root", rows, true); err == nil || !strings.Contains(err.Error(), "EP-002") {
		t.Fatal("missing episode was accepted", err)
	}
	if err := productionValidateInventoryReview(plan, doc, "root", rows, false); err != nil {
		t.Fatal("partial review must remain resumable", err)
	}
	plan, doc, rows = inventoryReviewFixture(t)
	plan.Assets = plan.Assets[:2]
	if err := productionValidateInventoryReview(plan, doc, "root", rows, true); err == nil || !strings.Contains(err.Error(), "resident") {
		t.Fatal("a declared critical actor without a registered identity was accepted", err)
	}
}

func TestProductionInventoryReviewRejectsWrongSourceAndPreservesExplicitReuse(t *testing.T) {
	for _, change := range []string{"quote", "unknown section", "asset source", "subject"} {
		t.Run(change, func(t *testing.T) {
			plan, doc, rows := inventoryReviewFixture(t)
			for i := range plan.InventoryReview {
				if plan.InventoryReview[i].Section != "plot" {
					continue
				}
				switch change {
				case "quote":
					plan.InventoryReview[i].Requirements[0].Quote = "无来源的新人物来了。"
				case "unknown section":
					plan.InventoryReview[i].Section = "invented"
				case "asset source":
					plan.InventoryReview[i].Requirements = plan.InventoryReview[i].Requirements[:2]
				case "subject":
					plan.Assets[0].SubjectKeys = []string{"not-registered"}
				}
			}
			if err := productionValidateInventoryReview(plan, doc, "root", rows, true); err == nil {
				t.Fatal("bad source mapping was accepted")
			}
		})
	}
	plan, doc, rows := inventoryReviewFixture(t)
	for i := range plan.InventoryReview {
		if plan.InventoryReview[i].Section == "plot" {
			plan.InventoryReview[i].Requirements[0].Disposition = "state"
			plan.InventoryReview[i].Requirements[0].Reason = "服化属于同一主角，沿用身份并以状态承载。"
		}
	}
	if err := productionValidateInventoryReview(plan, doc, "root", rows, true); err != nil {
		t.Fatal("explicit state reuse was rejected", err)
	}
	productionNode(doc, "story-node")["metadata"].(map[string]any)["content"] = "人工修订后的总纲"
	if err := productionValidateInventoryReview(plan, doc, "root", rows, true); err == nil {
		t.Fatal("review silently overwrote changed source")
	}
}

func TestProductionInventoryReviewBatchesSurviveRestartAndRenderEvidence(t *testing.T) {
	s, db, run := planFixture(t, 3)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := submitOrderedPlan(t, s, run.ID, "story", "", "故事总纲")
	m, doc, rows := orderedPlanState(t, s, run.ID)
	m.Plan.InventoryReviewVersion = 1
	encoded, _ := json.Marshal(m)
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, string(encoded)); err != nil {
		t.Fatal(err)
	}
	var content string
	for _, row := range rows {
		if row.Key == "story" {
			content = stringValue(productionNode(doc, row.NodeID)["metadata"].(map[string]any)["content"])
		}
	}
	keys, bodies := productionInventoryReviewSources(*m.Plan, content)
	reviews := []productionInventorySectionReview{}
	for _, key := range keys {
		review := productionInventorySectionReview{Section: key, NoAssetsReason: "该节仅描述项目原则，无新增资产。"}
		if key == "plot" {
			review.NoAssetsReason = ""
			review.Requirements = []productionInventoryRequirement{{Subject: "主角", Quote: bodies[key], AssetKey: "hero", Disposition: "asset", Reason: "该故事设计由主角实施。"}}
		}
		reviews = append(reviews, review)
	}
	input := productionPlan{StoryHash: stringValue(story["hash"]), Assets: []productionPlanAsset{{Key: "hero", Kind: "character", Name: "主角", Purpose: "承载行动", PlannedRange: "全剧"}}, Absent: map[string]string{"environment": "无独立场景", "prop": "无剧情道具", "sound": "无独立复用声音"}, InventoryReview: reviews[:3]}
	productionCall(t, s, run.ID, "production_plan_inventory", input, false)
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	m, _, _ = orderedPlanState(t, s, run.ID)
	if len(m.Plan.InventoryReview) != 3 || m.Plan.Complete {
		t.Fatal("partial source review did not survive service restart")
	}
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{StoryHash: input.StoryHash, Complete: true}, true)
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{StoryHash: input.StoryHash, InventoryReview: reviews[3:], Complete: true}, false)
	m, doc, rows = orderedPlanState(t, s, run.ID)
	if !productionPlanArtifactValid(m, doc, rows, "inventory") {
		t.Fatal("completed evidence review did not save a valid inventory")
	}
	for _, row := range rows {
		if row.Key == "inventory" {
			text := stringValue(productionNode(doc, row.NodeID)["metadata"].(map[string]any)["content"])
			if !strings.Contains(text, "总纲需求与登记对照") || !strings.Contains(text, "该故事设计由主角实施") {
				t.Fatal("review was not visible in the inventory")
			}
		}
	}
}

func TestProductionInventoryReviewSchemaOnlyAppliesToNewCheckpoints(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		tools := productionPlanScopedTools(productionPlanTools(4), map[string]any{"nextAction": map[string]any{"inventoryReviewRequired": enabled}})
		for _, tool := range tools {
			fn := tool["function"].(map[string]any)
			params := fn["parameters"].(map[string]any)
			props := params["properties"].(map[string]any)
			_, exists := props["inventoryReview"]
			if exists != enabled {
				t.Fatal("historical checkpoint was silently upgraded")
			}
		}
	}
	tools := productionPlanScopedTools(productionPlanTools(5), map[string]any{"nextAction": map[string]any{
		"independent": true, "inventoryReviewRequired": true,
		"sourceSections": []string{"premise", "episodeArchitecture/EP-001"},
	}}, 5)
	for _, tool := range tools {
		fn := tool["function"].(map[string]any)
		if fn["name"] != "production_plan_inventory" {
			continue
		}
		parameters := fn["parameters"].(map[string]any)
		properties := parameters["properties"].(map[string]any)
		if !cloudAgentContainsString(productionIDs(parameters["required"]), "inventoryReview") {
			t.Fatal("current independent plan inventory bypassed source review", parameters["required"])
		}
		if !cloudAgentContainsString(productionIDs(properties["assets"].(map[string]any)["items"].(map[string]any)["required"]), "priority") {
			t.Fatal("current plan inventory lost its priority contract")
		}
		if !strings.Contains(stringValue(properties["inventoryReview"].(map[string]any)["description"]), "逐集核对") {
			t.Fatal("current inventory review schema does not require episode level coverage")
		}
	}
}

func TestProductionInventoryContextCarriesCurrentSourceTextAndConstrainsKeys(t *testing.T) {
	s, _, run := planFixture(t, 2)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := submitOrderedPlan(t, s, run.ID, "story", "", "故事总纲")
	m, doc, artifacts := orderedPlanState(t, s, run.ID)
	m.Plan.InventoryReviewVersion = 1
	encoded, _ := json.Marshal(m)
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, string(encoded)); err != nil {
		t.Fatal(err)
	}
	m, doc, artifacts = orderedPlanState(t, s, run.ID)
	planRun, err := s.repo.CloudAgent("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	context, err := productionPlanContext(s.repo, planRun, m, doc)
	if err != nil {
		t.Fatal(err)
	}
	sections := context["sourceSections"].([]string)
	next := context["nextAction"].(map[string]any)
	bodies := next["sourceSectionText"].(map[string]string)
	if len(sections) == 0 || len(bodies) != len(sections) {
		t.Fatalf("source text missing: %d/%d", len(bodies), len(sections))
	}
	if _, duplicated := context["sourceSectionText"]; duplicated {
		t.Fatal("large source text was duplicated at the top level and inside nextAction")
	}
	for _, section := range sections {
		if strings.TrimSpace(bodies[section]) == "" {
			t.Fatalf("section %s has no source text", section)
		}
	}
	work := map[string]any{"registeredAssets": []map[string]any{{"key": "hero"}}, "nextAction": map[string]any{"inventoryReviewRequired": true, "sourceSections": sections}}
	for _, tool := range productionPlanScopedTools(productionPlanTools(4), work, 4) {
		fn := tool["function"].(map[string]any)
		if fn["name"] != "production_plan_inventory" {
			continue
		}
		props := fn["parameters"].(map[string]any)["properties"].(map[string]any)
		if !strings.Contains(stringValue(props["inventoryReview"].(map[string]any)["description"]), "sourceSectionText") || !strings.Contains(stringValue(props["inventoryReview"].(map[string]any)["description"]), "逐字 quote") {
			t.Fatal("schema does not bind quote requirement to provided source")
		}
		assetKey := props["inventoryReview"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)["requirements"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)["assetKey"].(map[string]any)
		if _, constrained := assetKey["enum"]; constrained {
			t.Fatalf("same-submission asset references must remain available to server-side cross-field validation: %v", assetKey)
		}
		if !strings.Contains(stringValue(props["inventoryReview"].(map[string]any)["description"]), "同批登记资产") {
			t.Fatal("inventory review schema does not explain same-submission references")
		}
	}
	maxSections := productionPlanScopedTools(productionPlanTools(4), work, 4)[0]["function"].(map[string]any)["parameters"].(map[string]any)["properties"].(map[string]any)["inventoryReview"].(map[string]any)["maxItems"]
	if maxSections != len(sections) {
		t.Fatalf("full review must fit one tool call: maxItems=%v sections=%d", maxSections, len(sections))
	}
	if stringValue(story["hash"]) == "" || len(artifacts) == 0 {
		t.Fatal("source identity missing")
	}
}

func TestProductionInventoryReviewAssociationsAreNotDesignDependencies(t *testing.T) {
	plan, doc, rows := inventoryReviewFixture(t)
	plan.Assets[0].SubjectKeys = []string{"guest"}
	plan.Assets[1].SubjectKeys = []string{"hero"}
	for i := range plan.Assets {
		plan.Assets[i].Purpose, plan.Assets[i].PlannedRange = "承载剧情", "全剧"
	}
	plan.Absent = map[string]string{"environment": "无独立场景", "prop": "无道具", "sound": "无独立声音"}
	if err := productionValidatePlanInventory(plan); err != nil {
		t.Fatal("mutual associations were confused with dependency cycles", err)
	}
	if err := productionValidateInventoryReview(plan, doc, "root", rows, true); err != nil {
		t.Fatal(err)
	}
	content, err := productionRenderPlanInventory(plan)
	if err != nil || !strings.Contains(content, "设计前置 | 关联主体") || !strings.Contains(content, "guest（散场客人）") {
		t.Fatal("table did not separate associations", err)
	}
}

func TestProductionInventoryReviewHashTracksEvidenceWithoutChangingLegacyReceipts(t *testing.T) {
	plan, _, _ := inventoryReviewFixture(t)
	before := productionPlanInventoryHash(plan)
	plan.InventoryReview[0].NoAssetsReason += "补充核对依据。"
	if productionPlanInventoryHash(plan) == before {
		t.Fatal("review change did not invalidate dependent receipts")
	}
	plan.InventoryReviewVersion = 0
	legacy := productionPlanInventoryHash(plan)
	plan.InventoryReview = nil
	if productionPlanInventoryHash(plan) != legacy {
		t.Fatal("new evidence affected legacy receipt hash")
	}
}

func TestProductionPlanV5InventoryHashTracksEvidence(t *testing.T) {
	plan, _, _ := inventoryReviewFixture(t)
	plan.Version = 5
	before := productionPlanInventoryHash(plan)
	plan.InventoryReview[0].NoAssetsReason += "当前方案版本的来源核对。"
	if productionPlanInventoryHash(plan) == before {
		t.Fatal("current plan inventory hash ignored its evidence ledger")
	}
}
