package app

import (
	"encoding/json"
	"sort"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

var productionPlanGroupKinds = []string{"character", "environment", "prop", "special", "sound"}
var productionPlanGroupLabels = map[string]string{"character": "人物资产", "environment": "场景资产", "prop": "道具资产", "special": "特殊资产", "sound": "声音资产"}

// Titles sit above text nodes, so a row needs more than the card-to-card gap.
const productionPlanRowPitch = 336

func productionPlanGroupKind(item productionPlanAsset) string {
	if cloudAgentContainsString(productionCurrentPlanKinds, item.GroupKind) {
		return item.GroupKind
	}
	return item.Kind
}

func productionPlanParent(m productionManifest, key string) string {
	if m.Plan != nil {
		if item := productionPlanItem(m, key); item != nil {
			if id := m.Plan.Groups[productionPlanGroupKind(*item)]; id != "" {
				return id
			}
		}
	}
	return m.FrameID
}

func productionLayoutPlanGroup(m productionManifest, frame map[string]any, nodes []map[string]any) {
	order := map[string]int{"story": 0, "inventory": 1, "visual": 2, "direction": 3, "generation": 4}
	if frame["id"] != m.FrameID {
		order = map[string]int{}
		for i, item := range m.Plan.Assets {
			order[item.Key] = i
		}
	}
	members := []map[string]any{}
	for _, node := range nodes {
		if node["parentId"] == frame["id"] && productionWorkflow(node)["assetKey"] != "$summary" {
			members = append(members, node)
		}
	}
	sort.SliceStable(members, func(i, j int) bool {
		return order[stringValue(productionWorkflow(members[i])["assetKey"])] < order[stringValue(productionWorkflow(members[j])["assetKey"])]
	})
	p, _ := frame["position"].(map[string]any)
	x, y := numberValue(p["x"], 0), numberValue(p["y"], 0)
	for i, node := range members {
		node["position"] = map[string]any{"x": x + 24 + float64(i%3)*424, "y": y + 100 + float64(i/3)*productionPlanRowPitch}
		node["width"], node["height"] = 400, 280
	}
	height := float64(124 + max(1, (len(members)+2)/3)*productionPlanRowPitch)
	meta, _ := frame["metadata"].(map[string]any)
	if meta == nil {
		meta = map[string]any{}
		frame["metadata"] = meta
	}
	geometry, _ := meta["frame"].(map[string]any)
	if geometry == nil {
		geometry = map[string]any{}
		meta["frame"] = geometry
	}
	geometry["expandedWidth"], geometry["expandedHeight"] = 1296, height
	if geometry["collapsed"] != true {
		frame["width"], frame["height"] = 1296, height
	}
}

// Move only verified generated artifacts. Updating their receipts in dependency
// order keeps regrouping distinct from a user edit and preserves asset codes.
func (s *Service) ensureProductionPlanGroups(userID, runID string, relayout ...bool) (bool, error) {
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return false, err
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		return false, err
	}
	_, m, _, err := productionLoad(s.repo, run, &state)
	if err != nil {
		return false, err
	}
	if m.Plan == nil || m.Plan.Version < 2 || !m.Plan.Complete || len(m.Plan.Assets) == 0 {
		return false, nil
	}
	forceLayout := len(relayout) > 0 && relayout[0]
	needed := forceLayout
	for _, item := range m.Plan.Assets {
		if m.Plan.Groups[productionPlanGroupKind(item)] == "" {
			needed = true
		}
	}
	if !needed {
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
		if len(fresh.ProductionParallel) > 0 || fresh.ActiveTaskID != "" {
			return repository.ErrCreationConflict
		}
		_, m, doc, err := productionLoad(repo, current, &fresh)
		if err != nil {
			return err
		}
		rows, err := repo.ProductionAgentArtifacts(userID, runID)
		if err != nil {
			return err
		}
		for _, a := range rows {
			node := productionNode(doc, a.NodeID)
			if node == nil || node["parentId"] != productionPlanParent(m, a.Key) || !productionArtifactMatches(node, a.ContentHash) {
				return BadAuthRequest("已有文稿被修改或移动，未自动重新分组：" + a.Key)
			}
		}
		canvas, err := repo.CanvasProjectForUser(userID, fresh.Request.CanvasID)
		if err != nil {
			return err
		}
		before := canvas.PayloadJSON
		root := productionNode(doc, m.FrameID)
		data := productionWorkflow(root)
		nodes := creationMaps(doc["nodes"])
		edges := creationMaps(doc["connections"])
		if m.Plan.Groups == nil {
			m.Plan.Groups = map[string]string{}
		}
		p, _ := root["position"].(map[string]any)
		x, y := numberValue(p["x"], 0), numberValue(p["y"], 0)
		columnBottom := [2]float64{y, y}
		for i, kind := range productionPlanGroupKinds {
			count := 0
			for _, item := range m.Plan.Assets {
				if productionPlanGroupKind(item) == kind {
					count++
				}
			}
			if count == 0 {
				continue
			}
			if id := m.Plan.Groups[kind]; id != "" {
				if forceLayout {
					productionNode(doc, id)["position"] = map[string]any{"x": x + float64(i%2+1)*1380, "y": columnBottom[i%2]}
				}
				columnBottom[i%2] += float64(124 + ((count+2)/3)*productionPlanRowPitch + 96)
				continue
			}
			id := "pg-" + productionHash([]string{m.FrameID, kind})[:28]
			if productionNode(doc, id) != nil {
				return BadAuthRequest("分组标识已占用，未覆盖")
			}
			m.Plan.Groups[kind] = id
			group := map[string]any{"id": id, "type": "frame", "title": productionPlanGroupLabels[kind], "width": 1296, "height": 428, "position": map[string]any{"x": x + float64(i%2+1)*1380, "y": columnBottom[i%2]}, "createdAt": time.Now().UnixMilli(), "metadata": map[string]any{"frame": map[string]any{"collapsed": false, "expandedWidth": 1296, "expandedHeight": 428}, "shortDrama": map[string]any{"stage": "story", "step": "story.plan", "role": "collection", "planVersion": 2, "planGroup": map[string]any{"rootFrameId": m.FrameID, "kind": kind}, "pipelineId": data["pipelineId"], "version": data["version"], "parameters": data["parameters"], "sourceNodeIds": []string{}, "sourceSignatures": map[string]string{}, "collectionSourceIds": []string{m.FrameID}, "assetGroup": map[string]any{"manifestId": fresh.Request.Production.TargetNodeID}}}}
			columnBottom[i%2] += float64(124 + ((count+2)/3)*productionPlanRowPitch + 96)
			productionWorkflow(group)["planVersion"] = m.Plan.Version
			nodes = append(nodes, group)
			edges = append(edges, map[string]any{"id": "pe-" + productionHash(id)[:28], "fromNodeId": m.FrameID, "toNodeId": id})
		}
		doc["nodes"], doc["connections"] = nodes, edges
		data["planGroups"] = m.Plan.Groups
		ids := map[string][]string{m.FrameID: {fresh.Request.Production.TargetNodeID}}
		for _, id := range m.Plan.Groups {
			ids[id] = []string{}
		}
		for _, a := range rows {
			node := productionNode(doc, a.NodeID)
			parent := productionPlanParent(m, a.Key)
			node["parentId"] = parent
			ids[parent] = append(ids[parent], a.NodeID)
			if parent != m.FrameID {
				wd := productionWorkflow(node)
				wd["sourceNodeIds"], wd["sourceSignatures"], wd["sourceSteps"] = []string{m.FrameID}, map[string]string{}, []string{"story.plan"}
			}
		}
		for id, members := range ids {
			productionWorkflow(productionNode(doc, id))["sourceNodeIds"] = members
		}
		// Topological rehash: a parentId change changes the receipt of an asset,
		// which must be reflected in dependent assets and final generation rules.
		done := map[string]bool{}
		var rehash func(int) error
		rehash = func(index int) error {
			a := &rows[index]
			if done[a.Key] {
				return nil
			}
			done[a.Key] = true
			for dependency := range productionPlanDependencies(m, rows, a.Key) {
				for j := range rows {
					if rows[j].Key == dependency {
						if err := rehash(j); err != nil {
							return err
						}
					}
				}
			}
			node := productionNode(doc, a.NodeID)
			productionWorkflow(node)["planDependencies"] = productionPlanDependencies(m, rows, a.Key)
			a.ContentHash = productionArtifactHash(node)
			return repo.UpdateProductionAgentArtifact(a)
		}
		for i := range rows {
			if err := rehash(i); err != nil {
				return err
			}
		}
		productionLayoutPlanGroup(m, root, nodes)
		for _, kind := range productionPlanGroupKinds {
			if id := m.Plan.Groups[kind]; id != "" {
				productionLayoutPlanGroup(m, productionNode(doc, id), nodes)
			}
		}
		// All children must have their new coordinates before collision checks;
		// otherwise the former root mistakes its just-moved assets for obstacles.
		frames := []map[string]any{root}
		for _, kind := range productionPlanGroupKinds {
			if id := m.Plan.Groups[kind]; id != "" {
				frames = append(frames, productionNode(doc, id))
			}
		}
		for _, frame := range frames {
			meta, _ := frame["metadata"].(map[string]any)
			geometry, _ := meta["frame"].(map[string]any)
			if geometry["collapsed"] != true {
				productionFitFrame(frame, nodes, numberValue(frame["height"], 428))
			}
		}
		encoded, _ := json.Marshal(m)
		if err := repo.UpdateProductionAgentManifest(userID, runID, string(encoded)); err != nil {
			return err
		}
		if err := saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
			return err
		}
		if err := emitCloudAgentCanvasChange(repo, runID, &fresh, cloudAgentMutationInput{UserID: userID, CanvasID: canvas.ID, Operation: "production_groups", BeforeJSON: before}); err != nil {
			return err
		}
		return cloudAgentSave(current, &fresh)
	})
	return err == nil, err
}
