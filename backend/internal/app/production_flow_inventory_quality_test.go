package app

import (
	"fmt"
	"strings"
	"testing"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func publishFlowTestRoot(t *testing.T, s *Service, db *gorm.DB, id, root string) {
	t.Helper()
	for iteration := 0; iteration < 30; iteration++ {
		g, done := flowGraph(t, s, id, root)
		if done {
			run, state := productionRuntimeState(t, s, id)
			m, doc, rows := orderedPlanState(t, s, id)
			if err := s.publishProductionFlow(run, &state, m, doc, rows, g); err != nil {
				t.Fatal(err)
			}
			return
		}
		progress := false
		for _, unit := range g.Units {
			if unit.Status == "pending" {
				settleFlowReply(t, s, db, id, unit, flowReply(unit))
				progress = true
			}
		}
		if !progress {
			t.Fatal("test graph stalled")
		}
	}
	t.Fatal("test graph did not complete")
}

func TestProductionFlowEditedInventoryRebuildIsLocalAndUnblocksRoot(t *testing.T) {
	s, db, id := flowFixture(t)
	publishFlowTestRoot(t, s, db, id, "story")
	publishFlowTestRoot(t, s, db, id, "inventory")
	submitOrderedPlan(t, s, id, "visual", "", "视觉与美术规范")
	submitOrderedPlan(t, s, id, "direction", "", "导演与视听规范")
	m, doc, rows := orderedPlanState(t, s, id)
	m.Plan.PlansStarted = true
	m.Plan.SelectedPlanKeys = []string{"inventory", "visual", "direction", "generation"}
	if err := s.repo.UpdateProductionAgentManifest("user", id, productionFlowJSON(m)); err != nil {
		t.Fatal(err)
	}
	oldNode := ""
	for _, row := range rows {
		if row.Key == "inventory" {
			oldNode = row.NodeID
		}
	}
	identity, registry := *m.Plan.Assets[0].Identity, productionPlanInventoryHash(*m.Plan)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionNode(doc, oldNode)["metadata"].(map[string]any)["content"] = "人工保留内容：不要覆盖。"
	})
	var before, after int64
	db.Model(&model.Task{}).Count(&before)
	run, state := productionRuntimeState(t, s, id)
	m, doc, rows = orderedPlanState(t, s, id)
	if productionFlowRoot(m, doc, rows) != "inventory" {
		t.Fatal("edited inventory did not trigger recovery")
	}
	if changed, err := s.advanceProductionFlow(run, &state, m, doc, rows, "inventory"); err != nil || !changed {
		t.Fatal(changed, err)
	}
	db.Model(&model.Task{}).Count(&after)
	m, doc, rows = orderedPlanState(t, s, id)
	if before != after || productionPlanInventoryHash(*m.Plan) != registry || *m.Plan.Assets[0].Identity != identity {
		t.Fatal("local recovery changed registry, codes or created paid work")
	}
	if !productionPlanArtifactValid(m, doc, rows, "inventory") || productionFlowRoot(m, doc, rows) != "" {
		t.Fatal("inventory still blocks remaining documents")
	}
	eligible := false
	for _, work := range productionParallelReady(m, doc, rows) {
		if work.Key == "generation" {
			eligible = true
		}
	}
	if !eligible {
		t.Fatal("final generation standard is still blocked")
	}
	prior := productionNode(doc, oldNode)
	if stringValue(prior["metadata"].(map[string]any)["content"]) != "人工保留内容：不要覆盖。" || productionWorkflow(prior)["planSection"] != nil {
		t.Fatal("edited copy lost or still selected as current inventory")
	}
	for _, row := range rows {
		if row.Key == "inventory" && row.NodeID == oldNode {
			t.Fatal("receipt still targets edited copy")
		}
	}
}

func TestProductionFlowInventoryReconcileReusesExtractionAndReplacesObsoleteAssets(t *testing.T) {
	s, db, id := flowFixture(t)
	publishFlowTestRoot(t, s, db, id, "story")
	publishFlowTestRoot(t, s, db, id, "inventory")
	m, _, _ := orderedPlanState(t, s, id)
	identity := *m.Plan.Assets[0].Identity
	m.Plan.Assets = append(m.Plan.Assets, productionPlanAsset{Key: "obsolete-duplicate", Kind: "character", Name: "错误重复人物", Identity: &productionAssetIdentity{ID: "old-extra", Code: "CHR-D001-099", Kind: "character"}})
	if err := s.repo.UpdateProductionAgentManifest("user", id, productionFlowJSON(m)); err != nil {
		t.Fatal(err)
	}
	mutateParallelState(t, s, id, func(run *model.CloudAgentExecution, state *cloudAgentRuntime) {
		run.Status = "waiting_user"
		state.ProductionPaused = true
		state.ProductionParallel["generation"] = productionParallelWork{Key: "generation", GenerationModel: "chosen-model", DisableThinking: true, QuietHold: true, Error: "old local failure"}
	})
	run, state := productionRuntimeState(t, s, id)
	if err := s.repo.MutateCloudAgent("user", id, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		return productionFlowPrepareInventoryReconcile(repo, current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	_, resumed := productionRuntimeState(t, s, id)
	if work := resumed.ProductionParallel["generation"]; work.GenerationModel != "chosen-model" || !work.DisableThinking || work.QuietHold || work.Error != "" {
		t.Fatal("audit lost document model selection or retained stale hold")
	}
	g, done := flowGraph(t, s, id, "inventory")
	if !done || g.Catalog == nil {
		t.Fatal("structured planning reconciliation should be local")
	}
	for _, unit := range g.Units {
		if unit.Stage == "extract" && unit.Status != "accepted" {
			t.Fatal("initial extraction unnecessarily reset")
		}
	}
	m, _, _ = orderedPlanState(t, s, id)
	if m.Plan.Complete || len(m.Plan.Assets) != 2 || m.Plan.InventoryAuditRevision != 1 {
		t.Fatal("old registry was removed before replacement")
	}
	run, state = productionRuntimeState(t, s, id)
	if _, err := s.claimProductionFlow(run, &state, "test-reconcile-owner"); err != nil {
		t.Fatal(err)
	}
	publishFlowTestRoot(t, s, db, id, "inventory")
	m, doc, rows := orderedPlanState(t, s, id)
	if len(m.Plan.Assets) != 1 || *m.Plan.Assets[0].Identity != identity || !productionPlanArtifactValid(m, doc, rows, "inventory") {
		t.Fatal("reconciliation appended stale assets, changed survivor codes or failed publication")
	}
}

func TestProductionFlowSoundAuditRequiresExplicitReviewAndAllowsInferredActionSound(t *testing.T) {
	source := productionFlowSource{ID: "s", Text: "林岚推开木门，走进照相馆。"}
	unit := model.ProductionFlowUnit{Stage: "omissions", SourceHash: "v1", InputJSON: productionFlowJSON(map[string]any{"sources": []productionFlowSource{source}}), ResultJSON: "{}"}
	candidate := productionFlowCandidate{LocalRef: "door", Label: "木门开启声", Kind: "sound", SourceRef: "s", Quote: "林岚推开木门", Action: "推开木门", Context: "照相馆入口", Basis: "inferred", Reason: "开门动作需要木门开启音效"}
	value := map[string]any{"candidates": []productionFlowCandidate{candidate}, "noAssetsReason": ""}
	_, issues := productionFlowValidate(unit, productionFlowJSON(value))
	if len(issues) == 0 {
		t.Fatal("sound audit silently skipped")
	}
	value["soundReview"] = "根据推门动作补充木门开启声，不把人物对白另列声音。"
	result, issues := productionFlowValidate(unit, productionFlowJSON(value))
	if len(issues) != 0 || !strings.Contains(result, "木门开启声") {
		t.Fatal(result, issues)
	}
}

func TestProductionFlowInventoryNumbersAreSequentialWithoutReassigningCodes(t *testing.T) {
	plan := productionPlan{Assets: []productionPlanAsset{
		{Key: "last", Kind: "character", Name: "后项", Identity: &productionAssetIdentity{Code: "CHR-D004-1000"}},
		{Key: "first", Kind: "character", Name: "前项", Identity: &productionAssetIdentity{Code: "CHR-D004-008"}},
		{Key: "middle", Kind: "character", Name: "中项", Identity: &productionAssetIdentity{Code: "CHR-D004-999"}},
		{Key: "room", Kind: "environment", Name: "房间", Identity: &productionAssetIdentity{Code: "SCN-D004-021"}},
	}}
	content, err := productionRenderPlanInventory(plan)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []string{"| 1 | CHR-D004-008 |", "| 2 | CHR-D004-999 |", "| 3 | CHR-D004-1000 |", "| 1 | SCN-D004-021 |"} {
		if !strings.Contains(content, row) {
			t.Fatal("missing sequential row", row)
		}
	}
	if plan.Assets[0].Identity.Code != "CHR-D004-1000" {
		t.Fatal("stable code changed")
	}
}

func TestProductionFlowIdentityLaterBatchesIncludeOriginalEvidence(t *testing.T) {
	source := productionFlowSource{ID: "source", Section: "plot"}
	for n := 0; n < 130; n++ {
		source.Text += fmt.Sprintf("第%d日账房在同一仓栈查验账册。", n)
	}
	g := productionFlowGraph{Existing: map[string]model.ProductionFlowUnit{}, Source: "version", Root: "inventory", RunID: "run", UserID: "user"}
	for turn := 0; turn < 6; turn++ {
		g.Units = nil
		productionFlowInventoryGraph(&g, []productionFlowSource{source})
		for _, unit := range g.Units {
			input := productionFlowInput(unit)
			if unit.Stage == "resolve" && input["existingEvidence"] != nil {
				var evidence map[string][]productionFlowCandidate
				_ = decodeFlowValue(input["existingEvidence"], &evidence)
				for _, examples := range evidence {
					if len(examples) == 3 && strings.Contains(source.Text, examples[0].Quote) && examples[0].Context == "同一仓栈同一岗位连续查账" {
						return
					}
				}
			}
			if unit.Status != "pending" {
				continue
			}
			value := flowReply(unit)
			if unit.Stage == "extract" {
				candidates := []productionFlowCandidate{}
				for n := 0; n < 130; n++ {
					candidates = append(candidates, productionFlowCandidate{LocalRef: string(rune('A' + n)), Label: "账房", Kind: "character", SourceRef: source.ID, Quote: fmt.Sprintf("第%d日账房在同一仓栈查验账册。", n), Action: "查账", Context: "同一仓栈同一岗位连续查账", Basis: "explicit", Reason: "实际行动者"})
				}
				refs := []string{}
				for _, c := range candidates {
					refs = append(refs, c.LocalRef)
				}
				value = map[string]any{"candidates": candidates, "noAssetsReason": "", "soundReview": "当前夹具无独立声音需求", "sourceReviews": []productionFlowSourceReview{{SourceRef: source.ID, Reason: "核对同一岗位连续行动"}}, "coverageReview": []productionFlowCoverage{
					{Kind: "character", Disposition: "added", Candidates: refs, Reason: "行动人物"},
					{Kind: "environment", Disposition: "none", Candidates: []string{}, Reason: "夹具仅测试人物身份"},
					{Kind: "prop", Disposition: "none", Candidates: []string{}, Reason: "夹具仅测试人物身份"},
					{Kind: "special", Disposition: "none", Candidates: []string{}, Reason: "夹具仅测试人物身份"},
					{Kind: "sound", Disposition: "none", Candidates: []string{}, Reason: "夹具仅测试人物身份"},
				}}
			}
			result, issues := productionFlowValidate(unit, productionFlowJSON(value))
			if len(issues) > 0 {
				t.Fatal(issues)
			}
			unit.Status, unit.ResultJSON = "accepted", result
			g.Existing[unit.ID] = unit
		}
	}
	t.Fatal("later identity batch lost original evidence")
}

func TestProductionFlowReconcileRejectsActiveRootWithoutChangingRegistry(t *testing.T) {
	s, _, id := flowFixture(t)
	run, state := productionRuntimeState(t, s, id)
	before, _, _ := orderedPlanState(t, s, id)
	if err := productionFlowPrepareInventoryReconcile(s.repo, run, &state); err == nil {
		t.Fatal("active root accepted a duplicate audit")
	}
	after, _, _ := orderedPlanState(t, s, id)
	if productionFlowJSON(before) != productionFlowJSON(after) {
		t.Fatal("rejected audit changed saved plan")
	}
}
