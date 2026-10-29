package app

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestProductionStatusProjectionPreservesOutputsAndSupportsRootNodes(t *testing.T) {
	for _, scenario := range []string{"grouped", "root", "cancelled", "orphan", "rebound"} {
		t.Run(scenario, func(t *testing.T) {
			s, db, view := productionFixture(t)
			productionEditCanvas(t, s, db, func(doc map[string]any) {
				node := productionNode(doc, "target")
				if scenario == "root" {
					delete(node, "parentId")
				} else if scenario == "orphan" {
					node["parentId"] = "missing-group"
				}
				if scenario == "rebound" {
					productionWorkflow(node)["productionAgent"] = map[string]any{"runId": "replacement"}
				}
				meta := node["metadata"].(map[string]any)
				meta["status"], meta["taskStage"] = "loading", "old progress"
				doc["nodes"] = append(creationMaps(doc["nodes"]), map[string]any{"id": "saved-document", "type": "text", "metadata": map[string]any{"content": "already generated"}})
			})
			run, _ := s.repo.CloudAgent("user", view.ID)
			if err := s.repo.MutateCloudAgent("user", run.ID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
				current.Status, current.FailureMessage = "failed", "model unavailable"
				if scenario == "cancelled" {
					current.Status = "cancelled"
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			s.projectProductionAgentStatus("user", run.ID)
			canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
			if err != nil {
				t.Fatal(err)
			}
			doc, _ := creationDocument(canvas.PayloadJSON)
			meta := productionNode(doc, "target")["metadata"].(map[string]any)
			if scenario == "orphan" || scenario == "rebound" {
				if meta["status"] != "loading" || meta["taskStage"] != "old progress" {
					t.Fatal("stale projection changed an orphan or replacement task", meta)
				}
			} else if scenario == "cancelled" {
				if meta["status"] != "idle" || meta["taskStage"] != "制作 Agent 已取消" || meta["errorDetails"] != nil {
					t.Fatal("cancelled task still appears active or failed", meta)
				}
			} else if meta["status"] != "error" || meta["errorDetails"] != "model unavailable" {
				t.Fatal("terminal status was not projected", meta)
			}
			if productionNode(doc, "saved-document")["metadata"].(map[string]any)["content"] != "already generated" {
				t.Fatal("saved document was changed by status projection")
			}
		})
	}
}

func TestProductionAssetFailureDoesNotFailCompletedPlan(t *testing.T) {
	s, _, run := planFixture(t, 3)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	story := submitOrderedPlan(t, s, run.ID, "story", "", "故事总纲")
	productionCall(t, s, run.ID, "production_plan_inventory", productionPlan{
		StoryHash: stringValue(story["hash"]), Complete: true,
		Assets: []productionPlanAsset{{Key: "hero", Kind: "character", Name: "主角", Purpose: "核心人物", PlannedRange: "全剧"}},
		Absent: map[string]string{"environment": "无独立场景", "prop": "无独立道具", "sound": "无独立声音资产"},
	}, false)
	submitOrderedPlan(t, s, run.ID, "visual", "", "视觉规范")
	submitOrderedPlan(t, s, run.ID, "direction", "", "导演规范")
	submitOrderedPlan(t, s, run.ID, "generation", "", "生成规范")

	job, err := s.repo.ProductionAgentJob("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var manifest productionManifest
	if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Plan.AssetsStarted = true
	manifest.Plan.SelectedAssetKeys = []string{"hero"}
	encoded, _ := json.Marshal(manifest)
	if err := s.repo.UpdateProductionAgentManifest("user", run.ID, string(encoded)); err != nil {
		t.Fatal(err)
	}
	execution, err := s.repo.CloudAgent("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.repo.MutateCloudAgent("user", run.ID, execution.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status, current.FailureMessage = "failed", "资产模型请求失败"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	s.projectProductionAgentStatus("user", run.ID)

	canvas, err := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		t.Fatal(err)
	}
	target := productionNode(doc, "target")
	meta := target["metadata"].(map[string]any)
	data := productionWorkflow(target)
	if meta["status"] != "success" || meta["taskStage"] != "制作方案已完成 · 资产执行未完成" || meta["errorDetails"] != nil {
		t.Fatalf("asset failure overwrote completed plan status: %#v", meta)
	}
	if data["assetExecutionStatus"] != "failed" || data["assetExecutionError"] != "资产模型请求失败" {
		t.Fatalf("asset execution failure was not recorded separately: %#v", data)
	}
	execution = mustCloudAgent(t, s, run.ID)
	state, err := cloudAgentDecode(execution)
	if err != nil {
		t.Fatal(err)
	}
	_, loaded, _, err := productionLoad(s.repo, execution, &state)
	if err != nil || loaded.Plan.SummaryHash != productionTargetHash(target) {
		t.Fatalf("completed plan could not be resumed after asset failure: %v", err)
	}
}

func mustCloudAgent(t *testing.T, s *Service, runID string) *model.CloudAgentExecution {
	t.Helper()
	run, err := s.repo.CloudAgent("user", runID)
	if err != nil {
		t.Fatal(err)
	}
	return run
}
