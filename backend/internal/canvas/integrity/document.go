// Package integrity enforces node ownership at complete-document boundaries.
package integrity

import (
	"encoding/json"
	"strings"
)

func text(value any) string           { result, _ := value.(string); return result }
func object(value any) map[string]any { result, _ := value.(map[string]any); return result }
func maps(value any) []map[string]any {
	if result, ok := value.([]map[string]any); ok {
		return result
	}
	var result []map[string]any
	if items, ok := value.([]any); ok {
		for _, item := range items {
			if node := object(item); node != nil {
				result = append(result, node)
			}
		}
	}
	return result
}
func stringIDs(value any) []string {
	if result, ok := value.([]string); ok {
		return result
	}
	var result []string
	if items, ok := value.([]any); ok {
		for _, item := range items {
			if id, ok := item.(string); ok {
				result = append(result, id)
			}
		}
	}
	return result
}

// Clean mutates a fully assembled document. parentId denotes ownership, never a
// request to detach a child when the parent is deleted. Root nodes remain valid.
// The graph walk is linear even for deeply nested containers.
func Clean(doc map[string]any, deleted map[string]bool) (bool, []string) {
	nodes := maps(doc["nodes"])
	index := make(map[string]map[string]any, len(nodes))
	children := make(map[string][]string, len(nodes))
	for _, node := range nodes {
		index[text(node["id"])] = node
	}
	removed := make(map[string]bool, len(deleted))
	queue := make([]string, 0, len(nodes))
	mark := func(id string) {
		if id != "" && !removed[id] {
			removed[id] = true
			queue = append(queue, id)
		}
	}
	for id, yes := range deleted {
		if yes {
			mark(id)
		}
	}
	for _, node := range nodes {
		id, parent := text(node["id"]), text(node["parentId"])
		if parent != "" {
			children[parent] = append(children[parent], id)
			if index[parent] == nil {
				mark(id)
			}
		}
		meta := object(node["metadata"])
		workflow := object(meta["shortDrama"])
		if workflow["step"] == "story.plan" && workflow["role"] == "collection" {
			for _, source := range stringIDs(workflow["sourceNodeIds"]) {
				member := index[source]
				data := object(object(member["metadata"])["shortDrama"])
				if member != nil && text(member["parentId"]) == "" && data["planSection"] == "story" && data["role"] == "document" {
					children[id] = append(children[id], source)
				}
			}
		}
		for _, child := range stringIDs(meta["batchChildIds"]) {
			children[id] = append(children[id], child)
		}
		for _, field := range []string{"storyboardFrame", "storyboardFramePlan"} {
			if script := text(object(meta[field])["scriptId"]); script != "" {
				children[script] = append(children[script], id)
			}
		}
	}
	// A parent cycle has no root and cannot be rendered as a container hierarchy.
	valid := make(map[string]bool, len(nodes))
	roots := []string{}
	for _, node := range nodes {
		if text(node["parentId"]) == "" {
			roots = append(roots, text(node["id"]))
		}
	}
	for i := 0; i < len(roots); i++ {
		id := roots[i]
		if valid[id] {
			continue
		}
		valid[id] = true
		for _, child := range children[id] {
			if text(index[child]["parentId"]) == id {
				roots = append(roots, child)
			}
		}
	}
	for _, node := range nodes {
		if !valid[text(node["id"])] {
			mark(text(node["id"]))
		}
	}
	for i := 0; i < len(queue); i++ {
		for _, id := range children[queue[i]] {
			mark(id)
		}
	}
	changed := false
	removedIDs := []string{}
	live := make(map[string]bool, len(nodes))
	kept := make([]map[string]any, 0, len(nodes))
	for _, node := range nodes {
		id := text(node["id"])
		if removed[id] {
			changed = true
			removedIDs = append(removedIDs, id)
		} else {
			live[id] = true
			kept = append(kept, node)
		}
	}
	filterIDs := func(data map[string]any, field string) {
		if data == nil || data[field] == nil {
			return
		}
		ids := stringIDs(data[field])
		filtered := make([]string, 0, len(ids))
		for _, id := range ids {
			if live[id] {
				filtered = append(filtered, id)
			}
		}
		if len(ids) != len(filtered) {
			data[field] = filtered
			changed = true
		}
	}
	for _, node := range kept {
		meta := object(node["metadata"])
		filterIDs(object(meta["shortDrama"]), "sourceNodeIds")
		filterIDs(meta, "batchChildIds")
		if primary := text(meta["primaryImageId"]); primary != "" && !live[primary] {
			delete(meta, "primaryImageId")
			changed = true
		}
		storyboard := object(meta["storyboard"])
		filterIDs(storyboard, "referenceNodeIds")
		for _, row := range maps(storyboard["rows"]) {
			for _, field := range []string{"imageNodeId", "videoNodeId"} {
				if id := text(row[field]); id != "" && !live[id] {
					delete(row, field)
					changed = true
				}
			}
			bindings := maps(row["assetBindings"])
			filtered := make([]map[string]any, 0, len(bindings))
			for _, binding := range bindings {
				if live[text(binding["nodeId"])] {
					filtered = append(filtered, binding)
				}
			}
			if len(bindings) != len(filtered) {
				row["assetBindings"] = filtered
				changed = true
			}
		}
	}
	edges := maps(doc["connections"])
	connections := make([]map[string]any, 0, len(edges))
	for _, edge := range edges {
		if live[text(edge["fromNodeId"])] && live[text(edge["toNodeId"])] {
			connections = append(connections, edge)
		} else {
			changed = true
		}
	}
	if changed {
		doc["nodes"], doc["connections"] = kept, connections
	}
	return changed, removedIDs
}

func CleanJSON(payload string, deleted map[string]bool) (string, []string, error) {
	var doc map[string]any
	decoder := json.NewDecoder(strings.NewReader(payload))
	decoder.UseNumber()
	if err := decoder.Decode(&doc); err != nil {
		return "", nil, err
	}
	changed, removed := Clean(doc, deleted)
	if !changed {
		return payload, removed, nil
	}
	// Unknown fields (timeline/plugin data included) retain their exact JSON.
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(payload), &fields); err != nil {
		return "", nil, err
	}
	fields["nodes"], _ = json.Marshal(doc["nodes"])
	fields["connections"], _ = json.Marshal(doc["connections"])
	raw, err := json.Marshal(fields)
	return string(raw), removed, err
}
