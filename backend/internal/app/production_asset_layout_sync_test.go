package app

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func TestProductionAssetLayoutRecoveryPlaceholderDoesNotReserveSlot(t *testing.T) {
	m := productionManifest{FrameID: "root", Plan: &productionPlan{Groups: map[string]string{"character": "group"}}}
	frame := map[string]any{"id": "group", "type": "frame", "position": map[string]any{"x": float64(100), "y": float64(100)}}
	nodes := []map[string]any{frame}
	for i := 0; i < 39; i++ {
		key := fmt.Sprintf("character-%d", i)
		m.Plan.Assets = append(m.Plan.Assets, productionPlanAsset{Key: key, Kind: "character", Priority: i + 1})
		for version := 0; version < 3; version++ {
			data := map[string]any{"pipelineId": "p", "step": "story.plan", "assetKey": key, "planAsset": map[string]any{"key": key}, "assetVersion": version + 1}
			meta := map[string]any{"content": "complete", "status": "success", "shortDrama": data}
			if version == 2 {
				data["planGeneration"] = map[string]any{"runId": "run", "status": "queued"}
				meta["content"], meta["status"] = "等待生成", "processing"
			} else {
				data["assetIdentity"] = &productionAssetIdentity{ID: fmt.Sprintf("person-%d", i)}
				data["assetAdopted"] = version == 1
			}
			nodes = append(nodes, map[string]any{"id": fmt.Sprintf("doc-%d-%d", i, version), "type": "text", "parentId": "group", "width": 400, "height": 280, "metadata": meta})
		}
	}
	for pass := 0; pass < 3; pass++ {
		productionLayoutPlanGroup(m, frame, nodes)
		current := productionCurrentAssetMembers(nodes[1:])
		if len(current) != 39 {
			t.Fatalf("history/placeholder occupies a slot: %d", len(current))
		}
		for i, node := range current {
			p := node["position"].(map[string]any)
			if node["id"] != fmt.Sprintf("doc-%d-1", i) || numberValue(p["x"], 0) != 124+float64(i%3)*424 || numberValue(p["y"], 0) != 200+float64(i/3)*336 {
				t.Fatalf("unstable visible grid: %v", node)
			}
		}
		if numberValue(frame["height"], 0) != 4436 {
			t.Fatalf("server and client disagree on bottom row: %v", frame["height"])
		}
		// Task saves use typed identities; polling restores them as JSON maps.
		raw, _ := json.Marshal(nodes)
		if err := json.Unmarshal(raw, &nodes); err != nil {
			t.Fatal(err)
		}
		frame = nodes[0]
	}
}

func TestProductionAssetFitIgnoresHiddenHistoryAndPreservesVisibleObstacles(t *testing.T) {
	frame := map[string]any{"id": "frame", "type": "frame", "position": map[string]any{"x": float64(0), "y": float64(0)}}
	old := map[string]any{"id": "old", "type": "text", "parentId": "other", "position": map[string]any{"x": float64(100), "y": float64(100)}, "width": 400, "height": 280,
		"metadata": map[string]any{"shortDrama": map[string]any{"pipelineId": "p", "step": "story.plan", "assetIdentity": map[string]any{"id": "person"}, "assetAdopted": false}}}
	current := map[string]any{"id": "current", "type": "text", "parentId": "other", "position": map[string]any{"x": float64(2000), "y": float64(100)}, "width": 400, "height": 280,
		"metadata": map[string]any{"shortDrama": map[string]any{"pipelineId": "p", "step": "story.plan", "assetIdentity": map[string]any{"id": "person"}, "assetAdopted": true}}}
	nodes := []map[string]any{frame, old, current}
	productionFitFrame(frame, nodes, 428)
	if !reflect.DeepEqual(frame["position"], map[string]any{"x": float64(0), "y": float64(0)}) {
		t.Fatal("invisible history moved the frame", frame)
	}
	current["position"].(map[string]any)["x"] = float64(100)
	productionFitFrame(frame, nodes, 428)
	if numberValue(frame["position"].(map[string]any)["y"], 0) != 444 {
		t.Fatal("visible obstacle was ignored", frame)
	}
}

func TestProductionAssetFitIgnoresChildrenOfCollapsedContainers(t *testing.T) {
	frame := map[string]any{"id": "frame", "type": "frame", "width": 448, "position": map[string]any{"x": float64(0), "y": float64(0)}}
	other := map[string]any{"id": "other", "type": "frame", "width": 360, "height": 300, "position": map[string]any{"x": float64(2000), "y": float64(0)},
		"metadata": map[string]any{"frame": map[string]any{"collapsed": true}}}
	child := map[string]any{"id": "child", "type": "text", "parentId": "other", "width": 400, "height": 280, "position": map[string]any{"x": float64(100), "y": float64(100)}}
	anchor := map[string]any{"id": "anchor", "type": "text", "width": 400, "height": 280, "position": map[string]any{"x": float64(100), "y": float64(100)},
		"metadata": map[string]any{"shortDrama": map[string]any{"assetKey": "$summary"}}}
	outsideWidth := map[string]any{"id": "outside-width", "type": "text", "width": 400, "height": 280, "position": map[string]any{"x": float64(500), "y": float64(100)}}
	productionFitFrame(frame, []map[string]any{frame, other, child, anchor, outsideWidth}, 428)
	if numberValue(frame["position"].(map[string]any)["y"], -1) != 0 {
		t.Fatal("invisible nodes or an obsolete fixed width moved the frame", frame)
	}
}
