package app

// Presentation selects one dossier per identity. Historical nodes and media
// references remain intact; only their grid slots are omitted.
func productionCurrentAssetMembers(nodes []map[string]any) []map[string]any {
	selected := map[string]map[string]any{}
	type member struct {
		node                 map[string]any
		scope, id, key, slot string
	}
	members := make([]member, 0, len(nodes))
	aliases := map[string]string{}
	for _, node := range nodes {
		item := member{node: node}
		if node["type"] != "text" {
			members = append(members, item)
			continue
		}
		data := productionWorkflow(node)
		asset, _ := data["assetIdentity"].(map[string]any)
		item.id = stringValue(asset["id"])
		if typed, ok := data["assetIdentity"].(*productionAssetIdentity); ok && typed != nil {
			item.id = typed.ID
		}
		if data["assetKey"] == "$summary" {
			members = append(members, member{node: node})
			continue
		}
		item.scope = stringValue(node["parentId"]) + "\x00" + stringValue(data["pipelineId"]) + "\x00" + stringValue(data["step"]) + "\x00"
		item.key = stringValue(data["assetKey"])
		plan, _ := data["planAsset"].(map[string]any)
		if key := stringValue(plan["key"]); key != "" {
			item.key = key
		}
		if item.id != "" && item.key != "" {
			alias := item.scope + item.key
			if prior, ok := aliases[alias]; !ok {
				aliases[alias] = item.id
			} else if prior != item.id {
				aliases[alias] = ""
			}
		}
		if item.id == "" && plan == nil {
			item.key = ""
		}
		members = append(members, item)
	}
	rank := func(data map[string]any) int {
		if data["assetAdopted"] == true {
			return 2
		}
		if data["assetAdopted"] == false {
			return 0
		}
		return 1
	}
	for i := range members {
		item := &members[i]
		if item.id != "" {
			item.slot = item.scope + "id:" + item.id
		} else if item.key != "" {
			item.slot = item.scope + "key:" + item.key
			if id := aliases[item.scope+item.key]; id != "" {
				item.slot = item.scope + "id:" + id
			}
		}
		if item.slot == "" {
			continue
		}
		node := item.node
		prior := selected[item.slot]
		currentData, priorData := productionWorkflow(node), productionWorkflow(prior)
		version, priorVersion := numberValue(currentData["assetVersion"], 1), numberValue(priorData["assetVersion"], 1)
		pending, priorPending := productionPlanPending(node), productionPlanPending(prior)
		better := rank(currentData) > rank(priorData) || rank(currentData) == rank(priorData) && (version > priorVersion || version == priorVersion && stringValue(node["id"]) > stringValue(prior["id"]))
		if pending != priorPending {
			better = !pending
		}
		if prior == nil || better {
			selected[item.slot] = node
		}
	}
	result := make([]map[string]any, 0, len(nodes))
	for _, item := range members {
		if item.slot == "" || selected[item.slot]["id"] == item.node["id"] {
			result = append(result, item.node)
		}
	}
	return result
}
