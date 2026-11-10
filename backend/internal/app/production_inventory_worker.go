package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const productionInventoryWorkerInstruction = "本次只核对 assignedSections 中的来源章节，并登记这些章节需要的新增资产；其他章节由后续批次完成。registeredAssets 是已登记身份，复用其 key、kind、name，不重发未变化的资产。逐项识别人物、实际行动空间、实体道具、规则效果和独立声音；普通服化、情绪、个人声线不另建身份。每项需求填写 subject、sourceRef、assetKey、disposition、reason；sourceRef 从该章节 sourceFragments 选择真实依据，服务端回填原文，不能编造或改写引文。asset/state 必须关联已登记或同批新增资产，excluded 的 assetKey 为空并说明理由。确无需求才填 requirements=[] 和具体 noAssetsReason。只提交 assets、absent、inventoryReview；版本、追加方式及最终完成判定由服务端负责。没有依据的类别缺省理由不要编造，待全来源审查后补齐。一次调用 production_plan_inventory 后结束。"

type productionInventoryFragment struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

func productionInventoryStory(doc map[string]any, rows []model.ProductionAgentArtifact) string {
	for _, row := range rows {
		if row.Key == "story" {
			meta, _ := productionNode(doc, row.NodeID)["metadata"].(map[string]any)
			return stringValue(meta["content"])
		}
	}
	return ""
}

// References are deterministic and tied to both the source version and section.
// Overlap preserves entities crossing a chunk boundary; every quote stays exact.
func productionInventoryFragments(hash, section, body string) []productionInventoryFragment {
	runes := []rune(body)
	var fragments []productionInventoryFragment
	for start := 0; start < len(runes); start += 220 {
		text := string(runes[start:min(start+240, len(runes))])
		id := productionHash([]string{hash, section, fmt.Sprint(start), text})
		fragments = append(fragments, productionInventoryFragment{ID: id[:16], Text: text})
		if start+240 >= len(runes) {
			break
		}
	}
	return fragments
}

func productionInventoryWorkerContext(m productionManifest, doc map[string]any, rows []model.ProductionAgentArtifact, work *productionParallelWork, context map[string]any) {
	sections, bodies := productionInventoryReviewSources(*m.Plan, productionInventoryStory(doc, rows))
	hash := productionDocumentTargetHash(rows, "story")
	reviewed := map[string]bool{}
	if m.Plan.StoryHash == hash {
		for _, review := range m.Plan.InventoryReview {
			reviewed[review.Section] = true
		}
	}
	missing := []string{}
	for _, section := range sections {
		if !reviewed[section] {
			missing = append(missing, section)
		}
	}
	candidates := missing
	if len(candidates) == 0 {
		// Final validation can still request an asset evidence or category fix.
		// Rotate a bounded set of sources instead of sending the entire ledger.
		candidates = append([]string{}, sections...)
		if len(candidates) > 0 {
			offset := (work.InventoryNoProgress * 6) % len(candidates)
			candidates = append(candidates[offset:], candidates[:offset]...)
		}
	}
	limit := max(1, 6/(1+work.InventoryNoProgress))
	assigned := []string{}
	fragments := map[string][]productionInventoryFragment{}
	chars := 0
	for _, section := range candidates {
		if len(assigned) >= limit || (len(assigned) > 0 && chars+len([]rune(bodies[section])) > 10000) {
			break
		}
		assigned = append(assigned, section)
		fragments[section] = productionInventoryFragments(hash, section, bodies[section])
		chars += len([]rune(bodies[section]))
	}
	work.InventoryScoped, work.InventorySections = true, assigned
	for _, key := range []string{"requiredDocuments", "sourceSectionText", "sourceSections", "sourceInputs", "inventoryReview", "progress"} {
		delete(context, key)
	}
	context["nextAction"] = map[string]any{"key": "inventory", "tool": "production_plan_inventory", "inventoryReviewRequired": m.Plan.InventoryReviewVersion > 0, "sourceSections": assigned}
	context["assignedSections"], context["sourceFragments"] = assigned, fragments
	context["reviewProgress"] = map[string]any{"saved": len(sections) - len(missing), "total": len(sections), "missingSections": missing}
	context["registeredAssets"] = m.Plan.Assets
	var drafts []productionInventorySectionReview
	for _, draft := range work.InventoryRepairReviews {
		if cloudAgentContainsString(assigned, draft.Section) {
			drafts = append(drafts, draft)
		}
	}
	if len(drafts) > 0 {
		context["rejectedDraft"] = drafts
	}
	context["absent"] = m.Plan.Absent
	context["instruction"] = productionInventoryWorkerInstruction
}

func productionInventoryWorkerTools(tools []map[string]any, work productionParallelWork) {
	if !work.InventoryScoped {
		return
	}
	for _, tool := range tools {
		fn, _ := tool["function"].(map[string]any)
		if fn["name"] != "production_plan_inventory" {
			continue
		}
		parameters := fn["parameters"].(map[string]any)
		properties := parameters["properties"].(map[string]any)
		delete(properties, "storyHash")
		delete(properties, "complete")
		parameters["required"] = []string{"assets", "absent", "inventoryReview"}
		review := productionInventoryReviewSchema(len(work.InventorySections))
		review["description"] = productionInventoryWorkerInstruction
		item := review["items"].(map[string]any)["properties"].(map[string]any)
		item["section"].(map[string]any)["enum"] = work.InventorySections
		delete(item, "append")
		demand := item["requirements"].(map[string]any)["items"].(map[string]any)
		demand["required"] = []string{"subject", "sourceRef", "assetKey", "disposition", "reason"}
		fields := demand["properties"].(map[string]any)
		delete(fields, "quote")
		fields["sourceRef"] = map[string]any{"type": "string", "description": "本章节 sourceFragments 中的 id，原文由服务端回填"}
		properties["inventoryReview"] = review
		fn["description"] = "提交当前分配章节的资产和来源核对。服务端逐节保存合格记录、回报失败项并判断最终完成状态。"
	}
}

func productionInventoryContentError(err error) bool {
	var invalid *kernel.AppError
	return len(cloudAgentValidationIssues(err)) > 0 || (errors.As(err, &invalid) && invalid.Status == 400)
}

func productionInventoryEvidenceCount(reviews []productionInventorySectionReview) int {
	seen := map[[4]string]bool{}
	for _, review := range reviews {
		for _, demand := range review.Requirements {
			seen[[4]string{review.Section, strings.TrimSpace(demand.Subject), demand.AssetKey, demand.Disposition}] = true
		}
	}
	return len(seen)
}

// Called inside the coordinator's transaction: source/version/storage errors
// roll back everything, while content rejection is isolated to one section.
func productionInventoryWorkerSubmit(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, rows []model.ProductionAgentArtifact, work productionParallelWork, call cloudAgentCall, policy RuntimePolicySetting) (any, error) {
	for _, row := range rows {
		if row.Key == "inventory" {
			node := productionNode(doc, row.NodeID)
			if node == nil || stringValue(node["parentId"]) != m.FrameID || !productionArtifactMatches(node, row.ContentHash) {
				return nil, productionParallelStaleResultError{message: "资产总表已被删除、移动或人工修改，本批未覆盖；请核对当前版本后重试"}
			}
		}
	}
	var input productionPlan
	if err := decodeCloudAgentJSONObject(call.Function.Arguments, &input); err != nil {
		if strings.HasPrefix(err.Error(), "json: unknown field ") {
			field := strings.Trim(strings.TrimPrefix(err.Error(), "json: unknown field "), "\"")
			return nil, cloudAgentFieldError(truncateRunes(field, 100), "unknown_field", "不支持字段 "+truncateRunes(field, 100)+"；顶层只提交 assets、absent、inventoryReview，嵌套字段请沿用本轮工具模板。缺省分类字段是 absent，不是 abs。")
		}
		return nil, cloudAgentJSONArgumentError(err)
	}
	hash := productionDocumentTargetHash(rows, "story")
	before := productionHash(m.Plan)
	beforeAssets, beforeReviews := len(m.Plan.Assets), len(m.Plan.InventoryReview)
	beforeDemands := productionInventoryEvidenceCount(m.Plan.InventoryReview)
	story := productionInventoryStory(doc, rows)
	sections, bodies := productionInventoryReviewSources(*m.Plan, story)
	accepted := []string{}
	rejected := []map[string]any{}
	rejectedDraft := []productionInventorySectionReview{}
	issues := []cloudAgentValidationIssue{}
	feedback := []string{}
	record := func(section string, err error) {
		entry := map[string]any{"section": section, "message": cloudAgentSafeToolError(err)}
		cloudAgentValidationReceipt(entry, err)
		issues = append(issues, cloudAgentValidationIssues(err)...)
		rejected = append(rejected, entry)
		encoded, _ := json.Marshal(entry)
		feedback = append(feedback, string(encoded))
	}
	save := func(batch productionPlan) error {
		batch.StoryHash = hash
		encoded, _ := json.Marshal(batch)
		nextCall := call
		nextCall.Function.Arguments = string(encoded)
		_, err := productionPlanInventory(repo, run, state, m, doc, nextCall, policy, true)
		if err != nil {
			return err
		}
		_, updated, _, err := productionLoad(repo, run, state)
		if err == nil {
			m = updated
		}
		return err
	}
	if len(input.Assets) > 0 || len(input.Absent) > 0 {
		if err := save(productionPlan{Assets: input.Assets, Absent: input.Absent}); err != nil {
			if !productionInventoryContentError(err) {
				return nil, err
			}
			record("assets", err)
		}
	}
	seen := map[string]bool{}
	for _, review := range input.InventoryReview {
		if seen[review.Section] || (work.InventoryScoped && !cloudAgentContainsString(work.InventorySections, review.Section)) {
			record(review.Section, cloudAgentFieldError("inventoryReview.section", "outside_assignment", "仅提交本轮分配的章节，每节一条；已经通过的章节无需重复提交"))
			continue
		}
		seen[review.Section] = true
		fragments := map[string]string{}
		for _, fragment := range productionInventoryFragments(hash, review.Section, bodies[review.Section]) {
			fragments[fragment.ID] = fragment.Text
		}
		var refErr error
		for i := range review.Requirements {
			demand := &review.Requirements[i]
			if demand.SourceRef != "" {
				quote, ok := fragments[demand.SourceRef]
				if !ok {
					refErr = cloudAgentFieldError("inventoryReview.requirements.sourceRef", "invalid_source_ref", "来源片段不存在于当前版本的本章节，请使用本轮提供的 sourceFragments.id")
					break
				}
				demand.Quote, demand.SourceRef = quote, ""
			} else if work.InventoryScoped && demand.Quote == "" {
				refErr = cloudAgentFieldError("inventoryReview.requirements.sourceRef", "missing_source_ref", "需求必须引用本轮提供的来源片段")
				break
			}
		}
		if refErr != nil {
			record(review.Section, refErr)
			rejectedDraft = append(rejectedDraft, review)
			continue
		}
		// New sections never append to a record that a rejected batch did not save.
		review.Append = false
		for _, prior := range m.Plan.InventoryReview {
			if prior.Section == review.Section && len(prior.Requirements) > 0 && len(review.Requirements) > 0 {
				review.Append = true
			}
		}
		if err := save(productionPlan{InventoryReview: []productionInventorySectionReview{review}}); err != nil {
			if !productionInventoryContentError(err) {
				return nil, err
			}
			record(review.Section, err)
			rejectedDraft = append(rejectedDraft, review)
			continue
		}
		accepted = append(accepted, review.Section)
	}
	if len(rejected) == 0 && (productionInventoryReviewCoversSources(*m.Plan, story) || m.Plan.InventoryReviewVersion == 0) {
		if err := save(productionPlan{Complete: true}); err != nil {
			if !productionInventoryContentError(err) {
				return nil, err
			}
			record("finalValidation", err)
		}
	}
	changed := before != productionHash(m.Plan)
	demands := productionInventoryEvidenceCount(m.Plan.InventoryReview)
	// Rephrasing a reason or changing priority back and forth is not progress.
	// Count new coverage or a strict reduction of the outstanding defects.
	progress := changed && (m.Plan.Complete || len(m.Plan.Assets) > beforeAssets || len(m.Plan.InventoryReview) > beforeReviews || demands > beforeDemands || (len(work.ValidationIssues) > 0 && len(issues) < len(work.ValidationIssues)))
	if (changed || productionDocumentTargetHash(rows, "inventory") == "") && (len(m.Plan.Assets) > 0 || len(m.Plan.InventoryReview) > 0) {
		if err := productionSavePlanInventory(repo, run, state, m, doc, rows, policy); err != nil {
			return nil, err
		}
	}
	message := fmt.Sprintf("资产总表已登记 %d 项，来源核对 %d/%d；本批接受 %d 节，退回 %d 项", len(m.Plan.Assets), len(m.Plan.InventoryReview), len(sections), len(accepted), len(rejected))
	if !progress {
		message += "。本批没有新增有效内容，请针对缺失来源及退回原因补齐，勿重复提交空批次"
	}
	return map[string]any{"inventoryComplete": m.Plan.Complete, "madeProgress": progress, "acceptedSections": accepted, "rejected": rejected, "rejectedDraft": rejectedDraft, "validationIssues": issues, "batchMessage": message, "feedback": strings.Join(feedback, "\n")}, nil
}
