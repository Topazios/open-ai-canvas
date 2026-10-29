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
	_, m, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		return false, err
	}
	if m.Plan == nil || m.Plan.Version < 2 || !m.Plan.Complete || len(m.Plan.Assets) == 0 {
		return false, nil
	}
	if !m.Plan.AssetsStarted {
		return false, nil
	}
	rows, err := s.repo.ProductionAgentArtifacts(userID, runID)
	if err != nil {
		return false, err
	}
	if !productionPlanStandardsReady(m, doc, rows) {
		return false, nil
	}
	forceLayout := len(relayout) > 0 && relayout[0]
	needed := forceLayout
	for _, item := range m.Plan.Assets {
		if !productionPlanAssetSelected(m, item.Key) {
			continue
		}
		if m.Plan.Groups[productionPlanGroupKind(item)] == "" {
			needed = true
			continue
		}
		if productionPlanArtifactValid(m, doc, rows, item.Key) {
			continue
		}
		placeholderExists := false
		for _, node := range creationMaps(doc["nodes"]) {
			workflow := productionWorkflow(node)
			placeholder, _ := workflow["planGeneration"].(map[string]any)
			if workflow["assetKey"] == item.Key && placeholder["runId"] == runID {
				_, placeholderExists = workflow["sourceNodeIds"].([]any)
				if !placeholderExists {
					needed = true
				}
				break
			}
		}
		if !placeholderExists {
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
		_, m, doc, err := productionLoad(repo, current, &fresh)
		if err != nil {
			return err
		}
		rows, err := repo.ProductionAgentArtifacts(userID, runID)
		if err != nil {
			return err
		}
		selectedGroupKinds := map[string]bool{}
		for _, item := range m.Plan.Assets {
			kind := productionPlanGroupKind(item)
			if m.Plan.Groups[kind] == "" && productionPlanAssetSelected(m, item.Key) {
				selectedGroupKinds[kind] = true
			}
		}
		regroup := false
		rehashKeys := map[string]bool{}
		for _, a := range rows {
			node := productionNode(doc, a.NodeID)
			if node == nil {
				return BadAuthRequest("已有文稿被修改或移动，未自动重新分组：" + a.Key)
			}
			item := productionPlanItem(m, a.Key)
			kind := ""
			if item != nil {
				kind = productionPlanGroupKind(*item)
			}
			willMove := node["parentId"] != productionPlanParent(m, a.Key) || selectedGroupKinds[kind]
			if !willMove {
				continue
			}
			if !productionArtifactMatches(node, a.ContentHash) {
				return BadAuthRequest("已有文稿被修改或移动，未自动重新分组：" + a.Key)
			}
			regroup = true
			rehashKeys[a.Key] = true
		}
		// Moving a receipt changes the dependency hash of its descendants. Keep
		// their receipts consistent, while leaving unrelated edited documents alone.
		for changed := true; changed; {
			changed = false
			for _, a := range rows {
				if rehashKeys[a.Key] {
					continue
				}
				for dependency := range productionPlanDependencies(m, rows, a.Key) {
					if rehashKeys[dependency] {
						rehashKeys[a.Key] = true
						changed = true
						break
					}
				}
			}
		}
		for _, a := range rows {
			if !rehashKeys[a.Key] {
				continue
			}
			if !productionArtifactMatches(productionNode(doc, a.NodeID), a.ContentHash) {
				return BadAuthRequest("已有文稿被修改或移动，未自动重新分组：" + a.Key)
			}
		}
		// New sibling groups do not change asset receipts. Only migrating
		// existing assets must wait for all responses to be committed.
		if regroup {
			if fresh.ActiveTaskID != "" {
				return repository.ErrCreationConflict
			}
			for _, work := range fresh.ProductionParallel {
				if work.TaskID == "" {
					continue
				}
				task, err := repo.TaskForUser(userID, work.TaskID)
				if err != nil {
					return err
				}
				if !cloudAgentTaskTerminal(task.Status) || (task.Status == model.TaskStatusSucceeded && work.Error == "") {
					return repository.ErrCreationConflict
				}
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
			selected := false
			for _, item := range m.Plan.Assets {
				if productionPlanGroupKind(item) == kind {
					count++
					selected = selected || productionPlanAssetSelected(m, item.Key)
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
			if !selected {
				continue
			}
			id := "pg-" + newID()
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
			previousParent := node["parentId"]
			node["parentId"] = parent
			ids[parent] = append(ids[parent], a.NodeID)
			if regroup && previousParent != parent && parent != m.FrameID {
				wd := productionWorkflow(node)
				wd["sourceNodeIds"], wd["sourceSignatures"], wd["sourceSteps"] = []string{m.FrameID}, map[string]string{}, []string{"story.plan"}
			}
		}
		for _, item := range m.Plan.Assets {
			if !productionPlanAssetSelected(m, item.Key) || productionPlanArtifactValid(m, doc, rows, item.Key) {
				continue
			}
			placeholderExists := false
			for _, node := range nodes {
				workflow := productionWorkflow(node)
				placeholder, _ := workflow["planGeneration"].(map[string]any)
				if workflow["assetKey"] == item.Key && placeholder["runId"] == runID {
					workflow["sourceNodeIds"] = []string{m.FrameID}
					workflow["sourceSignatures"] = map[string]string{}
					workflow["sourceSteps"] = []string{"story.plan"}
					workflow["pipelineId"] = data["pipelineId"]
					workflow["parameters"] = data["parameters"]
					workflow["version"] = data["version"]
					placeholderExists = true
					break
				}
			}
			if placeholderExists {
				continue
			}
			parent := productionPlanParent(m, item.Key)
			frame := productionNode(doc, parent)
			if frame == nil {
				return BadAuthRequest("资产目标分组已删除，未创建排队节点")
			}
			framePosition, _ := frame["position"].(map[string]any)
			index := 0
			for _, existing := range nodes {
				if existing["parentId"] == parent && productionWorkflow(existing)["assetKey"] != "$summary" {
					index++
				}
			}
			id := "pap-" + productionHash([]string{runID, item.Key})[:32]
			if productionNode(doc, id) != nil {
				id = "pap-" + newID()
			}
			workflow := map[string]any{
				"stage": "story", "step": "story.plan", "pipelineId": data["pipelineId"],
				"role": "document", "assetKey": item.Key, "sourceNodeIds": []string{m.FrameID},
				"sourceSignatures": map[string]string{}, "sourceSteps": []string{"story.plan"},
				"parameters": data["parameters"], "version": data["version"],
				"planVersion":    m.Plan.Version,
				"planAsset":      map[string]any{"key": item.Key, "kind": item.Kind, "name": item.Name, "episodes": item.Episodes, "purpose": item.Purpose, "plannedRange": item.PlannedRange},
				"planGeneration": map[string]any{"runId": runID, "status": "queued"},
			}
			node := map[string]any{
				"id": id, "type": "text", "title": item.Name, "parentId": parent,
				"width": 400, "height": 280,
				"position":  map[string]any{"x": numberValue(framePosition["x"], 0) + 24 + float64(index%3)*424, "y": numberValue(framePosition["y"], 0) + 100 + float64(index/3)*productionPlanRowPitch},
				"createdAt": time.Now().UnixMilli(),
				"metadata":  map[string]any{"content": "等待生成", "status": "processing", "generationMode": "text", "shortDrama": workflow},
			}
			nodes = append(nodes, node)
			ids[parent] = append(ids[parent], id)
		}
		doc["nodes"] = nodes
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
				if !rehashKeys[dependency] {
					continue
				}
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
			if rehashKeys[rows[i].Key] {
				if err := rehash(i); err != nil {
					return err
				}
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
