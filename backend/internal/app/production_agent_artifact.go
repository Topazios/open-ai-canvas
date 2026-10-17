package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func productionContentSignature(content string) string {
	hash := uint32(2166136261)
	for _, r := range utf16.Encode([]rune(content)) {
		hash = (hash ^ uint32(r)) * 16777619
	}
	return fmt.Sprintf("%x", hash)
}
func productionArtifactHash(node map[string]any) string {
	meta, _ := node["metadata"].(map[string]any)
	return productionStoredValueHash([]any{node["title"], node["parentId"], meta["content"], meta["shortDrama"]})
}

func productionStoredValueHash(value any) string {
	// Typed design fields serialize in struct order; persisted maps serialize
	// in key order. Normalize before hashing so a save is not a manual edit.
	encoded, _ := json.Marshal(value)
	var normalized any
	_ = json.Unmarshal(encoded, &normalized)
	return productionHash(normalized)
}

func productionArtifactMatches(node map[string]any, expected string) bool {
	if productionArtifactHash(node) == expected {
		return true
	}
	// Verify only the historical writer's struct ordering; never ignore fields
	// or overwrite the receipt to accept an arbitrary edited document.
	encoded, _ := json.Marshal(node)
	var copy map[string]any
	if json.Unmarshal(encoded, &copy) != nil {
		return false
	}
	meta, _ := copy["metadata"].(map[string]any)
	profile, _ := productionWorkflow(copy)["assetProfile"].(map[string]any)
	if profile == nil {
		return false
	}
	encoded, _ = json.Marshal(profile["variants"])
	var variants []productionDesignVariant
	if json.Unmarshal(encoded, &variants) != nil {
		return false
	}
	profile["variants"] = variants
	return productionHash([]any{copy["title"], copy["parentId"], meta["content"], meta["shortDrama"]}) == expected
}

func productionTargetHash(node map[string]any) string {
	meta, _ := node["metadata"].(map[string]any)
	data := productionWorkflow(node)
	return productionHash([]any{node["title"], node["parentId"], meta["content"], data["step"], data["pipelineId"], data["sourceNodeIds"], data["sourceSignatures"], data["parameters"]})
}

type productionDesignVariant struct {
	Code        string `json:"code,omitempty"`
	Name        string `json:"name"`
	Description string `json:"description"`
}
type productionDesignFields struct {
	Variants  []productionDesignVariant `json:"variants"`
	Sounds    []string                  `json:"sounds"`
	Conflicts []string                  `json:"conflicts"`
}

func productionSubmit(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, key, name, content string, factIDs []string, expected string, design *productionDesignFields, policy RuntimePolicySetting) (any, error) {
	if design != nil {
		if len(design.Variants) > 200 || len(design.Sounds) > 200 || len(design.Conflicts) > 200 {
			return nil, BadAuthRequest("结构化资产字段超过预算")
		}
		for _, v := range design.Variants {
			if strings.TrimSpace(v.Name) == "" || strings.TrimSpace(v.Description) == "" {
				return nil, BadAuthRequest("变体需要名称和描述")
			}
		}
	}
	key, name, content = strings.TrimSpace(key), strings.TrimSpace(name), strings.TrimSpace(content)
	_, planDocument := planSection(key)
	if m.Plan != nil && !(planDocument && (key == "story" || m.Plan.Version >= 2)) {
		item := productionPlanItem(m, key)
		if item == nil || item.Name != name {
			return nil, BadAuthRequest("请先登记资产清单并沿用该资产 key/name")
		}
	}
	if m.Plan != nil && len(factIDs) != 0 {
		return nil, BadAuthRequest("计划资产不能冒充正文证据，factIds 应为空")
	}
	// The catalog is generated locally from bounded registration batches; its
	// aggregate size is governed by canvas/storage admission, not model output.
	systemInventory := m.Plan != nil && m.Plan.Version >= 2 && key == "inventory"
	if key == "" || name == "" || content == "" || utf8.RuneCountInString(key) > 120 || utf8.RuneCountInString(name) > 120 || (!systemInventory && utf8.RuneCountInString(content) > 12000) || len(factIDs) > 256 {
		return nil, BadAuthRequest("资产缺少 key/name/content 或超过单项预算")
	}
	if m.Category == "bible" && !cloudAgentContainsString(productionBibleKeys(m), key) {
		return nil, BadAuthRequest("制作规范 key 必须来自 production_status.bibleSections")
	}
	missing := productionDocumentMissing(m.Category, key, content)
	if m.Plan != nil && m.Plan.Version >= 2 {
		missing = productionPlanDocumentMissing(key, productionPlanKind(m, key), content)
	}
	if len(missing) > 0 {
		return nil, cloudAgentFieldError("document", "missing_sections", "请用 document 补齐统一文稿字段后重新提交："+strings.Join(missing, ", ")+"；人物需完整声线描述。未写入残缺资产。")
	}
	artifacts, err := repo.ProductionAgentArtifacts(run.UserID, run.ID)
	if err != nil {
		return nil, err
	}
	if m.Plan != nil && m.Plan.Version >= 2 {
		if err := productionPlanPrerequisites(m, doc, artifacts, key); err != nil {
			return nil, err
		}
	}
	var receipt *model.ProductionAgentArtifact
	for i := range artifacts {
		if artifacts[i].Key == key {
			receipt = &artifacts[i]
		}
	}
	if design != nil {
		previous := productionDesignFields{Variants: []productionDesignVariant{}, Sounds: []string{}, Conflicts: []string{}}
		if receipt != nil {
			encoded, _ := json.Marshal(productionWorkflow(productionNode(doc, receipt.NodeID))["assetProfile"])
			_ = json.Unmarshal(encoded, &previous)
		}
		if design.Variants == nil {
			design.Variants = previous.Variants
		}
		if design.Sounds == nil {
			design.Sounds = previous.Sounds
		}
		if design.Conflicts == nil {
			design.Conflicts = previous.Conflicts
		}
		for i := range design.Variants {
			design.Variants[i].Code = ""
			for _, variant := range previous.Variants {
				if variant.Name == design.Variants[i].Name {
					design.Variants[i].Code = variant.Code
				}
			}
		}
	}
	// factIds is a bounded delta, not the full history. Keep old evidence even
	// after hundreds of episodes, without asking the model to resend it all.
	if receipt != nil {
		merged := productionIDs(json.RawMessage(receipt.FactIDsJSON))
		for _, id := range factIDs {
			if !cloudAgentContainsString(merged, id) {
				merged = append(merged, id)
			}
		}
		factIDs = merged
	}
	facts, _, _, err := productionFacts(repo, run.UserID, m)
	if err != nil {
		return nil, err
	}
	byID := map[string]productionFact{}
	for _, f := range facts {
		byID[f.ID] = f
	}
	occurrences := []map[string]any{}
	categoryKind := productionCategoryKind(m.Category)
	identity := m.Assets[key]
	if identity == nil {
		identity = productionSourceAsset(m, doc, key)
	}
	if identity != nil {
		if categoryKind != "" && categoryKind != identity.Kind {
			return nil, BadAuthRequest("资产编码类别与当前制作类别不一致")
		}
		for _, source := range m.Sources {
			if source.OnDemand && source.AssetIdentity != nil && source.AssetIdentity.ID == identity.ID {
				for _, page := range source.Pages {
					if !m.Read[page] {
						return nil, BadAuthRequest("请先读取该资产原有设定，再进行正文校核与补充")
					}
				}
			}
		}
		categoryKind = identity.Kind
	}
	if m.Category == "reconcile" && categoryKind == "" {
		for _, id := range factIDs {
			if f, ok := byID[id]; ok && productionAssetPrefixes[f.Kind] != "" {
				categoryKind = f.Kind
				break
			}
		}
	}
	categoryEvidence := m.Category == "bible"
	aliases := []string{}
	seen := map[string]bool{}
	for _, id := range factIDs {
		fact, ok := byID[id]
		if !ok || seen[id] {
			return nil, BadAuthRequest("factIds 包含未知或重复事实")
		}
		seen[id] = true
		categoryEvidence = categoryEvidence || fact.Kind == categoryKind
		aliases = append(aliases, fact.Aliases...)
		if fact.Episode > 0 {
			occurrences = append(occurrences, map[string]any{"episode": fact.Episode, "scene": fact.Scene, "state": fact.Description, "owner": "待确认", "location": "待确认", "evidence": fact.Evidence})
		}
	}
	if len(factIDs) == 0 && m.Plan == nil {
		return nil, BadAuthRequest("资产必须关联正文证据；无此类资产时请直接做覆盖检查")
	}
	if !categoryEvidence && m.Plan == nil {
		return nil, BadAuthRequest("该资产缺少本类别的正文事实，不根据风格或建议虚构资产")
	}
	if m.Plan == nil && m.Category != "bible" && identity == nil {
		identity, err = newProductionAssetIdentity(repo, run, state.Request.CanvasID, categoryKind)
		if err != nil {
			return nil, err
		}
	}
	if m.Plan == nil && identity != nil && m.Assets[key] == nil {
		if m.Assets == nil {
			m.Assets = map[string]*productionAssetIdentity{}
		}
		m.Assets[key] = identity
		encoded, _ := json.Marshal(m)
		if err := repo.UpdateProductionAgentManifest(run.UserID, run.ID, string(encoded)); err != nil {
			return nil, err
		}
	}
	for _, a := range artifacts {
		if a.Key != key {
			node := productionNode(doc, a.NodeID)
			other, _ := productionWorkflow(node)["assetIdentity"].(map[string]any)
			if identity != nil && other["id"] == identity.ID {
				return nil, BadAuthRequest("该资产已保存，请使用原 key 和 expectedHash 增量修订")
			}
			_, existingPlanDocument := planSection(a.Key)
			separatePlanNamespace := m.Plan != nil && (planDocument || existingPlanDocument)
			if !separatePlanNamespace && strings.EqualFold(strings.TrimSpace(stringValue(node["title"])), name) {
				return nil, BadAuthRequest("同名资产已有节点，请复用稳定 key 修订")
			}
		}
	}
	canvas, err := repo.CanvasProjectForUser(run.UserID, state.Request.CanvasID)
	if err != nil {
		return nil, err
	}
	before := canvas.PayloadJSON
	nodes := creationMaps(doc["nodes"])
	parentID := productionPlanParent(m, key)
	frame := productionNode(doc, parentID)
	if frame == nil {
		return nil, BadAuthRequest("资产目标分组已删除，未重新创建")
	}
	target := productionNode(doc, state.Request.Production.TargetNodeID)
	data := productionWorkflow(target)
	nodeID := "pa-" + productionHash([]string{run.ID, key})[:32]
	var node map[string]any
	if receipt != nil {
		node = productionNode(doc, receipt.NodeID)
		if node == nil {
			return nil, BadAuthRequest("资产已删除，未重复创建")
		}
		if !productionArtifactMatches(node, receipt.ContentHash) {
			return nil, BadAuthRequest("资产已人工修改或移出，未覆盖；请生成新的候选版本")
		}
		meta, _ := node["metadata"].(map[string]any)
		oldProfile, _ := productionWorkflow(node)["assetProfile"].(map[string]any)
		matchingDesign := design == nil || productionStoredValueHash([]any{oldProfile["variants"], oldProfile["sounds"], oldProfile["conflicts"]}) == productionStoredValueHash([]any{design.Variants, design.Sounds, design.Conflicts})
		matchingInputs := m.Plan == nil || m.Plan.Version < 2 || productionStoredValueHash(productionWorkflow(node)["planDependencies"]) == productionStoredValueHash(productionPlanDependencies(m, artifacts, key))
		if matchingInputs && matchingDesign && meta["content"] == content && node["title"] == name && productionHash(productionIDs(json.RawMessage(receipt.FactIDsJSON))) == productionHash(factIDs) {
			return map[string]any{"nodeId": receipt.NodeID, "hash": receipt.ContentHash, "reused": true}, nil
		}
		if expected != receipt.ContentHash {
			return nil, BadAuthRequest("修订资产需要当前回执 expectedHash")
		}
		for _, id := range productionIDs(json.RawMessage(receipt.FactIDsJSON)) {
			if !seen[id] {
				return nil, BadAuthRequest("增量修订不得丢弃已有事实引用")
			}
		}
	} else {
		if productionNode(doc, nodeID) != nil {
			return nil, BadAuthRequest("节点标识冲突，未覆盖")
		}
		position, _ := frame["position"].(map[string]any)
		x, _ := position["x"].(float64)
		y, _ := position["y"].(float64)
		index := 0
		for _, existing := range nodes {
			if existing["parentId"] == parentID && productionWorkflow(existing)["assetKey"] != "$summary" {
				index++
			}
		}
		node = map[string]any{"id": nodeID, "type": "text", "parentId": parentID, "width": 400, "height": 280, "position": map[string]any{"x": x + 24 + float64(index%3)*424, "y": y + 100 + float64(index/3)*304}, "createdAt": time.Now().UnixMilli()}
		nodes = append(nodes, node)
	}
	step := "assets." + m.Category
	if m.Category == "bible" {
		section, _ := productionBibleSectionFor(key)
		step = section.Step
	}
	workflow := map[string]any{"stage": "assets", "step": step, "pipelineId": data["pipelineId"], "role": "document", "assetKey": key, "sourceNodeIds": data["sourceNodeIds"], "sourceSignatures": data["sourceSignatures"], "sourceSteps": data["sourceSteps"], "parameters": data["parameters"], "version": data["version"]}
	if m.Plan != nil {
		workflow["stage"], workflow["step"] = "story", "story.plan"
		if m.Plan.Version >= 2 {
			workflow["planVersion"] = m.Plan.Version
			workflow["planDependencies"] = productionPlanDependencies(m, artifacts, key)
			workflow["planDocumentSchema"] = 1
			if _, ok := planSection(key); ok {
				workflow["planSection"] = key
				if section := map[string]string{"story": "settings", "visual": "style", "direction": "cinematography", "generation": "generation"}[key]; section != "" {
					workflow["bibleSection"] = section
				}
			}
		}
		if item := productionPlanItem(m, key); item != nil {
			workflow["planAsset"] = map[string]any{"key": item.Key, "kind": item.Kind, "name": item.Name, "episodes": item.Episodes, "indexContent": productionContentSignature(content)}
			if m.Plan.Version >= 2 {
				asset := workflow["planAsset"].(map[string]any)
				asset["purpose"], asset["plannedRange"], asset["dependsOn"] = item.Purpose, item.PlannedRange, item.DependsOn
			}
			identity = item.Identity
			if parentID != m.FrameID {
				workflow["sourceNodeIds"], workflow["sourceSignatures"], workflow["sourceSteps"] = []string{m.FrameID}, map[string]string{}, []string{"story.plan"}
			}
		}
	}
	if identity != nil {
		workflow["assetIdentity"] = identity
		if design != nil {
			old, _ := productionWorkflow(node)["assetProfile"].(map[string]any)
			var previous []productionDesignVariant
			encoded, _ := json.Marshal(old["variants"])
			_ = json.Unmarshal(encoded, &previous)
			if receipt == nil {
				for _, source := range m.Sources {
					if source.AssetIdentity != nil && source.AssetIdentity.ID == identity.ID {
						profile, _ := productionWorkflow(productionNode(doc, source.NodeID))["assetProfile"].(map[string]any)
						encoded, _ = json.Marshal(profile["variants"])
						_ = json.Unmarshal(encoded, &previous)
					}
				}
			}
			for i := range design.Variants {
				design.Variants[i].Code = ""
				for _, variant := range previous {
					if variant.Name == design.Variants[i].Name {
						design.Variants[i].Code = variant.Code
					}
				}
				if design.Variants[i].Code == "" {
					code, e := repo.ReserveProductionAssetCode("variant:"+productionHash(identity.ID)[:32], identity.Code+"-V")
					if e != nil {
						return nil, e
					}
					design.Variants[i].Code = strings.Replace(code, "-V-", "-V", 1)
				}
			}
		}
	}
	if m.Category == "bible" {
		workflow["bibleSection"] = key
	}
	if m.Category != "bible" && (m.Plan == nil || identity != nil) {
		workflow["assetSchemaVersion"] = 2
		workflow["assetProfile"] = map[string]any{"aliases": aliases, "occurrences": occurrences, "variants": []any{}, "sounds": []string{}, "conflicts": []string{}, "references": []any{}, "indexContent": productionContentSignature(content)}
		profile := workflow["assetProfile"].(map[string]any)
		if design != nil {
			if design.Variants != nil {
				profile["variants"] = design.Variants
			}
			if design.Sounds != nil {
				profile["sounds"] = design.Sounds
			}
			if design.Conflicts != nil {
				profile["conflicts"] = design.Conflicts
			}
		} else if previous, ok := productionWorkflow(node)["assetProfile"].(map[string]any); ok {
			for _, field := range []string{"variants", "sounds", "conflicts"} {
				if value, ok := previous[field]; ok {
					profile[field] = value
				}
			}
		}
	}
	node["title"], node["updatedAt"] = name, time.Now().UnixMilli()
	node["metadata"] = map[string]any{"content": content, "status": "success", "generationMode": "text", "model": state.Request.Model, "shortDrama": workflow}
	frameData := productionWorkflow(frame)
	if m.Category == "bible" && len(m.BibleSections) > 0 {
		group, _ := frameData["assetGroup"].(map[string]any)
		if group != nil {
			group["sections"] = m.BibleSections
		}
	}
	ids := productionIDs(frameData["sourceNodeIds"])
	if !cloudAgentContainsString(ids, nodeID) {
		ids = append(ids, nodeID)
	}
	frameData["sourceNodeIds"] = ids
	frameMeta, _ := frame["metadata"].(map[string]any)
	geometry, _ := frameMeta["frame"].(map[string]any)
	if geometry == nil {
		geometry = map[string]any{}
		frameMeta["frame"] = geometry
	}
	height := float64(100 + ((len(ids)+2)/3)*304)
	geometry["expandedWidth"], geometry["expandedHeight"] = 1296, height
	if geometry["collapsed"] != true && (m.Plan == nil || m.Plan.Version < 2) {
		frame["width"], frame["height"] = 1296, height
		productionFitFrame(frame, nodes, height)
	}
	doc["nodes"] = nodes
	if m.Plan != nil && m.Plan.Version >= 2 {
		productionLayoutPlanGroup(m, frame, nodes)
		if geometry["collapsed"] != true {
			productionFitFrame(frame, nodes, numberValue(frame["height"], 428))
		}
	}
	if m.Plan != nil && m.Plan.Version >= 2 {
		// Validate against the post-write profile so deleted variants cannot keep
		// authorizing references, and newly assigned variants are recognized.
		referenceArtifacts := append(append([]model.ProductionAgentArtifact{}, artifacts...), model.ProductionAgentArtifact{NodeID: nodeID})
		if err := productionValidatePlanReferences(m, doc, referenceArtifacts, content); err != nil {
			return nil, err
		}
	}
	if err := saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(factIDs)
	row := &model.ProductionAgentArtifact{RunID: run.ID, UserID: run.UserID, Key: key, NodeID: nodeID, ContentHash: productionArtifactHash(node), FactIDsJSON: string(encoded)}
	if receipt == nil {
		err = repo.CreateProductionAgentArtifact(row)
	} else {
		row.CreatedAt = receipt.CreatedAt
		err = repo.UpdateProductionAgentArtifact(row)
	}
	if err != nil {
		return nil, err
	}
	if err = repo.ValidateProductionAgentJob(run.UserID, run.ID, false); err != nil {
		return nil, err
	}
	if err = emitCloudAgentCanvasChange(repo, run.ID, state, cloudAgentMutationInput{UserID: run.UserID, CanvasID: canvas.ID, Operation: "production_submit", BeforeJSON: before}); err != nil {
		return nil, err
	}
	label := "已保存资产 · "
	if m.Plan != nil {
		label = "已保存方案文稿 · "
	}
	state.event(run.ID, "production_progress", map[string]any{"text": label + name, "nodeId": nodeID})
	state.ProductionRepairs = 0
	state.ProductionProgressStep = state.Step
	return map[string]any{"nodeId": nodeID, "hash": row.ContentHash, "key": key, "identity": identity}, nil
}

func productionFitFrame(frame map[string]any, nodes []map[string]any, height float64) {
	position, _ := frame["position"].(map[string]any)
	if position == nil {
		return
	}
	x := numberValue(position["x"], 0)
	y := numberValue(position["y"], 0)
	start := y
	// Match client materialization: move the growing container below occupied
	// space, preserving all member offsets and existing container-only links.
	for attempt := 0; attempt <= len(nodes); attempt++ {
		next := y
		for _, other := range nodes {
			if other["id"] == frame["id"] || other["parentId"] == frame["id"] {
				continue
			}
			p, _ := other["position"].(map[string]any)
			ox := numberValue(p["x"], 0)
			oy := numberValue(p["y"], 0)
			w := numberValue(other["width"], 0)
			h := numberValue(other["height"], 0)
			if ox < x+1296 && ox+w > x && oy < y+height && oy+h > y {
				next = max(next, oy+h+64)
			}
		}
		if next == y {
			break
		}
		y = next
	}
	if y == start {
		return
	}
	position["y"] = y
	for _, node := range nodes {
		if node["parentId"] == frame["id"] {
			if p, ok := node["position"].(map[string]any); ok {
				old, _ := p["y"].(float64)
				p["y"] = old + y - start
			}
		}
	}
}

// Re-evaluate coverage at completion, even when the model previously passed a
// check: sources or targets may have changed while its final answer was running.
func productionComplete(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, policy RuntimePolicySetting) error {
	job, m, doc, err := productionLoad(repo, run, state)
	if err != nil {
		return err
	}
	facts, done, total, err := productionFacts(repo, run.UserID, m)
	if err != nil {
		return err
	}
	artifacts, err := repo.ProductionAgentArtifacts(run.UserID, run.ID)
	if err != nil {
		return err
	}
	report := productionCoverage(m, doc, facts, artifacts, done, total)
	if !job.Validated || report["valid"] != true {
		return BadAuthRequest("制作覆盖检查未通过，已有产物保留；继续任务补齐遗漏")
	}
	target := productionNode(doc, state.Request.Production.TargetNodeID)
	meta, _ := target["metadata"].(map[string]any)
	if m.Storyboard == nil && strings.TrimSpace(stringValue(meta["content"])) != "" {
		return BadAuthRequest("提取记录已有人工内容，未覆盖")
	}
	if m.Storyboard == nil {
		meta["content"] = fmt.Sprintf("已解析正文 %d/%d 页，保存 %d 项资产。\n\n机器覆盖检查通过；语义完整性、别名归并、冲突与提示词质量待人工验收。", done, total, len(artifacts))
		if m.Plan != nil {
			meta["content"] = fmt.Sprintf("制作方案已保存：故事总纲及 %d 项计划资产设定。\n\n资产清单覆盖检查通过，内容质量待人工验收。", len(m.Plan.Assets))
			for _, kind := range planKinds(m) {
				if reason := m.Plan.Absent[kind]; reason != "" {
					meta["content"] = stringValue(meta["content"]) + "\n" + kind + "：" + reason
				}
			}
		}
	}
	meta["status"], meta["taskStage"] = "success", "制作 Agent 已完成"
	data := productionWorkflow(target)
	data["assetOutput"] = false
	data["materializedTaskId"] = run.ID
	if m.Plan != nil && m.Plan.Version >= 2 {
		productionWorkflow(productionNode(doc, m.FrameID))["planAbsent"] = m.Plan.Absent
	}
	canvas, err := repo.CanvasProjectForUser(run.UserID, state.Request.CanvasID)
	if err != nil {
		return err
	}
	before := canvas.PayloadJSON
	if err = saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
		return err
	}
	return emitCloudAgentCanvasChange(repo, run.ID, state, cloudAgentMutationInput{UserID: run.UserID, CanvasID: canvas.ID, Operation: "production_complete", BeforeJSON: before})
}
