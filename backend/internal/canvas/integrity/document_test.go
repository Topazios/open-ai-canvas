package integrity

import (
	"fmt"
	"reflect"
	"testing"
)

func TestCleanOwnershipAndReferences(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(fmt.Sprint(explicit), func(t *testing.T) {
			doc := map[string]any{"nodes": []map[string]any{
				{"id": "keep", "metadata": map[string]any{"shortDrama": map[string]any{"sourceNodeIds": []string{"child", "other"}}}},
				{"id": "other"}, {"id": "child", "parentId": "group"}, {"id": "nested", "parentId": "child"},
				{"id": "batch", "parentId": "nested", "metadata": map[string]any{"batchChildIds": []string{"batch-child"}}},
				{"id": "batch-child"}, {"id": "bound", "metadata": map[string]any{"storyboardFrame": map[string]any{"scriptId": "child"}}},
			}, "connections": []map[string]any{{"id": "ok", "fromNodeId": "keep", "toNodeId": "other"}, {"id": "bad", "fromNodeId": "keep", "toNodeId": "child"}}, "custom": "preserved"}
			deleted := map[string]bool{}
			if explicit {
				doc["nodes"] = append(maps(doc["nodes"]), map[string]any{"id": "group", "type": "frame"})
				deleted["group"] = true
			}
			changed, removed := Clean(doc, deleted)
			if !changed || len(removed) < 5 || len(maps(doc["nodes"])) != 2 || len(maps(doc["connections"])) != 1 || doc["custom"] != "preserved" {
				t.Fatal(doc, removed)
			}
			if got := object(object(maps(doc["nodes"])[0]["metadata"])["shortDrama"])["sourceNodeIds"]; !reflect.DeepEqual(got, []string{"other"}) {
				t.Fatal(got)
			}
			if changed, _ := Clean(doc, deleted); changed {
				t.Fatal("cleanup is not idempotent")
			}
		})
	}
}

func TestCleanDeepChainsAndCycles(t *testing.T) {
	nodes := []map[string]any{{"id": "root"}}
	for i := 0; i < 20000; i++ {
		parent := "root"
		if i > 0 {
			parent = fmt.Sprint(i - 1)
		}
		nodes = append(nodes, map[string]any{"id": fmt.Sprint(i), "parentId": parent})
	}
	doc := map[string]any{"nodes": nodes}
	if changed, _ := Clean(doc, nil); changed {
		t.Fatal("valid deep graph changed")
	}
	doc["nodes"] = append(nodes[1:], map[string]any{"id": "a", "parentId": "b"}, map[string]any{"id": "b", "parentId": "a"})
	if changed, removed := Clean(doc, nil); !changed || len(removed) != 20002 || len(maps(doc["nodes"])) != 0 {
		t.Fatal("broken hierarchy survived", len(removed))
	}
}
