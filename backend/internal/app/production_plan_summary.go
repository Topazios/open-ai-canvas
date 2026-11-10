package app

import (
	"fmt"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Only system progress text may be reconciled. The full saved hash still
// protects the title, parent, source links, parameters and production version.
func productionPlanSummaryCheckpoint(target map[string]any, runID string, m productionManifest) (string, bool) {
	if m.Plan == nil || m.Plan.Version < 2 || m.Plan.SummaryHash == "" || target == nil {
		return "", false
	}
	data := productionWorkflow(target)
	agent, _ := data["productionAgent"].(map[string]any)
	if data["materializedTaskId"] != runID || agent["runId"] != runID || data["assetOutput"] == true {
		return "", false
	}
	meta, _ := target["metadata"].(map[string]any)
	content := stringValue(meta["content"])
	candidates := productionPlanSummaryCandidates(m)
	known := false
	for _, candidate := range candidates {
		known = known || content == candidate
	}
	if !known {
		return "", false
	}
	// Copy just the target and metadata: computing a candidate must not mutate
	// the snapshot used by a read-only category request or a failed transaction.
	copy := map[string]any{}
	for key, value := range target {
		copy[key] = value
	}
	copyMeta := map[string]any{}
	for key, value := range meta {
		copyMeta[key] = value
	}
	copy["metadata"] = copyMeta
	for _, candidate := range candidates {
		copyMeta["content"] = candidate
		if productionTargetHash(copy) == m.Plan.SummaryHash {
			return candidate, true
		}
	}
	return "", false
}

func productionPlanSummaryCandidates(m productionManifest) []string {
	n := len(m.Plan.Assets)
	contents := []string{
		fmt.Sprintf("制作方案已保存：故事总纲及 %d 项计划资产设定。\n\n资产清单覆盖检查通过，内容质量可抽查。", n),
		fmt.Sprintf("制作方案已完成：故事总纲、资产总表及全部制作规范。\n\n已登记 %d 项计划资产，尚未创建资产档案；可在资产总表中选择并生成资产。", n),
	}
	if len(m.Plan.SelectedAssetKeys) > 0 {
		contents = append(contents, fmt.Sprintf("制作方案已完成，本次所选 %d 项资产档案已保存。\n\n清单共 %d 项资产；其他未生成项可在详情中选择后生成。", len(m.Plan.SelectedAssetKeys), n))
	}
	for i, content := range contents {
		for _, kind := range planKinds(m) {
			if reason := m.Plan.Absent[kind]; reason != "" {
				content += "\n" + kind + "：" + reason
			}
		}
		contents[i] = content
	}
	if m.Plan.SummaryContent != "" {
		contents = append(contents, m.Plan.SummaryContent)
	}
	return contents
}

// Called only inside the explicit start transaction, before selecting a new
// batch. Restore the exact checkpoint, never accept the stale text as a new one.
func productionRepairPlanSummaryCheckpoint(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, policy RuntimePolicySetting) (bool, error) {
	if m.Plan.SummaryHash == "" {
		return false, nil
	}
	target := productionNode(doc, state.Request.Production.TargetNodeID)
	if productionTargetHash(target) == m.Plan.SummaryHash {
		return false, nil
	}
	content, ok := productionPlanSummaryCheckpoint(target, run.ID, m)
	if !ok {
		return false, BadAuthRequest("目标提取记录或来源关联已人工修改，未覆盖")
	}
	canvas, err := repo.CanvasProjectForUser(run.UserID, state.Request.CanvasID)
	if err != nil {
		return false, err
	}
	target["metadata"].(map[string]any)["content"] = content
	root := productionWorkflow(productionNode(doc, m.FrameID))
	root["planAssetsStarted"] = m.Plan.AssetsStarted
	before := canvas.PayloadJSON
	if err := saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
		return false, err
	}
	return true, emitCloudAgentCanvasChange(repo, run.ID, state, cloudAgentMutationInput{UserID: run.UserID, CanvasID: canvas.ID, Operation: "production_summary_restore", BeforeJSON: before})
}
