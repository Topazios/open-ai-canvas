package app

import "testing"

func storyboardManifestAfterEdit(t *testing.T, edit func(doc map[string]any)) (productionManifest, error) {
	t.Helper()
	s, db, run := storyboardFixture(t)
	productionEditCanvas(t, s, db, edit)
	execution, err := s.repo.CloudAgent("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, err := cloudAgentDecode(execution)
	if err != nil {
		t.Fatal(err)
	}
	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	return productionSourceManifest(canvas, state.Request)
}

func TestStoryboardManifestSkipsUnavailableRuleSources(t *testing.T) {
	for _, status := range []string{"loading", "error", "success"} {
		manifest, err := storyboardManifestAfterEdit(t, func(doc map[string]any) {
			pipeline := productionWorkflow(productionNode(doc, "target"))["pipelineId"]
			content := "规则"
			if status == "success" {
				content = ""
			}
			plan := map[string]any{"id": "plan", "type": "text", "title": "制作方案", "metadata": map[string]any{"status": status, "content": content, "shortDrama": map[string]any{"step": "story.plan", "pipelineId": pipeline}}}
			doc["nodes"] = append(creationMaps(doc["nodes"]), plan)
			wd := productionWorkflow(productionNode(doc, "target"))
			wd["sourceSignatures"] = map[string]any{"plan": "declared", "missing-node": "gone"}
			wd["sourceNodeIds"] = append(productionIDs(wd["sourceNodeIds"]), "plan", "missing-node")
		})
		if status == "error" {
			// A failed rule source that still holds text is usable, so only the
			// loading and empty cases must be skipped.
			if err != nil {
				t.Fatalf("%s: %v", status, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", status, err)
		}
		for _, source := range manifest.Sources {
			if source.NodeID == "plan" || source.NodeID == "missing-node" {
				t.Fatalf("%s: unavailable rule source kept: %#v", status, manifest.Sources)
			}
		}
	}
}

func TestStoryboardManifestStillRequiresEpisodeBody(t *testing.T) {
	for _, edit := range []func(meta map[string]any){
		func(meta map[string]any) { meta["content"] = "" },
		func(meta map[string]any) { meta["content"] = " \n\t"; meta["status"] = "loading" },
	} {
		_, err := storyboardManifestAfterEdit(t, func(doc map[string]any) {
			meta, _ := productionNode(doc, "body")["metadata"].(map[string]any)
			edit(meta)
		})
		if err == nil {
			t.Fatal("empty body must be rejected")
		}
	}
}

func TestStoryboardManifestAcceptsFailedBodyWithText(t *testing.T) {
	manifest, err := storyboardManifestAfterEdit(t, func(doc map[string]any) {
		meta, _ := productionNode(doc, "body")["metadata"].(map[string]any)
		meta["status"] = "error"
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Sources) != 1 || manifest.Sources[0].Step != "story.body" {
		t.Fatalf("%#v", manifest.Sources)
	}
}

func TestStoryboardManifestAcceptsPersistedBodyWhileTaskRunning(t *testing.T) {
	manifest, err := storyboardManifestAfterEdit(t, func(doc map[string]any) {
		meta := productionNode(doc, "body")["metadata"].(map[string]any)
		meta["status"] = "loading"
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Sources) != 1 || manifest.Sources[0].Step != "story.body" || manifest.Sources[0].Version == "" {
		t.Fatalf("expected versioned body snapshot: %#v", manifest.Sources)
	}
}
