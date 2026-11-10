package app

import (
	"encoding/json"
	"errors"
	"slices"
	"sort"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

var productionPlanGroupKinds = []string{"character", "environment", "prop", "special", "sound"}
var productionPlanGroupLabels = map[string]string{"character": "人物资产", "environment": "场景资产", "prop": "道具资产", "special": "特殊资产", "sound": "声音资产"}

// Titles sit above text nodes, so a row needs more than the card-to-card gap.
const productionPlanRowPitch = 336

// The outline card spans the container width; the gap separates it from the rule grid.
const (
	productionPlanLeadWidth  = 1248.0
	productionPlanLeadHeight = 320.0
	productionPlanLeadGap    = 40.0
)

func productionPlanGroupKind(item productionPlanAsset) string {
	if cloudAgentContainsString(productionCurrentPlanKinds, item.GroupKind) {
		return item.GroupKind
	}
	return item.Kind
}

func productionPlanAssetGroupNode(m productionManifest, kind, id, targetID string, data map[string]any, x, y float64) map[string]any {
	return map[string]any{
		"id": id, "type": "frame", "title": productionPlanGroupLabels[kind], "width": 1296, "height": 428,
		"position": map[string]any{"x": x, "y": y}, "createdAt": time.Now().UnixMilli(),
		"metadata": map[string]any{"frame": map[string]any{"collapsed": false, "expandedWidth": 1296, "expandedHeight": 428},
			"shortDrama": map[string]any{
				"stage": "story", "step": "story.plan", "role": "collection", "planVersion": m.Plan.Version,
				"planGroup":  map[string]any{"rootFrameId": m.FrameID, "kind": kind},
				"pipelineId": data["pipelineId"], "version": data["version"], "parameters": data["parameters"],
				"sourceNodeIds": []string{}, "sourceSignatures": map[string]string{}, "collectionSourceIds": []string{m.FrameID},
				"assetGroup": map[string]any{"manifestId": targetID},
			}},
	}
}

// Unlike materialization this needs neither an asset count nor model output.
// A selected empty category is visible while its inventory is being extracted.
func productionAdmitAssetGroupFrames(m productionManifest, doc map[string]any, targetID string, kinds map[string]bool) {
	root := productionNode(doc, m.FrameID)
	data := productionWorkflow(root)
	if m.Plan.Groups == nil {
		m.Plan.Groups = map[string]string{}
	}
	nodes, edges := creationMaps(doc["nodes"]), creationMaps(doc["connections"])
	p, _ := root["position"].(map[string]any)
	x, y := numberValue(p["x"], 0), numberValue(p["y"], 0)
	bottom := [2]float64{y, y}
	for i, kind := range productionPlanGroupKinds {
		if existing := productionNode(doc, m.Plan.Groups[kind]); existing != nil {
			position, _ := existing["position"].(map[string]any)
			bottom[i%2] = max(bottom[i%2], numberValue(position["y"], y)+numberValue(existing["height"], 428)+96)
			continue
		}
		if !kinds[kind] {
			continue
		}
		id := "pg-" + newID()
		group := productionPlanAssetGroupNode(m, kind, id, targetID, data, x+float64(i%2+1)*1380, bottom[i%2])
		nodes = append(nodes, group)
		productionFitFrame(group, nodes, 428)
		bottom[i%2] = numberValue(group["position"].(map[string]any)["y"], bottom[i%2]) + numberValue(group["height"], 428) + 96
		m.Plan.Groups[kind] = id
		edges = append(edges, map[string]any{"id": "pe-" + productionHash(id)[:28], "fromNodeId": m.FrameID, "toNodeId": id})
	}
	doc["nodes"], doc["connections"] = nodes, edges
	data["planGroups"] = m.Plan.Groups
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

func productionAssetTargetPresent(m productionManifest, doc map[string]any, key string) bool {
	item := productionPlanItem(m, key)
	if item == nil {
		return true
	}
	groupID := m.Plan.Groups[productionPlanGroupKind(*item)]
	group := productionNode(doc, groupID)
	if groupID == "" || group == nil || group["type"] != "frame" {
		return false
	}
	node := productionNode(doc, m.Plan.AssetPlaceholderNodeIDs[key])
	return node != nil && node["parentId"] == groupID && productionWorkflow(node)["assetKey"] == key
}

// productionPlanParentMatches compares a node's parentId with the expected
// one. Canvases saved while the outline was detached have it with no parent;
// that value is still accepted for the outline so they keep validating until
// productionAttachLegacyStory moves it back into the container.
func productionPlanParentMatches(m productionManifest, key string, node map[string]any) bool {
	parent := stringValue(node["parentId"])
	if key == "story" && parent == "" && m.Plan != nil && m.Plan.Version >= 2 {
		return true
	}
	return parent == productionPlanParent(m, key)
}
func productionLayoutPlanGroup(m productionManifest, frame map[string]any, nodes []map[string]any) {
	order := map[string]int{"story": 0, "inventory": 1, "visual": 2, "direction": 3, "generation": 4}
	var orderedAssets []productionPlanAsset
	if frame["id"] != m.FrameID {
		order = map[string]int{}
		orderedAssets = append([]productionPlanAsset{}, m.Plan.Assets...)
		sortProductionPlanAssets(orderedAssets)
		for i, item := range orderedAssets {
			order[item.Key] = i
		}
	}
	members := []map[string]any{}
	for _, node := range nodes {
		if node["parentId"] == frame["id"] && productionWorkflow(node)["assetKey"] != "$summary" {
			members = append(members, node)
		}
	}
	if frame["id"] != m.FrameID {
		members = productionCurrentAssetMembers(members)
	}
	sort.SliceStable(members, func(i, j int) bool {
		left, right := productionWorkflow(members[i]), productionWorkflow(members[j])
		li, lok := order[stringValue(left["assetKey"])]
		ri, rok := order[stringValue(right["assetKey"])]
		if lok != rok {
			return lok
		}
		if li != ri {
			return li < ri
		}
		return numberValue(left["assetVersion"], 1) < numberValue(right["assetVersion"], 1)
	})
	p, _ := frame["position"].(map[string]any)
	x, y := numberValue(p["x"], 0), numberValue(p["y"], 0)
	// The root container shows the outline as a full-width lead card, with the
	// supporting rule documents in a grid below it.
	var lead map[string]any
	if frame["id"] == m.FrameID && len(members) > 0 && stringValue(productionWorkflow(members[0])["assetKey"]) == "story" {
		lead, members = members[0], members[1:]
	}
	gridTop := y + 100
	// Match the client: no row gap after the final row, just bottom padding.
	rows := max(1, (len(members)+2)/3)
	height := float64(124 + rows*productionPlanRowPitch - (productionPlanRowPitch - 280))
	if len(members) == 0 {
		height = 240
	}
	if lead != nil {
		lead["position"] = map[string]any{"x": x + 24, "y": y + 100}
		lead["width"], lead["height"] = productionPlanLeadWidth, productionPlanLeadHeight
		gridTop = y + 100 + productionPlanLeadHeight + productionPlanLeadGap
		rows := (len(members) + 2) / 3
		height = 100 + productionPlanLeadHeight + productionPlanLeadGap + 24
		if rows > 0 {
			height += float64(rows)*productionPlanRowPitch - (productionPlanRowPitch - 280)
		}
	}
	for i, node := range members {
		node["position"] = map[string]any{"x": x + 24 + float64(i%3)*424, "y": gridTop + float64(i/3)*productionPlanRowPitch}
		node["width"], node["height"] = 400, 280
	}
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
	if frame["id"] != m.FrameID {
		keys := []string{}
		for _, item := range orderedAssets {
			if m.Plan.Groups[productionPlanGroupKind(item)] == stringValue(frame["id"]) {
				keys = append(keys, item.Key)
			}
		}
		geometry["assetOrder"] = keys
	}
	geometry["expandedWidth"], geometry["expandedHeight"] = 1296, height
	if geometry["collapsed"] != true {
		frame["width"], frame["height"] = 1296, height
	}
}

func productionAdmitAssetTargets(m productionManifest, doc map[string]any, rows []model.ProductionAgentArtifact, runID, targetID string, selectedKinds map[string]bool) {
	productionAdmitAssetGroupFrames(m, doc, targetID, selectedKinds)
	if m.Plan.AssetsStarted {
		if m.Plan.AssetPlaceholderNodeIDs == nil {
			m.Plan.AssetPlaceholderNodeIDs = map[string]string{}
		}
		members := map[string][]string{}
		for _, id := range m.Plan.Groups {
			members[id] = []string{}
		}
		for _, node := range creationMaps(doc["nodes"]) {
			if parent := stringValue(node["parentId"]); members[parent] != nil {
				members[parent] = append(members[parent], stringValue(node["id"]))
			}
		}
		productionMaterializeAssetPlaceholders(m, doc, rows, runID, productionWorkflow(productionNode(doc, m.FrameID)), members)
		for id, ids := range members {
			if frame := productionNode(doc, id); frame != nil {
				productionWorkflow(frame)["sourceNodeIds"] = ids
				productionLayoutPlanGroup(m, frame, creationMaps(doc["nodes"]))
			}
		}
	}
}

// Both category admission and explicit asset-key retries publish targets before
// waking the scheduler. The caller owns the run/canvas transaction.
func productionPersistAssetTargets(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, rows []model.ProductionAgentArtifact, policy RuntimePolicySetting) error {
	kinds := map[string]bool{}
	for _, item := range m.Plan.Assets {
		if productionPlanAssetSelected(m, item.Key) {
			kinds[productionPlanGroupKind(item)] = true
		}
	}
	canvas, err := repo.CanvasProjectForUser(run.UserID, state.Request.CanvasID)
	if err != nil {
		return err
	}
	before := canvas.PayloadJSON
	productionAdmitAssetTargets(m, doc, rows, run.ID, state.Request.Production.TargetNodeID, kinds)
	encoded, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err := repo.UpdateProductionAgentManifest(run.UserID, run.ID, string(encoded)); err != nil {
		return err
	}
	if err := saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
		return err
	}
	return emitCloudAgentCanvasChange(repo, run.ID, state, cloudAgentMutationInput{UserID: run.UserID, CanvasID: canvas.ID, Operation: "production_asset_targets", BeforeJSON: before})
}

// Materialize selected assets before scheduling any model work. Admission and
// recovery share this path, so a task cannot get ahead of its visible target.
func productionMaterializeAssetPlaceholders(m productionManifest, doc map[string]any, rows []model.ProductionAgentArtifact, runID string, data map[string]any, ids map[string][]string, fences ...map[string]bool) {
	nodes := creationMaps(doc["nodes"])
	byID := make(map[string]map[string]any, len(nodes))
	placeholders := map[string]map[string]any{}
	counts := map[string]int{}
	for _, node := range nodes {
		byID[stringValue(node["id"])] = node
		if workflow := productionWorkflow(node); workflow != nil {
			if productionPlanPlaceholderOwned(node, runID) {
				placeholders[stringValue(workflow["assetKey"])] = node
			}
			if workflow["assetKey"] == "$summary" {
				continue
			}
		}
		counts[stringValue(node["parentId"])]++
	}
	for _, item := range m.Plan.Assets {
		if len(fences) > 0 && (fences[0][m.Plan.AssetPlaceholderNodeIDs[item.Key]] || fences[0][m.Plan.Groups[productionPlanGroupKind(item)]]) {
			continue
		}
		if !productionPlanAssetSelected(m, item.Key) || productionPlanArtifactValid(m, doc, rows, item.Key) {
			continue
		}
		placeholderExists := false
		if candidate := placeholders[item.Key]; candidate != nil {
			workflow := productionWorkflow(candidate)
			if workflow["assetKey"] == item.Key && productionPlanPlaceholderOwned(candidate, runID) {
				m.Plan.AssetPlaceholderNodeIDs[item.Key] = stringValue(candidate["id"])
				workflow["sourceNodeIds"] = []string{m.FrameID}
				workflow["sourceSignatures"] = map[string]string{}
				workflow["sourceSteps"] = []string{"story.plan"}
				workflow["pipelineId"] = data["pipelineId"]
				workflow["parameters"] = data["parameters"]
				workflow["version"] = data["version"]
				// A kept placeholder may still point at a group the user deleted.
				// Move it into the current group so a later write cannot leave it
				// under the stale parent.
				if target := m.Plan.Groups[productionPlanGroupKind(item)]; byID[target] != nil && candidate["parentId"] != target {
					candidate["parentId"] = target
					if _, ok := ids[target]; ok {
						if id := stringValue(candidate["id"]); !slices.Contains(ids[target], id) {
							ids[target] = append(ids[target], id)
						}
					}
				}
				placeholderExists = true
			}
		}
		if placeholderExists {
			continue
		}
		parent := m.Plan.Groups[productionPlanGroupKind(item)]
		frame := byID[parent]
		if frame == nil {
			// The target container was deleted. Skip this item so other
			// groups keep progressing; it is queued again with a new group.
			continue
		}
		framePosition, _ := frame["position"].(map[string]any)
		index := counts[parent]
		counts[parent]++
		id := "pap-" + newID()
		for byID[id] != nil {
			id = "pap-" + newID()
		}
		m.Plan.AssetPlaceholderNodeIDs[item.Key] = id
		workflow := map[string]any{
			"stage": "story", "step": "story.plan", "pipelineId": data["pipelineId"],
			"role": "document", "assetKey": item.Key, "sourceNodeIds": []string{m.FrameID},
			"sourceSignatures": map[string]string{}, "sourceSteps": []string{"story.plan"},
			"parameters": data["parameters"], "version": data["version"],
			"planVersion":    m.Plan.Version,
			"planAsset":      map[string]any{"key": item.Key, "kind": item.Kind, "name": item.Name, "priority": item.Priority, "episodes": item.Episodes, "purpose": item.Purpose, "plannedRange": item.PlannedRange, "coreFacts": item.CoreFacts, "aliases": item.Aliases, "variants": item.Variants, "origin": item.Origin},
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
		byID[id] = node
		ids[parent] = append(ids[parent], id)
	}
	doc["nodes"] = nodes
}

func (s *Service) ensureProductionPlanGroups(userID, runID string, relayout ...bool) (bool, error) {
	var changed bool
	var err error
	for attempt := 0; attempt < 8; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 50 * time.Millisecond)
		}
		changed, err = s.ensureProductionPlanGroupsOnce(userID, runID, relayout...)
		if !errors.Is(err, repository.ErrCreationConflict) {
			return changed, err
		}
	}
	return false, err
}

func (s *Service) ensureProductionPlanGroupsOnce(userID, runID string, relayout ...bool) (bool, error) {
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return false, err
	}
	if cloudAgentRunTerminal(run.Status) || run.CleanupPending {
		return false, nil
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
	// Creating a missing group only needs the outline to exist. A hand-edited
	// outline must not stop the container from being rebuilt.
	if !productionPlanStoryPresent(m, doc, rows) {
		return false, nil
	}
	forceLayout := len(relayout) > 0 && relayout[0]
	receipts, err := s.repo.CanvasNodeDeletionReceipts(userID, state.Request.CanvasID)
	if err != nil {
		return false, err
	}
	deleted := map[string]bool{}
	for _, receipt := range receipts {
		deleted[receipt.NodeID] = true
	}
	needed := forceLayout
	for _, item := range m.Plan.Assets {
		if !productionPlanAssetSelected(m, item.Key) {
			continue
		}
		groupID := m.Plan.Groups[productionPlanGroupKind(item)]
		if deleted[groupID] || deleted[m.Plan.AssetPlaceholderNodeIDs[item.Key]] {
			continue
		}
		if groupID == "" || productionNode(doc, groupID) == nil {
			needed = true
			continue
		}
		if productionPlanArtifactValid(m, doc, rows, item.Key) {
			continue
		}
		placeholderExists := false
		for _, node := range creationMaps(doc["nodes"]) {
			workflow := productionWorkflow(node)
			if workflow["assetKey"] == item.Key && productionPlanPlaceholderOwned(node, runID) {
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
		receipts, err := repo.CanvasNodeDeletionReceipts(userID, fresh.Request.CanvasID)
		if err != nil {
			return err
		}
		deleted := map[string]bool{}
		for _, receipt := range receipts {
			deleted[receipt.NodeID] = true
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
				// The user deleted this document. There is nothing to migrate, and
				// it must not block creating the groups that are still missing.
				continue
			}
			item := productionPlanItem(m, a.Key)
			kind := ""
			if item != nil {
				kind = productionPlanGroupKind(*item)
			}
			willMove := !productionPlanParentMatches(m, a.Key, node) || selectedGroupKinds[kind]
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
				if productionNode(doc, a.NodeID) == nil {
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
		if m.Plan.AssetPlaceholderNodeIDs == nil {
			m.Plan.AssetPlaceholderNodeIDs = map[string]string{}
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
			if id := m.Plan.Groups[kind]; id != "" && (productionNode(doc, id) != nil || deleted[id]) {
				if forceLayout && productionNode(doc, id) != nil {
					productionNode(doc, id)["position"] = map[string]any{"x": x + float64(i%2+1)*1380, "y": columnBottom[i%2]}
				}
				columnBottom[i%2] += float64(124 + ((count+2)/3)*productionPlanRowPitch + 96)
				continue
			}
			if !selected {
				continue
			}
			id := m.Plan.Groups[kind]
			if id == "" {
				id = "pg-" + newID()
			}
			if productionNode(doc, id) != nil {
				return BadAuthRequest("分组标识已占用，未覆盖")
			}
			m.Plan.Groups[kind] = id
			group := productionPlanAssetGroupNode(m, kind, id, fresh.Request.Production.TargetNodeID, data, x+float64(i%2+1)*1380, columnBottom[i%2])
			columnBottom[i%2] += float64(124 + ((count+2)/3)*productionPlanRowPitch + 96)
			nodes = append(nodes, group)
			edges = append(edges, map[string]any{"id": "pe-" + productionHash(id)[:28], "fromNodeId": m.FrameID, "toNodeId": id})
		}
		doc["nodes"], doc["connections"] = nodes, edges
		data["planGroups"] = m.Plan.Groups
		ids := map[string][]string{m.FrameID: {fresh.Request.Production.TargetNodeID}}
		for _, id := range m.Plan.Groups {
			// A container the user deleted stays deleted; its stale pointer is
			// retired only when a new explicit asset batch starts.
			if productionNode(doc, id) != nil {
				ids[id] = []string{}
			}
		}
		for _, a := range rows {
			node := productionNode(doc, a.NodeID)
			if node == nil {
				continue
			}
			parent := productionPlanParent(m, a.Key)
			if _, ok := ids[parent]; !ok {
				continue
			}
			previousParent := node["parentId"]
			if a.Key == "story" && (previousParent == nil || previousParent == "") {
				// A legacy outline lives outside the container. Attaching it here
				// would change its receipt hash; productionAttachLegacyStory owns that.
				continue
			}
			node["parentId"] = parent
			ids[parent] = append(ids[parent], a.NodeID)
			if regroup && previousParent != parent && parent != m.FrameID {
				wd := productionWorkflow(node)
				wd["sourceNodeIds"], wd["sourceSignatures"], wd["sourceSteps"] = []string{m.FrameID}, map[string]string{}, []string{"story.plan"}
			}
		}
		productionMaterializeAssetPlaceholders(m, doc, rows, runID, data, ids, deleted)
		nodes = creationMaps(doc["nodes"])
		// Plan-document placeholders live in the root container and have no
		// receipt yet, so keep them in its member list.
		for _, node := range nodes {
			workflow := productionWorkflow(node)
			if workflow["planSection"] != nil && productionPlanPlaceholderOwned(node, runID) && (node["parentId"] == m.FrameID || workflow["planSection"] == "story") {
				if id := stringValue(node["id"]); !slices.Contains(ids[m.FrameID], id) {
					ids[m.FrameID] = append(ids[m.FrameID], id)
				}
			}
		}
		for id, members := range ids {
			if workflow := productionWorkflow(productionNode(doc, id)); workflow != nil {
				workflow["sourceNodeIds"] = members
			}
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
				if group := productionNode(doc, id); group != nil {
					productionLayoutPlanGroup(m, group, nodes)
				}
			}
		}
		// All children must have their new coordinates before collision checks;
		// otherwise the former root mistakes its just-moved assets for obstacles.
		frames := []map[string]any{root}
		for _, kind := range productionPlanGroupKinds {
			if id := m.Plan.Groups[kind]; id != "" {
				if group := productionNode(doc, id); group != nil {
					frames = append(frames, group)
				}
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

// productionLegacyStoryNode finds an outline that was saved outside its plan
// container: the filled document when it has a receipt, else the placeholder.
func productionLegacyStoryNode(m productionManifest, doc map[string]any, rows []model.ProductionAgentArtifact, runID string) map[string]any {
	for _, a := range rows {
		if a.Key != "story" {
			continue
		}
		if node := productionNode(doc, a.NodeID); node != nil {
			if stringValue(node["parentId"]) == "" {
				return node
			}
			return nil
		}
	}
	for _, node := range creationMaps(doc["nodes"]) {
		workflow := productionWorkflow(node)
		if workflow["planSection"] == "story" && productionPlanPlaceholderOwned(node, runID) && stringValue(node["parentId"]) == "" {
			return node
		}
	}
	return nil
}

// productionAttachLegacyStory moves an outline that lives outside its plan
// container back inside it. The parent is part of the receipt hash, so the
// outline and every document built on it get new receipts. Canvases that are
// already in the new shape produce no write.
func (s *Service) productionAttachLegacyStory(userID, runID string) (bool, error) {
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return false, err
	}
	if cloudAgentRunTerminal(run.Status) || run.CleanupPending {
		return false, nil
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		return false, err
	}
	_, m, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		return false, err
	}
	if m.Plan == nil || m.Plan.Version < 2 {
		return false, nil
	}
	rows, err := s.repo.ProductionAgentArtifacts(userID, runID)
	if err != nil {
		return false, err
	}
	if productionLegacyStoryNode(m, doc, rows, runID) == nil {
		return false, nil
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return false, err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	migrated := false
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
		story := productionLegacyStoryNode(m, doc, rows, runID)
		if story == nil {
			return nil
		}
		// Receipts change, so wait until every response has been committed.
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
		canvas, err := repo.CanvasProjectForUser(userID, fresh.Request.CanvasID)
		if err != nil {
			return err
		}
		before := canvas.PayloadJSON
		root := productionNode(doc, m.FrameID)
		if root == nil {
			return nil
		}
		data := productionWorkflow(root)
		nodes := creationMaps(doc["nodes"])
		storyID := stringValue(story["id"])
		story["parentId"] = m.FrameID

		// Receipts: the outline first, then everything that depends on it. A
		// hand-edited document only gets a new receipt, its text is untouched.
		rehashKeys := map[string]bool{}
		for _, a := range rows {
			if a.Key == "story" && productionNode(doc, a.NodeID) != nil {
				rehashKeys["story"] = true
			}
		}
		for changed := true; changed && rehashKeys["story"]; {
			changed = false
			for _, a := range rows {
				if rehashKeys[a.Key] || productionNode(doc, a.NodeID) == nil {
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

		// Connections: drop the container<->outline edge in either direction and
		// connect the real sources to the container instead.
		sources := []string{}
		kept := []map[string]any{}
		for _, edge := range creationMaps(doc["connections"]) {
			from, to := stringValue(edge["fromNodeId"]), stringValue(edge["toNodeId"])
			if (from == storyID && to == m.FrameID) || (from == m.FrameID && to == storyID) {
				continue
			}
			if to == storyID && from != "" && !slices.Contains(sources, from) {
				sources = append(sources, from)
			}
			kept = append(kept, edge)
		}
		if len(sources) == 0 {
			sources = stringSlice(data["collectionSourceIds"])
		}
		for _, from := range sources {
			if from == m.FrameID || productionNode(doc, from) == nil {
				continue
			}
			exists := false
			for _, edge := range kept {
				if stringValue(edge["fromNodeId"]) == from && stringValue(edge["toNodeId"]) == m.FrameID {
					exists = true
					break
				}
			}
			if !exists {
				kept = append(kept, map[string]any{"id": "pe-" + productionHash(from + "->" + m.FrameID)[:28], "fromNodeId": from, "toNodeId": m.FrameID})
			}
		}
		doc["connections"] = kept

		members := stringSlice(data["sourceNodeIds"])
		if !slices.Contains(members, storyID) {
			merged := make([]any, 0, len(members)+1)
			for _, id := range members {
				merged = append(merged, id)
			}
			data["sourceNodeIds"] = append(merged, storyID)
		}
		productionLayoutPlanGroup(m, root, nodes)
		meta, _ := root["metadata"].(map[string]any)
		geometry, _ := meta["frame"].(map[string]any)
		if geometry["collapsed"] != true {
			productionFitFrame(root, nodes, numberValue(root["height"], 428))
		}
		if err := saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
			return err
		}
		if err := emitCloudAgentCanvasChange(repo, runID, &fresh, cloudAgentMutationInput{UserID: userID, CanvasID: canvas.ID, Operation: "production_story_attach", BeforeJSON: before}); err != nil {
			return err
		}
		migrated = true
		return cloudAgentSave(current, &fresh)
	})
	return err == nil && migrated, err
}
