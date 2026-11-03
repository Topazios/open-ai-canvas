package app

import (
	"encoding/json"
	"slices"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Plan document placeholders are created in the root container before any model
// output arrives. A v5 run starts with the story only; the other four appear
// when they are started. The submit path later fills the same node in place.

// productionPlanPlaceholderText is the body of a pre-created plan placeholder.
const productionPlanPlaceholderText = "等待生成"

// productionPlanPending reports whether a node is still an unfilled plan
// placeholder. The planGeneration marker is the primary signal; a node whose
// marker was dropped by a merge or normalization but whose body is still the
// placeholder text is treated the same way, so it is neither used as source
// material nor duplicated by the next placeholder pass.
func productionPlanPending(node map[string]any) bool {
	workflow := productionWorkflow(node)
	if workflow["planGeneration"] != nil {
		return true
	}
	meta, _ := node["metadata"].(map[string]any)
	return strings.TrimSpace(stringValue(meta["content"])) == productionPlanPlaceholderText && meta["status"] != "success" &&
		(workflow["planSection"] != nil || workflow["planAsset"] != nil)
}

// productionPlanPlaceholderOwned reports whether the node is the placeholder
// created for runID, tolerating a dropped planGeneration marker.
func productionPlanPlaceholderOwned(node map[string]any, runID string) bool {
	workflow := productionWorkflow(node)
	if marker, ok := workflow["planGeneration"].(map[string]any); ok {
		return marker["runId"] == runID
	}
	return productionPlanPending(node)
}

func productionPlanDocumentKeys(m productionManifest) []string {
	if m.Plan == nil || m.Plan.Version < 2 {
		return nil
	}
	// A v5 run lists only the story until the remaining documents are started;
	// their placeholders are created at that point, not before.
	if m.Plan.Version >= 5 && !m.Plan.PlansStarted {
		return []string{"story"}
	}
	return []string{"story", "inventory", "visual", "direction", "generation"}
}

// productionPlanDocumentPlaceholders adds missing document placeholders to the
// root container. It is idempotent and never touches keys that already have a
// saved receipt or a placeholder from the same run.
func productionPlanDocumentPlaceholders(m productionManifest, doc map[string]any, runID, targetID string, saved map[string]bool) bool {
	keys := productionPlanDocumentKeys(m)
	if len(keys) == 0 {
		return false
	}
	frame := productionNode(doc, m.FrameID)
	if frame == nil {
		return false
	}
	nodes := creationMaps(doc["nodes"])
	existing := map[string]bool{}
	for _, node := range nodes {
		workflow := productionWorkflow(node)
		if productionPlanPlaceholderOwned(node, runID) && workflow["planSection"] != nil && (node["parentId"] == m.FrameID || workflow["planSection"] == "story") {
			existing[stringValue(workflow["assetKey"])] = true
		}
	}
	data := productionWorkflow(productionNode(doc, targetID))
	if data == nil {
		data = map[string]any{}
	}
	framePosition, _ := frame["position"].(map[string]any)
	frameData := productionWorkflow(frame)
	ids := productionIDs(frameData["sourceNodeIds"])
	changed := false
	for _, key := range keys {
		if saved[key] || existing[key] {
			continue
		}
		section, ok := planSection(key)
		if !ok {
			continue
		}
		id := "pap-" + productionHash([]string{runID, key})[:32]
		if productionNode(doc, id) != nil {
			id = "pap-" + newID()
		}
		workflow := map[string]any{
			"stage": "story", "step": "story.plan", "pipelineId": data["pipelineId"],
			"role": "document", "assetKey": key, "sourceNodeIds": []string{m.FrameID},
			"sourceSignatures": map[string]string{}, "sourceSteps": []string{"story.plan"},
			"parameters": data["parameters"], "version": data["version"],
			"planVersion":    m.Plan.Version,
			"planSection":    key,
			"planGeneration": map[string]any{"runId": runID, "status": "queued"},
		}
		placeholderNode := map[string]any{
			"id": id, "type": "text", "title": section.Title,
			"width": 400, "height": 280,
			"position":  map[string]any{"x": numberValue(framePosition["x"], 0), "y": numberValue(framePosition["y"], 0)},
			"createdAt": time.Now().UnixMilli(),
			"metadata":  map[string]any{"content": "等待生成", "status": "processing", "generationMode": "text", "shortDrama": workflow},
		}
		placeholderNode["parentId"] = productionPlanParent(m, key)
		nodes = append(nodes, placeholderNode)
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
		changed = true
	}
	if !changed {
		return false
	}
	doc["nodes"] = nodes
	if frameData != nil {
		frameData["sourceNodeIds"] = ids
	}
	productionLayoutPlanGroup(m, frame, nodes)
	meta, _ := frame["metadata"].(map[string]any)
	geometry, _ := meta["frame"].(map[string]any)
	if geometry["collapsed"] != true {
		productionFitFrame(frame, nodes, numberValue(frame["height"], 428))
	}
	return true
}

func productionSavedKeys(rows []model.ProductionAgentArtifact) map[string]bool {
	saved := map[string]bool{}
	for _, row := range rows {
		saved[row.Key] = true
	}
	return saved
}

// cloneProductionDocument deep-copies a canvas document so a dry run cannot
// mutate the document that is later saved.
func cloneProductionDocument(doc map[string]any) map[string]any {
	raw, err := json.Marshal(doc)
	if err != nil {
		return map[string]any{}
	}
	out := map[string]any{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{}
	}
	return out
}

// ensureProductionPlanDocumentPlaceholders backfills placeholders for runs that
// started earlier or whose later documents were selected after the first step.
func (s *Service) ensureProductionPlanDocumentPlaceholders(userID, runID string) (bool, error) {
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return false, err
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		return false, err
	}
	if state.Request.Production == nil || cloudAgentRunTerminal(run.Status) || run.CleanupPending {
		return false, nil
	}
	_, m, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		return false, err
	}
	rows, err := s.repo.ProductionAgentArtifacts(userID, runID)
	if err != nil {
		return false, err
	}
	probe := cloneProductionDocument(doc)
	if !productionPlanDocumentPlaceholders(m, probe, runID, state.Request.Production.TargetNodeID, productionSavedKeys(rows)) {
		return false, nil
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return false, err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		fresh, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		_, m, doc, err := productionLoad(repo, current, &fresh)
		if err != nil {
			return err
		}
		rows, err := repo.ProductionAgentArtifacts(userID, runID)
		if err != nil {
			return err
		}
		canvas, err := repo.CanvasProjectForUser(userID, fresh.Request.CanvasID)
		if err != nil {
			return err
		}
		before := canvas.PayloadJSON
		if !productionPlanDocumentPlaceholders(m, doc, runID, fresh.Request.Production.TargetNodeID, productionSavedKeys(rows)) {
			return nil
		}
		if err := saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
			return err
		}
		if err := emitCloudAgentCanvasChange(repo, runID, &fresh, cloudAgentMutationInput{UserID: userID, CanvasID: canvas.ID, Operation: "production_placeholders", BeforeJSON: before}); err != nil {
			return err
		}
		return cloudAgentSave(current, &fresh)
	})
	return err == nil, err
}
