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
	if key == "" || name == "" || content == "" || utf8.RuneCountInString(key) > 120 || utf8.RuneCountInString(name) > 120 || utf8.RuneCountInString(content) > 12000 || len(factIDs) > 256 {
		return nil, BadAuthRequest("资产缺少 key/name/content 或超过单项预算")
	}
	if m.Category == "bible" && !cloudAgentContainsString(productionBibleKeys(m), key) {
		return nil, BadAuthRequest("制作规范 key 必须来自 production_status.bibleSections")
	}
	if missing := productionDocumentMissing(m.Category, key, content); len(missing) > 0 {
		return nil, cloudAgentFieldError("document", "missing_sections", "请用 document 补齐统一文稿字段后重新提交："+strings.Join(missing, ", ")+"；人物需完整声线描述。未写入残缺资产。")
	}
	artifacts, err := repo.ProductionAgentArtifacts(run.UserID, run.ID)
	if err != nil {
		return nil, err
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
	categoryKind := map[string]string{"characters": "character", "environments": "environment", "props": "prop", "special": "special"}[m.Category]
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
	if len(factIDs) == 0 {
		return nil, BadAuthRequest("资产必须关联正文证据；无此类资产时请直接做覆盖检查")
	}
	if !categoryEvidence {
		return nil, BadAuthRequest("该资产缺少本类别的正文事实，不根据风格或建议虚构资产")
	}
	if receipt == nil && len(artifacts) >= 200 {
		return nil, BadAuthRequest("本轮资产达到 200 项上限，已有结果保留")
	}
	for _, a := range artifacts {
		if a.Key != key {
			node := productionNode(doc, a.NodeID)
			if strings.EqualFold(strings.TrimSpace(stringValue(node["title"])), name) {
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
	frame := productionNode(doc, m.FrameID)
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
		if matchingDesign && meta["content"] == content && node["title"] == name && productionHash(productionIDs(json.RawMessage(receipt.FactIDsJSON))) == productionHash(factIDs) {
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
		index := len(artifacts) + 1
		node = map[string]any{"id": nodeID, "type": "text", "parentId": m.FrameID, "width": 400, "height": 280, "position": map[string]any{"x": x + 24 + float64(index%3)*424, "y": y + 100 + float64(index/3)*304}, "createdAt": time.Now().UnixMilli()}
		nodes = append(nodes, node)
	}
	step := "assets." + m.Category
	if m.Category == "bible" {
		section, _ := productionBibleSectionFor(key)
		step = section.Step
	}
	workflow := map[string]any{"stage": "assets", "step": step, "pipelineId": data["pipelineId"], "role": "document", "assetKey": key, "sourceNodeIds": data["sourceNodeIds"], "sourceSignatures": data["sourceSignatures"], "sourceSteps": data["sourceSteps"], "parameters": data["parameters"], "version": data["version"]}
	if m.Category == "bible" {
		workflow["bibleSection"] = key
	}
	if m.Category != "bible" {
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
	if geometry["collapsed"] != true {
		frame["width"], frame["height"] = 1296, height
		productionFitFrame(frame, nodes, height)
	}
	doc["nodes"] = nodes
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
	state.event(run.ID, "production_progress", map[string]any{"text": "已保存资产 · " + name, "nodeId": nodeID})
	state.ProductionRepairs = 0
	state.ProductionProgressStep = state.Step
	return map[string]any{"nodeId": nodeID, "hash": row.ContentHash, "key": key}, nil
}

func productionFitFrame(frame map[string]any, nodes []map[string]any, height float64) {
	position, _ := frame["position"].(map[string]any)
	if position == nil {
		return
	}
	x, _ := position["x"].(float64)
	y, _ := position["y"].(float64)
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
			ox, _ := p["x"].(float64)
			oy, _ := p["y"].(float64)
			w, _ := other["width"].(float64)
			h, _ := other["height"].(float64)
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
	if strings.TrimSpace(stringValue(meta["content"])) != "" {
		return BadAuthRequest("提取记录已有人工内容，未覆盖")
	}
	meta["content"] = fmt.Sprintf("已解析正文 %d/%d 页，保存 %d 项资产。\n\n机器覆盖检查通过；语义完整性、别名归并、冲突与提示词质量待人工验收。", done, total, len(artifacts))
	meta["status"], meta["taskStage"] = "success", "制作 Agent 已完成"
	data := productionWorkflow(target)
	data["assetOutput"] = false
	data["materializedTaskId"] = run.ID
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
