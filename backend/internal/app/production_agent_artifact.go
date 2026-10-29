package app

import (
	"encoding/json"
	"fmt"
	"slices"
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
	Code          string `json:"code,omitempty"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	Source        string `json:"source,omitempty"`
	Basis         string `json:"basis,omitempty"`
	Trigger       string `json:"trigger,omitempty"`
	PreviousState string `json:"previousState,omitempty"`
	Scope         string `json:"scope,omitempty"`
	Recovery      string `json:"recovery,omitempty"`
}
type productionDesignFields struct {
	Variants  []productionDesignVariant `json:"variants"`
	Sounds    []string                  `json:"sounds"`
	Conflicts []string                  `json:"conflicts"`
	SoundKind string                    `json:"soundKind,omitempty"`
}

func productionArtifactContentLimit(m productionManifest, doc map[string]any, key string) int {
	if _, shared := planSection(key); shared && m.Plan != nil && m.Plan.Version >= 2 {
		return productionPlanDocumentRuneLimit(m, doc, key)
	}
	return 12000
}

func productionValidateDesignFields(design *productionDesignFields) error {
	if design == nil {
		return nil
	}
	failures := []error{}
	if design.SoundKind != "" && !productionValidSoundKind(design.SoundKind) {
		failures = append(failures, cloudAgentFieldError("design.soundKind", "invalid_enum", "声音类别必须是 voice、prop、ambience 或 music"))
	}
	for _, field := range []struct {
		key   string
		count int
	}{
		{"variants", len(design.Variants)}, {"sounds", len(design.Sounds)}, {"conflicts", len(design.Conflicts)},
	} {
		if field.count > 200 {
			failures = append(failures, cloudAgentFieldError("design."+field.key, "item_count", "结构化资产字段最多包含 200 项"))
		}
	}
	for i, variant := range design.Variants {
		prefix := fmt.Sprintf("design.variants[%d].", i)
		if strings.TrimSpace(variant.Name) == "" {
			failures = append(failures, cloudAgentFieldError(prefix+"name", "required", "变体需要名称"))
		}
		if strings.TrimSpace(variant.Description) == "" {
			failures = append(failures, cloudAgentFieldError(prefix+"description", "required", "变体需要描述"))
		}
		if err := productionValidateVariant(variant); err != nil {
			for _, issue := range cloudAgentValidationIssues(err) {
				failures = append(failures, cloudAgentFieldError(prefix+issue.Field, issue.Issue, issue.Message))
			}
		}
	}
	return cloudAgentValidationErrors(failures...)
}

func productionSubmit(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, key, name, content string, factIDs []string, expected string, design *productionDesignFields, document map[string]string, policy RuntimePolicySetting) (any, error) {
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
	contentLimit := productionArtifactContentLimit(m, doc, key)
	if key == "" || name == "" || content == "" || utf8.RuneCountInString(key) > 120 || utf8.RuneCountInString(name) > 120 || (!systemInventory && utf8.RuneCountInString(content) > contentLimit) || len(factIDs) > 256 {
		if content != "" && utf8.RuneCountInString(content) > contentLimit {
			return nil, productionDocumentLengthError(utf8.RuneCountInString(content), contentLimit)
		}
		return nil, BadAuthRequest("资产缺少 key/name/content 或超过单项预算")
	}
	if m.Category == "bible" && !cloudAgentContainsString(productionBibleKeys(m), key) {
		return nil, BadAuthRequest("制作规范 key 必须来自 production_status.bibleSections")
	}
	missing := productionDocumentMissing(m.Category, key, content)
	planDocumentSchema := 0
	if m.Plan != nil && m.Plan.Version >= 2 {
		planDocumentSchema = productionPlanDocumentSchemaVersion(m.Plan.Version)
		missing = productionPlanDocumentMissingForSchema(key, productionPlanKind(m, key), content, planDocumentSchema)
		if key == "story" && m.Plan.StoryStructureVersion > 0 && m.Plan.Version < 5 {
			if issues := productionPlanEpisodeArchitectureIssues(m, doc, content, planDocumentSchema); len(issues) > 0 {
				failures := make([]error, 0, len(issues))
				for _, issue := range issues {
					field := productionEpisodeArchitectureIssueField(issue)
					failures = append(failures, cloudAgentFieldError(field, "invalid_episode_architecture", issue))
				}
				return nil, cloudAgentValidationErrors(failures...)
			}
		}
	}
	if len(missing) > 0 {
		return nil, cloudAgentFieldError("document", "missing_sections", "请用 document 补齐统一文稿字段后重新提交："+strings.Join(missing, ", ")+"；人物需完整声线描述。未写入残缺资产。")
	}
	artifacts, err := repo.ProductionAgentArtifacts(run.UserID, run.ID)
	if err != nil {
		return nil, err
	}
	relationshipLedgerChanged := false
	if m.Plan != nil && m.Plan.Version >= 3 {
		validationFailures := []error{}
		relationshipLedgerInvalid := false
		if key == "story" && m.Plan.ContinuityVersion > 0 {
			relationshipText := content
			if document != nil && strings.TrimSpace(document["relationships"]) != "" {
				relationshipText = document["relationships"]
			}
			ledger, _, ledgerErr := productionExtractRelationshipLedger(relationshipText)
			if ledgerErr != nil {
				relationshipLedgerInvalid = true
				issues := cloudAgentValidationIssues(ledgerErr)
				if len(issues) == 0 {
					validationFailures = append(validationFailures, cloudAgentFieldError("document.relationships", "invalid_relationship_ledger", ledgerErr.Error()+"。"+productionRelationshipLedgerContract()))
				} else {
					validationFailures = append(validationFailures, cloudAgentFieldError("document.relationships", "invalid_relationship_ledger", "人物关系登记存在不完整或不合法字段；请按本次 validationIssues 一次修正全部记录。"))
					for i, issue := range issues {
						message := issue.Message
						if i == 0 {
							message += "。" + productionRelationshipLedgerContract()
						}
						validationFailures = append(validationFailures, cloudAgentFieldError("document."+issue.Field, issue.Issue, message))
					}
				}
			}
			if len(ledger) > 0 {
				m.Plan.Relationships = ledger
			} else {
				m.Plan.Relationships = nil
			}
			relationshipLedgerChanged = true
		}
		// Validate every document field against the usable relationship ledger.
		// If the current story ledger has no valid rows, its parse diagnostics are
		// already complete and there is no established fact to compare downstream.
		if !(relationshipLedgerInvalid && len(m.Plan.Relationships) == 0) {
			continuityFailureStart := len(validationFailures)
			for _, section := range productionPlanDocumentSectionsForSchema(key, productionPlanKind(m, key), planDocumentSchema) {
				if section.Key == "relationships" || document[section.Key] == "" {
					continue
				}
				if fieldIssues := productionPlanContinuityIssues(m, doc, artifacts, key, content, map[string]string{section.Key: document[section.Key]}); len(fieldIssues) > 0 {
					for issueIndex, fieldIssue := range fieldIssues {
						identity := productionRelationshipIssueIdentity(fieldIssue, issueIndex)
						validationFailures = append(validationFailures, cloudAgentFieldError(fmt.Sprintf("document.%s.relationships.%s", section.Key, identity), "relationship_conflict", fieldIssue))
					}
				}
			}
			if len(validationFailures) == continuityFailureStart {
				for issueIndex, issue := range productionPlanContinuityIssues(m, doc, artifacts, key, content, document) {
					validationFailures = append(validationFailures, cloudAgentFieldError(fmt.Sprintf("document.continuity[%d]", issueIndex), "relationship_conflict", issue))
				}
			}
		}
		if !(m.Plan.Version >= 5 && key != "story") {
			if err := cloudAgentValidationErrors(validationFailures...); err != nil {
				return nil, err
			}
		}
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
	newPlanVersion := m.Plan != nil && slices.Contains(m.Plan.NewVersionAssetKeys, key) && receipt != nil
	replacedReceiptAt := time.Time{}
	if newPlanVersion {
		replacedReceiptAt = receipt.CreatedAt
		receipt = nil
	}
	assetVersionTitle := ""
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
		if design.SoundKind == "" {
			design.SoundKind = previous.SoundKind
		}
		if err := cloudAgentValidationErrors(productionValidateDesignFields(design), productionMatchVariantCodes(design.Variants, previous.Variants)); err != nil {
			return nil, err
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
			occurrences = append(occurrences, map[string]any{"episode": fact.Episode, "scene": fact.Scene, "state": fact.Description, "owner": "", "location": "", "evidence": fact.Evidence})
		}
	}
	if len(factIDs) == 0 && m.Plan == nil {
		return nil, BadAuthRequest("资产必须关联正文证据；无此类资产时请直接做覆盖检查")
	}
	if !categoryEvidence && m.Plan == nil {
		return nil, BadAuthRequest("该资产缺少本类别的正文事实，不根据风格或建议虚构资产")
	}
	if m.Plan == nil && m.Category != "bible" && identity == nil {
		identity, err = newProductionAssetIdentity(repo, state.Request.CanvasID, stringValue(productionWorkflow(productionNode(doc, m.FrameID))["pipelineId"]), categoryKind)
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
	// The model may have been working while other production tools saved nodes.
	// Always apply this artifact to the payload that matches the revision we save.
	doc, err = creationDocument(canvas.PayloadJSON)
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
	if m.Plan != nil && productionPlanItem(m, key) != nil && receipt == nil {
		nodeID = "pa-" + newID()
		for _, candidate := range nodes {
			workflow := productionWorkflow(candidate)
			placeholder, _ := workflow["planGeneration"].(map[string]any)
			if workflow["assetKey"] == key && placeholder["runId"] == run.ID {
				nodeID, node = stringValue(candidate["id"]), candidate
				break
			}
		}
	}
	if receipt != nil {
		nodeID = receipt.NodeID
		node = productionNode(doc, receipt.NodeID)
		if node == nil {
			return nil, BadAuthRequest("资产已删除，未重复创建")
		}
		if !productionArtifactMatches(node, receipt.ContentHash) {
			return nil, BadAuthRequest("资产已人工修改或移出，未覆盖；请生成新的候选版本")
		}
		meta, _ := node["metadata"].(map[string]any)
		oldProfile, _ := productionWorkflow(node)["assetProfile"].(map[string]any)
		oldSoundKind, _ := oldProfile["soundKind"].(string)
		matchingDesign := design == nil || productionStoredValueHash([]any{oldProfile["variants"], oldProfile["sounds"], oldProfile["conflicts"], oldSoundKind}) == productionStoredValueHash([]any{design.Variants, design.Sounds, design.Conflicts, design.SoundKind})
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
	} else if node == nil {
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
		// Keep the public document identity on every plan version. Older plan
		// nodes did not carry planSection, which made their saved documents
		// invisible to the canvas count and refresh projection even though the
		// artifact and node had been persisted successfully.
		if section, ok := planSection(key); ok {
			workflow["planSection"] = section.Key
		}
		if m.Plan.Version >= 2 {
			workflow["planVersion"] = m.Plan.Version
			workflow["planDependencies"] = productionPlanDependencies(m, artifacts, key)
			workflow["planDocumentSchema"] = planDocumentSchema
			if _, ok := planSection(key); ok {
				if section := map[string]string{"story": "settings", "visual": "style", "direction": "cinematography", "generation": "generation"}[key]; section != "" {
					workflow["bibleSection"] = section
				}
			}
		}
		if item := productionPlanItem(m, key); item != nil {
			workflow["planAsset"] = map[string]any{"key": item.Key, "kind": item.Kind, "name": item.Name, "episodes": item.Episodes, "indexContent": productionContentSignature(content)}
			if item.BaseKey != "" {
				workflow["planAsset"].(map[string]any)["baseKey"] = item.BaseKey
				workflow["planAsset"].(map[string]any)["stateName"] = item.StateName
			}
			if m.Plan.Version >= 2 {
				asset := workflow["planAsset"].(map[string]any)
				asset["purpose"], asset["plannedRange"], asset["dependsOn"] = item.Purpose, item.PlannedRange, item.DependsOn
			}
			identity = item.Identity
			assetVersion := 1
			if newPlanVersion {
				assetVersion = 2
			}
			if item.Identity != nil {
				for _, existing := range nodes {
					workflow := productionWorkflow(existing)
					existingIdentity, _ := workflow["assetIdentity"].(map[string]any)
					if existingIdentity["id"] == item.Identity.ID {
						assetVersion = max(assetVersion, int(numberValue(workflow["assetVersion"], 1))+1)
					}
				}
			} else {
				for _, existing := range nodes {
					workflow := productionWorkflow(existing)
					planAsset, _ := workflow["planAsset"].(map[string]any)
					if workflow["assetKey"] == key || planAsset["key"] == key {
						assetVersion = max(assetVersion, int(numberValue(workflow["assetVersion"], 1))+1)
					}
				}
			}
			workflow["assetVersion"] = assetVersion
			if assetVersion > 1 {
				assetVersionTitle = fmt.Sprintf("%s · 第 %d 版", name, assetVersion)
			}
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
			if err := productionMatchVariantCodes(design.Variants, previous); err != nil {
				return nil, err
			}
			var missing []int
			for i := range design.Variants {
				if design.Variants[i].Code == "" {
					missing = append(missing, i)
				}
			}
			if len(missing) > 0 {
				codes, err := newProductionVariantCodes(repo, identity.Code, len(missing))
				if err != nil {
					return nil, err
				}
				for i, index := range missing {
					design.Variants[index].Code = codes[i]
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
			if design.SoundKind != "" {
				profile["soundKind"] = design.SoundKind
			}
		} else if previous, ok := productionWorkflow(node)["assetProfile"].(map[string]any); ok {
			for _, field := range []string{"variants", "sounds", "conflicts", "soundKind"} {
				if value, ok := previous[field]; ok {
					profile[field] = value
				}
			}
		}
	}
	node["title"], node["updatedAt"] = name, time.Now().UnixMilli()
	if assetVersionTitle != "" {
		node["title"] = assetVersionTitle
	}
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
	if m.Plan != nil && m.Plan.Version >= 2 && !(m.Plan.Version >= 5 && m.Plan.AssetsStarted && productionPlanItem(m, key) != nil) {
		// Validate against the post-write profile so deleted variants cannot keep
		// authorizing references, and newly assigned variants are recognized.
		referenceArtifacts := append(append([]model.ProductionAgentArtifact{}, artifacts...), model.ProductionAgentArtifact{NodeID: nodeID})
		if err := productionValidatePlanReferences(m, doc, referenceArtifacts, content); err != nil {
			var referenceFailures []error
			for _, section := range productionPlanDocumentSectionsForSchema(key, productionPlanKind(m, key), planDocumentSchema) {
				if fieldErr := productionValidatePlanReferences(m, doc, referenceArtifacts, document[section.Key]); fieldErr != nil {
					for _, issue := range cloudAgentValidationIssues(fieldErr) {
						field := productionDocumentIssueField(section.Key, issue.Field)
						referenceFailures = append(referenceFailures, cloudAgentFieldError(field, issue.Issue, issue.Message))
					}
				}
			}
			if len(referenceFailures) > 0 {
				return nil, cloudAgentValidationErrors(referenceFailures...)
			}
			return nil, err
		}
	}
	if err := saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(factIDs)
	row := &model.ProductionAgentArtifact{RunID: run.ID, UserID: run.UserID, Key: key, NodeID: nodeID, ContentHash: productionArtifactHash(node), FactIDsJSON: string(encoded)}
	if receipt == nil {
		if newPlanVersion {
			row.CreatedAt = replacedReceiptAt
			err = repo.UpdateProductionAgentArtifact(row)
		} else {
			err = repo.CreateProductionAgentArtifact(row)
		}
	} else {
		row.CreatedAt = receipt.CreatedAt
		err = repo.UpdateProductionAgentArtifact(row)
	}
	if err != nil {
		return nil, err
	}
	if newPlanVersion {
		m.Plan.NewVersionAssetKeys = slices.DeleteFunc(m.Plan.NewVersionAssetKeys, func(candidate string) bool { return candidate == key })
		encodedManifest, marshalErr := json.Marshal(m)
		if marshalErr != nil {
			return nil, marshalErr
		}
		if err = repo.UpdateProductionAgentManifest(run.UserID, run.ID, string(encodedManifest)); err != nil {
			return nil, err
		}
	}
	if relationshipLedgerChanged {
		encodedManifest, marshalErr := json.Marshal(m)
		if marshalErr != nil {
			return nil, marshalErr
		}
		if err = repo.UpdateProductionAgentManifest(run.UserID, run.ID, string(encodedManifest)); err != nil {
			return nil, err
		}
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
	canvas, err := repo.CanvasProjectForUser(run.UserID, state.Request.CanvasID)
	if err != nil {
		return err
	}
	// Tool output may have landed after productionLoad read its snapshot. Base
	// the terminal status write on the latest payload so completion cannot erase
	// artifacts created by the final parallel submissions.
	doc, err = creationDocument(canvas.PayloadJSON)
	if err != nil {
		return err
	}
	report = productionCoverage(m, doc, facts, artifacts, done, total)
	if report["valid"] != true {
		return BadAuthRequest("制作覆盖检查未通过，已有产物保留；继续任务补齐遗漏")
	}
	target := productionNode(doc, state.Request.Production.TargetNodeID)
	if target == nil {
		return BadAuthRequest("制作任务节点已删除，未覆盖画布内容")
	}
	meta, _ := target["metadata"].(map[string]any)
	ownedPlanSummary := m.Plan != nil && productionWorkflow(target)["materializedTaskId"] == run.ID
	if m.Storyboard == nil && strings.TrimSpace(stringValue(meta["content"])) != "" && !ownedPlanSummary {
		return BadAuthRequest("提取记录已有人工内容，未覆盖")
	}
	if m.Storyboard == nil {
		meta["content"] = fmt.Sprintf("已解析正文 %d/%d 页，保存 %d 项资产。\n\n机器覆盖检查通过；语义完整性、别名归并、冲突与提示词质量待人工验收。", done, total, len(artifacts))
		if m.Plan != nil {
			meta["content"] = fmt.Sprintf("制作方案已保存：故事总纲及 %d 项计划资产设定。\n\n资产清单覆盖检查通过，内容质量待人工验收。", len(m.Plan.Assets))
			if m.Plan.Version >= 2 && !m.Plan.AssetsStarted {
				meta["content"] = fmt.Sprintf("制作方案已完成：故事总纲、资产总表及全部制作规范。\n\n已登记 %d 项计划资产，尚未创建资产档案；可手动点击生成资产。", len(m.Plan.Assets))
			}
			if m.Plan.Version >= 2 && len(m.Plan.SelectedAssetKeys) > 0 {
				meta["content"] = fmt.Sprintf("制作方案已完成，本次所选 %d 项资产档案已保存。\n\n清单共 %d 项资产；其他未生成项可在详情中手动选择。", len(m.Plan.SelectedAssetKeys), len(m.Plan.Assets))
			}
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
		rootData := productionWorkflow(productionNode(doc, m.FrameID))
		rootData["planAbsent"] = m.Plan.Absent
		rootData["planReady"], rootData["planAssetsStarted"] = true, m.Plan.AssetsStarted
		if m.Plan.AssetsStarted {
			data["assetExecutionStatus"] = "completed"
		}
		// Completion writes our summary; keep the next stage's edit guard bound
		// to that saved content instead of the original empty task anchor.
		m.Plan.SummaryHash = productionTargetHash(target)
		encoded, err := json.Marshal(m)
		if err != nil {
			return err
		}
		if err := repo.UpdateProductionAgentManifest(run.UserID, run.ID, string(encoded)); err != nil {
			return err
		}
	}
	before := canvas.PayloadJSON
	if err = saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
		return err
	}
	return emitCloudAgentCanvasChange(repo, run.ID, state, cloudAgentMutationInput{UserID: run.UserID, CanvasID: canvas.ID, Operation: "production_complete", BeforeJSON: before})
}
