package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func flowFixture(t *testing.T, count ...int) (*Service, *gorm.DB, string) {
	t.Helper()
	s, db, run := planFixture(t, append([]int{5}, count...)...)
	mutateParallelState(t, s, run.ID, func(current *model.CloudAgentExecution, state *cloudAgentRuntime) {
		current.Status = "running"
		state.ProductionPaused = false
	})
	job, err := s.repo.ProductionAgentJob("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var m productionManifest
	_ = json.Unmarshal([]byte(job.ManifestJSON), &m)
	m.Plan.FlowVersion = 1
	m.Plan.ContinuityVersion = 0
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, productionFlowJSON(m)); err != nil {
		t.Fatal(err)
	}
	return s, db, run.ID
}
func flowGraph(t *testing.T, s *Service, runID, root string) (productionFlowGraph, bool) {
	t.Helper()
	run, state := productionRuntimeState(t, s, runID)
	_, m, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := s.repo.ProductionAgentArtifacts("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	g, done, err := s.productionFlowGraph(run, &state, m, doc, rows, root)
	if err != nil {
		t.Fatal(err)
	}
	for i := range g.Units {
		if err := s.repo.EnsureProductionFlowUnit(&g.Units[i]); err != nil {
			t.Fatal(err)
		}
	}
	return g, done
}

func flowReply(unit model.ProductionFlowUnit) any {
	input := productionFlowInput(unit)
	switch unit.Stage {
	case "registry":
		if input["kind"] != "character" {
			return map[string]any{"assets": []productionPlanningAsset{}, "absentReason": "离线夹具仅登记行动主角，其余类无独立需求"}
		}
		return map[string]any{"assets": []productionPlanningAsset{{Kind: "character", Name: "林岚", Aliases: []string{}, Purpose: "调查照片并寻找家人", CoreFacts: "照相馆的调查者", PlannedRange: "全剧", Variants: "无独立变体"}}, "absentReason": ""}
	case "cards":
		episodes := []any{}
		for n := int(numberValue(input["start"], 0)); n <= int(numberValue(input["end"], 0)); n++ {
			entry := map[string]any{"episode": n, "newAssets": []productionPlanningAsset{}}
			for _, f := range productionPlanningCardFields {
				entry[f.Key] = fmt.Sprintf("第%d集林岚在照相馆检查旧相机，认出照片中的家人后出门核对线索。", n)
			}
			var assets []productionPlanningAsset
			_ = decodeFlowValue(input["registry"], &assets)
			keys := []string{}
			for _, a := range assets {
				keys = append(keys, a.Key)
			}
			entry["assetKeys"] = keys
			episodes = append(episodes, entry)
		}
		return map[string]any{"episodes": episodes}
	case "arcs":
		return map[string]any{"arcs": []productionFlowArc{{Title: "归还相机", Start: 1, End: int(numberValue(input["episodeCount"], 3)), Entry: "林岚发现旧相机", Goal: "找到家人", Events: "她调查照片来源并找到家人", Exit: "她与家人团聚", Threads: "开场照片在第三集被解释"}}}
	case "review":
		return map[string]any{"issues": []any{}}
	case "extract", "omissions":
		var sources []productionFlowSource
		_ = decodeFlowValue(input["sources"], &sources)
		if unit.Stage == "omissions" {
			var covered []productionFlowCandidate
			_ = decodeFlowValue(input["covered"], &covered)
			rows := []productionFlowCoverage{}
			for _, kind := range productionCurrentPlanKinds {
				row := productionFlowCoverage{Kind: kind, Disposition: "none", Candidates: []string{}, Reason: "离线夹具中没有此类候选"}
				for _, c := range covered {
					if c.Kind == kind {
						row.Disposition = "covered"
						row.Candidates = append(row.Candidates, c.ID)
						row.Reason = "已由原候选覆盖"
					}
				}
				rows = append(rows, row)
			}
			return map[string]any{"candidates": []any{}, "noAssetsReason": "已逐项核对行动者、场景、使用物件与独立声音，无新增遗漏", "soundReview": "来源描述调查与人物关系，普通对白由人物档案处理，无需独立生成的环境声或物件声音。", "coverageReview": rows}
		}
		candidates := []productionFlowCandidate{}
		reviews := []productionFlowSourceReview{}
		refs := []string{}
		for i, src := range sources {
			ref := fmt.Sprintf("c%d", i)
			refs = append(refs, ref)
			candidates = append(candidates, productionFlowCandidate{LocalRef: ref, Label: "林岚", Kind: "character", SourceRef: src.ID, Quote: src.Text, Action: "调查旧相机", Context: "故事主角林岚", Basis: "explicit", Reason: "主角实际行动需要人物资产"})
			reviews = append(reviews, productionFlowSourceReview{SourceRef: src.ID, Candidates: []string{ref}, Reason: "离线夹具仅登记主角"})
		}
		result := map[string]any{"candidates": candidates, "noAssetsReason": ""}
		if input["coveragePolicy"] == "integrated-v2" {
			coverage := []productionFlowCoverage{}
			for _, kind := range productionCurrentPlanKinds {
				row := productionFlowCoverage{Kind: kind, Disposition: "none", Candidates: []string{}, Reason: "离线夹具没有此类需求"}
				if kind == "character" {
					row.Disposition, row.Candidates = "added", refs
				}
				coverage = append(coverage, row)
			}
			result["coverageReview"], result["sourceReviews"], result["soundReview"] = coverage, reviews, "离线夹具没有独立声音需求"
		}
		return result
	case "resolve":
		var assigned []productionFlowCandidate
		_ = decodeFlowValue(input["assignedCandidates"], &assigned)
		members := []string{}
		for _, c := range assigned {
			members = append(members, c.ID)
		}
		existing := ""
		var prior []productionFlowEntity
		_ = decodeFlowValue(input["existingEntities"], &prior)
		if len(prior) > 0 {
			existing = prior[0].ID
		}
		return map[string]any{"entities": []productionFlowEntity{{Name: "林岚", Members: members, Existing: existing, Disposition: "asset", Reason: "原文均指同一主角"}}}
	case "identity":
		var entities []productionFlowEntity
		_ = decodeFlowValue(input["entities"], &entities)
		groups := []productionFlowIdentityGroup{}
		for _, e := range entities {
			groups = append(groups, productionFlowIdentityGroup{Canonical: e.ID, Members: []string{e.ID}, Reason: "离线夹具保持不同身份", Purpose: "参与故事行动", Evidence: []productionFlowEvidence{}})
		}
		return map[string]any{"groups": groups}
	}
	entry := map[string]string{}
	for _, key := range productionFlowUnitFields(unit) {
		entry[key] = "林岚在照相馆检查旧相机并从照片中认出家人，她追查来源并最终与家人团聚。"
	}
	return entry
}

// Uses the real settlement transaction and task result contract without calling
// any provider. Every intermediate result can be reloaded from the database.
func settleFlowReply(t *testing.T, s *Service, db *gorm.DB, runID string, unit model.ProductionFlowUnit, value any, expectedStatus ...string) {
	t.Helper()
	priorTask, priorGeneration := unit.TaskID, unit.Generation
	unit.TaskID = newID()
	unit.Generation++
	unit.Attempts++
	unit.Status = "running"
	if err := s.repo.SaveProductionFlowUnit(&unit, priorTask, priorGeneration); err != nil {
		t.Fatal(err)
	}
	work := productionParallelWork{Key: unit.Key, Name: unit.Name, FlowUnitID: unit.ID, TaskID: unit.TaskID, Generation: unit.Generation}
	mutateParallelState(t, s, runID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		if state.ProductionParallel == nil {
			state.ProductionParallel = map[string]productionParallelWork{}
		}
		state.ProductionParallel[unit.Key] = work
		state.TaskIDs = append(state.TaskIDs, unit.TaskID)
	})
	call := cloudAgentCall{}
	call.Function.Name = productionFlowTool
	call.Function.Arguments = productionFlowJSON(value)
	task := &model.Task{ID: unit.TaskID, UserID: "user", Status: model.TaskStatusSucceeded, ResultJSON: productionFlowJSON(map[string]any{"toolCalls": []cloudAgentCall{call}})}
	if err := db.Create(task).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.settleProductionFlow("user", runID, work, task); err != nil {
		t.Fatal(err)
	}
	saved, err := s.repo.ProductionFlowUnit("user", runID, unit.ID)
	if err != nil {
		t.Fatal(err)
	}
	wantStatus := "accepted"
	if len(expectedStatus) > 0 {
		wantStatus = expectedStatus[0]
	}
	if saved.Status != wantStatus {
		t.Fatalf("%s: %s %s", unit.Stage, saved.Status, saved.IssuesJSON)
	}
	before, _ := s.repo.ProductionFlowReceipts("user", runID, unit.ID)
	if err := s.settleProductionFlow("user", runID, work, task); err != nil {
		t.Fatal(err)
	}
	after, _ := s.repo.ProductionFlowReceipts("user", runID, unit.ID)
	if len(before) == 0 || len(after) != len(before) {
		t.Fatal("duplicate receipt was adopted")
	}
}

func TestProductionFlowStoryInventoryDurableEndToEnd(t *testing.T) {
	s, db, runID := flowFixture(t)
	for _, root := range []string{"story", "inventory"} {
		for iteration := 0; iteration < 25; iteration++ {
			g, done := flowGraph(t, s, runID, root)
			if done {
				if root == "inventory" && (g.Catalog == nil || len(g.Units) != 1 || g.Units[0].Stage != "catalog" || g.Units[0].Status != "accepted") {
					t.Fatal("structured inventory must be assembled locally, without extraction model jobs")
				}
				run, state := productionRuntimeState(t, s, runID)
				_, m, doc, err := productionLoad(s.repo, run, &state)
				if err != nil {
					t.Fatal(err)
				}
				rows, _ := s.repo.ProductionAgentArtifacts("user", runID)
				if err := s.publishProductionFlow(run, &state, m, doc, rows, g); err != nil {
					t.Fatalf("%s publication: %v", root, err)
				}
				_, updated, canvas, err := productionLoad(s.repo, run, &state)
				if err != nil {
					t.Fatal(err)
				}
				rows, _ = s.repo.ProductionAgentArtifacts("user", runID)
				if !productionPlanArtifactValid(updated, canvas, rows, root) {
					t.Fatalf("%s not usable downstream", root)
				}
				break
			}
			progress := false
			for _, u := range g.Units {
				if u.Status == "pending" {
					settleFlowReply(t, s, db, runID, u, flowReply(u))
					progress = true
				}
			}
			if !progress || iteration == 24 {
				t.Fatal("graph stalled")
			}
		}
	}
	run, state := productionRuntimeState(t, s, runID)
	_, m, doc, _ := productionLoad(s.repo, run, &state)
	rows, _ := s.repo.ProductionAgentArtifacts("user", runID)
	if len(m.Plan.FlowStoryUnits) == 0 || len(m.Plan.Assets) != 1 || m.Plan.Assets[0].Identity == nil {
		t.Fatal("missing structured publication or server identity")
	}
	if m.Plan.Assets[0].CoreFacts == "" || m.Plan.InventoryReviewVersion != 0 || m.Plan.StoryStructureVersion != 3 {
		t.Fatal("planning identity constraints or adopted template flags were lost")
	}
	context, err := productionPlanContext(s.repo, run, m, doc)
	if err != nil {
		t.Fatal(err)
	}
	index := context["registeredAssets"].([]map[string]any)
	if len(index) != 1 || index[0]["coreFacts"] != m.Plan.Assets[0].CoreFacts {
		t.Fatal("downstream design did not receive the compact identity constraints")
	}
	_, bodies, err := productionFlowPublishedSources(s.repo, run, m, doc, rows)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(bodies["episodeArchitecture/EP-001"], "第1集林岚") {
		t.Fatal("detailed episode text missing from inventory sources")
	}
	progress := s.productionFlowProgress("user", runID, &state, m, doc, rows)
	if progress == nil || progress.Accepted != progress.Total {
		t.Fatal("snapshot cannot reconstruct progress")
	}
}

func TestProductionFlowPartialFieldsAndLocalNormalization(t *testing.T) {
	u := model.ProductionFlowUnit{Key: "flow/story/foundation", Stage: "foundation", InputJSON: "{}", ResultJSON: "{}"}
	raw := "\ufeff" + productionFlowJSON(map[string]any{"premise": "## 核心\n林岚找回家人。", "worldRules": 15})
	result, issues := productionFlowValidate(u, raw)
	if len(issues) != 1 || !strings.Contains(productionFlowString(productionFlowObject(result)["premise"]), "林岚找回家人。") {
		t.Fatalf("valid siblings lost: %s %+v", result, issues)
	}
	u.ResultJSON = result
	result, issues = productionFlowValidate(u, productionFlowJSON(map[string]any{"worldRules": "旧相机只能在被拍摄者主动回忆时触发。"}))
	if len(issues) != 0 || !strings.Contains(productionFlowString(productionFlowObject(result)["premise"]), "### 核心") {
		t.Fatalf("targeted repair failed: %s %+v", result, issues)
	}
	_, issues = productionFlowValidate(u, "{\"ending\":")
	if len(issues) != 1 {
		t.Fatal("truncated JSON accepted")
	}
}

func TestProductionFlowCandidateEvidenceKeepsAmbiguousOffsets(t *testing.T) {
	src := productionFlowSource{ID: "source", Text: "林岚看照片。林岚看照片。"}
	u := model.ProductionFlowUnit{Stage: "extract", SourceHash: "v1", InputJSON: productionFlowJSON(map[string]any{"sources": []productionFlowSource{src}}), ResultJSON: "{}"}
	c := productionFlowCandidate{LocalRef: "a", Label: "照片", Kind: "prop", SourceRef: "source", Quote: "林岚看照片", Basis: "explicit", Action: "查看", Context: "馆内同一照片", Reason: "线索"}
	bad := c
	bad.LocalRef = "b"
	bad.Quote = "不存在的引文"
	result, issues := productionFlowValidate(u, productionFlowJSON(map[string]any{"candidates": []productionFlowCandidate{c, bad}, "noAssetsReason": ""}))
	var adopted []productionFlowCandidate
	_ = decodeFlowValue(productionFlowValue(model.ProductionFlowUnit{ResultJSON: result})["candidates"], &adopted)
	if len(issues) != 1 || len(adopted) != 1 || len(adopted[0].Locations) != 2 || adopted[0].Locations[1].Start != len("林岚看照片。") {
		t.Fatalf("%s %+v", result, issues)
	}
}

func TestProductionFlowReviewNeedsEvidenceAndCorrectTarget(t *testing.T) {
	input := map[string]any{"sources": map[string]any{"flow/story/world": map[string]any{"worldRules": "照片只能使用一次。"}, "flow/story/episode/0001": map[string]any{"storyText": "她再次使用同一照片。"}}}
	u := model.ProductionFlowUnit{Stage: "review", InputJSON: productionFlowJSON(input), ResultJSON: "{}"}
	issue := productionFlowIssue{Rule: "once", Target: "flow/story/episode/0001", Message: "重复使用", Action: "保留单次机会", Severity: "blocking", Evidence: []productionFlowEvidence{{Ref: "flow/story/world", Quote: "照片只能使用一次。"}}}
	result, failures := productionFlowValidate(u, productionFlowJSON(map[string]any{"issues": []productionFlowIssue{issue}}))
	if len(failures) > 0 || !strings.Contains(result, "advisory") {
		t.Fatal("unproven finding blocked content")
	}
	issue.Evidence = append(issue.Evidence, productionFlowEvidence{Ref: "flow/story/episode/0001", Quote: "她再次使用同一照片。"})
	result, failures = productionFlowValidate(u, productionFlowJSON(map[string]any{"issues": []productionFlowIssue{issue}}))
	if len(failures) > 0 || !strings.Contains(result, "blocking") {
		t.Fatal("evidenced contradiction lost")
	}
}

func TestProductionFlowLeaseFenceAndUserIsolation(t *testing.T) {
	s, _, runID := flowFixture(t)
	g, _ := flowGraph(t, s, runID, "story")
	u := g.Units[0]
	if _, err := s.repo.ProductionFlowUnit("another-user", runID, u.ID); err == nil {
		t.Fatal("cross-user unit read")
	}
	oldTask, oldGen := u.TaskID, u.Generation
	u.Generation++
	u.TaskID = "new-task"
	u.Status = "running"
	if err := s.repo.SaveProductionFlowUnit(&u, oldTask, oldGen); err != nil {
		t.Fatal(err)
	}
	u.Status = "accepted"
	if err := s.repo.SaveProductionFlowUnit(&u, oldTask, oldGen); err != repository.ErrCreationConflict {
		t.Fatalf("old lease accepted: %v", err)
	}
}
