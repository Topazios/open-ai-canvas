package app

import (
	"fmt"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func productionFlowStoryDocument(g productionFlowGraph, m productionManifest, doc map[string]any) (map[string]string, error) {
	fields := map[string]string{}
	for key, value := range productionFlowGlobal(g.Units) {
		fields[key] = stringValue(value)
	}
	parameters, _ := productionWorkflow(productionNode(doc, m.FrameID))["parameters"].(map[string]any)
	count := int(numberValue(parameters["episodeCount"], 0))
	fields["facts"] = fmt.Sprintf("依据本次选题与项目设定创作。计划总集数：%d；单集时长：%s。总纲确定主线、结局、规则和每集任务，具体场次与完整剧情由分集大纲和正文展开。", count, productionFlowJSON(parameters["minutesPerEpisode"]))
	arcLines := []string{"| 单元 | 集数 | 阶段任务 |", "|---|---|---|"}
	for _, unit := range g.Units {
		if unit.Stage != "arcs" || productionFlowInput(unit)["parentUnitId"] != nil {
			continue
		}
		var arcs []productionFlowArc
		_ = decodeFlowValue(productionFlowValue(unit)["arcs"], &arcs)
		for i, a := range arcs {
			arcLines = append(arcLines, fmt.Sprintf("| %d. %s | %d—%d | %s |", i+1, productionEpisodeTableCell(a.Title), a.Start, a.End, productionEpisodeTableCell(a.Goal)))
		}
	}
	fields["arcs"] = strings.Join(arcLines, "\n")
	cards := productionPlanningCards(g.Units)
	if len(cards) != count {
		return nil, BadAuthRequest("每集任务卡尚未完整覆盖计划集数，未发布残缺总纲")
	}
	plan, redirects, err := productionPlanningInventoryResolved(g.Units, g.Source)
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	for _, a := range plan.Assets {
		names[a.Key] = a.Name
	}
	columns := []string{"集号"}
	separators := []string{"---"}
	for _, f := range productionPlanningCardFields {
		columns = append(columns, f.Title)
		separators = append(separators, "---")
	}
	columns = append(columns, "引用资产")
	separators = append(separators, "---")
	lines := []string{"| " + strings.Join(columns, " | ") + " |", "|" + strings.Join(separators, "|") + "|"}
	for i, c := range cards {
		if c.Episode != i+1 {
			return nil, BadAuthRequest("每集任务卡集号不连续或重复")
		}
		row := []string{fmt.Sprintf("EP-%03d", c.Episode)}
		var value map[string]any
		_ = decodeFlowValue(c, &value)
		for _, f := range productionPlanningCardFields {
			row = append(row, productionEpisodeTableCell(stringValue(value[f.Key])))
		}
		refs := []string{}
		for _, key := range c.AssetKeys {
			if canonical := redirects[key]; canonical != "" {
				key = canonical
			}
			refs = append(refs, names[key]+"（"+key+"）")
		}
		row = append(row, productionEpisodeTableCell(strings.Join(refs, "；")))
		lines = append(lines, "| "+strings.Join(row, " | ")+" |")
	}
	fields["episodeArchitecture"] = strings.Join(lines, "\n")
	fields["coreAssets"] = fmt.Sprintf("已登记%d项基础资产。以下按类别逐项列出全部名称、简介、用途及必要变体；同一主体的年龄、形态或破损变化列在变体栏，不计为新身份，也不代表所需制作图片数量。\n\n", len(plan.Assets)) + strings.Join(productionPlanningAssetTables(plan, false), "\n")
	return fields, nil
}

func productionFlowInventoryPlan(g productionFlowGraph, m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) (productionPlan, error) {
	if g.Catalog != nil {
		return *g.Catalog, nil
	}
	sections, bodies := productionInventoryReviewSources(*m.Plan, productionInventoryStory(doc, artifacts))
	sources := productionFlowSources(g.Source, sections, bodies)
	sourceByID := map[string]productionFlowSource{}
	for _, src := range sources {
		sourceByID[src.ID] = src
	}
	candidates := productionFlowCandidates(g.Units)
	entities := productionFlowEntities(g.Units)
	entityByCandidate := map[string]productionFlowEntity{}
	for _, e := range entities {
		for _, id := range e.Members {
			entityByCandidate[id] = e
		}
	}
	assets := map[string]productionPlanAsset{}
	importance := map[string]int{}
	purposes := map[string][]string{}
	fragments := map[string]map[string]bool{}
	for _, e := range entities {
		importance["entity-"+e.ID] = map[string]int{"primary": 0, "secondary": 1, "supporting": 2}[e.Importance]
	}
	reviews := map[string]*productionInventorySectionReview{}
	ledgerIndex := map[string]int{}
	ledgerReasons := map[string]map[string]bool{}
	for _, section := range sections {
		reviews[section] = &productionInventorySectionReview{Section: section, Requirements: []productionInventoryRequirement{}}
	}
	for _, c := range candidates {
		e, ok := entityByCandidate[c.ID]
		if !ok {
			return productionPlan{}, BadAuthRequest("候选尚未归并：" + c.Label)
		}
		src, ok := sourceByID[c.SourceRef]
		if !ok {
			return productionPlan{}, BadAuthRequest("候选来源版本不存在：" + c.Label)
		}
		key := "entity-" + e.ID
		if e.Disposition == "excluded" {
			key = ""
		}
		// Formal codes remain server-reserved; the candidate identity is stable
		// independently of its display name and ordering.
		if key != "" {
			item := assets[key]
			if item.Key == "" {
				item = productionPlanAsset{Key: key, Kind: e.Kind, Name: e.Name, Purpose: e.Purpose, PlannedRange: "总纲明确涉及：" + src.Section, Episodes: []int{}, DependsOn: []string{}, SubjectKeys: []string{}}
				fragments[key] = map[string]bool{}
			}
			if src.Episode > 0 && !containsProductionEpisode(item.Episodes, src.Episode) {
				item.Episodes = append(item.Episodes, src.Episode)
			}
			if item.Purpose == "" && len(purposes[key]) < 3 && !fragments[key][c.Action] {
				fragments[key][c.Action] = true
				purposes[key] = append(purposes[key], c.Action)
			}
			for _, field := range []struct {
				refs []string
				keys *[]string
			}{{c.SubjectRefs, &item.SubjectKeys}, {c.DependsOnRefs, &item.DependsOn}} {
				for _, ref := range field.refs {
					related, exists := entityByCandidate[ref]
					if !exists || related.Disposition == "excluded" {
						return productionPlan{}, BadAuthRequest("资产关联未完成有效身份归并：" + c.Label)
					}
					otherKey := "entity-" + related.ID
					if otherKey != key && !cloudAgentContainsString(*field.keys, otherKey) {
						*field.keys = append(*field.keys, otherKey)
					}
				}
			}
			assets[key] = item
		}
		quote := c.Quote
		// The compatibility evidence ledger uses the rendered source. New flow
		// candidates retain exact byte locations and every ambiguous occurrence.
		if !strings.Contains(bodies[src.Section], quote) {
			return productionPlan{}, BadAuthRequest("原文引文版本不一致：" + c.Label)
		}
		disposition := e.Disposition
		reason := e.Reason
		// Keep detailed state and alias evidence in the ledger, not the main
		// index cell that every downstream reader has to load.
		reason += "；行动：" + c.Action
		if c.State != "" {
			reason += "；状态：" + c.State
		}
		if c.Label != e.Name {
			reason += "；原文称呼：" + c.Label
		}
		if c.Basis == "inferred" {
			reason = "制作推导：" + c.Reason + "；" + reason
		}
		ledgerKey := productionFlowJSON([]string{src.Section, key, disposition, quote})
		if key == "" {
			ledgerKey += c.ID
		}
		if n, exists := ledgerIndex[ledgerKey]; exists {
			if !ledgerReasons[ledgerKey][reason] {
				reviews[src.Section].Requirements[n].Reason += "；" + reason
				ledgerReasons[ledgerKey][reason] = true
			}
		} else {
			ledgerIndex[ledgerKey] = len(reviews[src.Section].Requirements)
			ledgerReasons[ledgerKey] = map[string]bool{reason: true}
			reviews[src.Section].Requirements = append(reviews[src.Section].Requirements, productionInventoryRequirement{Subject: c.Label, Quote: quote, AssetKey: key, Disposition: disposition, Reason: reason})
		}
	}
	result := productionPlan{FlowVersion: 1, StoryHash: g.Source, Absent: map[string]string{}, Complete: true}
	keys := []string{}
	for key := range assets {
		keys = append(keys, key)
	}
	sort.SliceStable(keys, func(i, j int) bool {
		if importance[keys[i]] != importance[keys[j]] {
			return importance[keys[i]] < importance[keys[j]]
		}
		return keys[i] < keys[j]
	})
	ranks := map[string]int{}
	for _, key := range keys {
		item := assets[key]
		if item.Purpose == "" {
			item.Purpose = strings.Join(purposes[key], "；")
		}
		ranks[item.Kind]++
		item.Priority = ranks[item.Kind]
		sort.Ints(item.Episodes)
		if len(item.Episodes) > 0 {
			item.PlannedRange = productionInventoryEpisodes(item.Episodes)
		}
		result.Assets = append(result.Assets, item)
	}
	for _, kind := range planKinds(m) {
		if ranks[kind] == 0 {
			result.Absent[kind] = "已完成来源提取与分类覆盖核对，当前总纲未发现需要独立登记的此类制作需求"
		}
	}
	for _, section := range sections {
		review := reviews[section]
		if len(review.Requirements) == 0 {
			review.NoAssetsReason = "本节来源提取与覆盖核对已完成，未识别独立制作需求"
		}
		result.InventoryReview = append(result.InventoryReview, *review)
	}
	return result, nil
}
func containsProductionEpisode(episodes []int, n int) bool {
	for _, v := range episodes {
		if v == n {
			return true
		}
	}
	return false
}

func (s *Service) publishProductionFlow(run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, g productionFlowGraph) error {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	return s.repo.MutateCloudAgent(run.UserID, run.ID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		fresh, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		if fresh.ProductionPaused || cloudAgentRunTerminal(current.Status) || current.Status == "waiting_user" {
			return repository.ErrCreationConflict
		}
		if err := productionFlowFence(fresh, *state); err != nil {
			return err
		}
		_, manifest, document, err := productionLoad(repo, current, &fresh)
		if err != nil {
			return err
		}
		rows, err := repo.ProductionAgentArtifacts(run.UserID, run.ID)
		if err != nil {
			return err
		}
		if productionFlowSourceHash(manifest, g.Root, rows) != g.Source {
			return productionPlanConflict("发布时来源已变化，保留原版本草稿")
		}
		for _, unit := range g.Units {
			saved, err := repo.ProductionFlowUnit(run.UserID, run.ID, unit.ID)
			if err != nil {
				return err
			}
			if saved.Status != "accepted" || saved.Generation != unit.Generation || saved.ResultJSON != unit.ResultJSON {
				return repository.ErrCreationConflict
			}
		}
		if g.Root == "story" {
			// Only an adopted structured plan replaces text-evidence contracts.
			// Imported/manual documents still need their source review guards.
			manifest.Plan.ContinuityVersion = 0
			manifest.Plan.StoryStructureVersion = 3
			manifest.Plan.InventoryReviewVersion = 0
			manifest.Plan.FlowStoryUnits = nil
			for _, unit := range g.Units {
				if unit.Stage != "review" && productionFlowInput(unit)["parentUnitId"] == nil {
					manifest.Plan.FlowStoryUnits = append(manifest.Plan.FlowStoryUnits, unit.ID)
				}
			}
			if err := repo.UpdateProductionAgentManifest(run.UserID, run.ID, productionFlowJSON(manifest)); err != nil {
				return err
			}
			fields, err := productionFlowStoryDocument(g, manifest, document)
			if err != nil {
				return err
			}
			content, err := productionRenderPlanDocumentForSchema("story", "", fields, productionPlanSchemaVersion(*manifest.Plan))
			if err != nil {
				return err
			}
			section, _ := planSection("story")
			if _, err := productionSubmit(repo, current, &fresh, manifest, document, "story", section.Title, content, []string{}, productionDocumentTargetHash(rows, "story"), nil, fields, policy); err != nil {
				return err
			}
		} else {
			plan, err := productionFlowInventoryPlan(g, manifest, document, rows)
			if err != nil {
				return err
			}
			call := cloudAgentCall{}
			call.Function.Name = "production_plan_inventory"
			call.Function.Arguments = productionFlowJSON(plan)
			if _, err := productionPlanInventory(repo, current, &fresh, manifest, document, call, policy); err != nil {
				return err
			}
		}
		for key, work := range fresh.ProductionParallel {
			if work.FlowUnitID != "" {
				delete(fresh.ProductionParallel, key)
			}
		}
		fresh.event(run.ID, "production_flow_published", map[string]any{"root": g.Root, "sourceVersion": g.Source, "unitCount": len(g.Units), "text": "已从持久成果汇总发布，汇总未再次调用模型"})
		return cloudAgentSave(current, &fresh)
	})
}
