package app

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestProductionFlowStagesUseStableEpisodeDenominator(t *testing.T) {
	g := productionFlowGraph{Root: "story"}
	workflow := map[string]any{"parameters": map[string]any{"episodeCount": 120}}
	rows := productionFlowStages(g, workflow, false, false)
	if rows[4].Total != 120 || rows[4].Percent != 0 || rows[5].TotalKnown {
		t.Fatal(rows)
	}
	g.Units = []model.ProductionFlowUnit{
		{Stage: "arcs", Status: "accepted", InputJSON: "{}", ResultJSON: productionFlowJSON(map[string]any{"arcs": []productionFlowArc{{Start: 1, End: 120}}})},
		{Stage: "cards", Status: "accepted", InputJSON: `{"start":1,"end":119}`},
		{ID: "parent", Stage: "cards", Status: "split", InputJSON: `{"start":120,"end":120}`},
		{Stage: "cards", Status: "accepted", InputJSON: `{"parentUnitId":"parent","start":120,"end":120}`},
	}
	rows = productionFlowStages(g, workflow, false, false)
	if rows[4].Completed != 119 || rows[4].Total != 120 || rows[4].Percent != 99 || rows[6].Percent != 0 {
		t.Fatal(rows)
	}
	g.Units[2].Status = "accepted"
	g.Units = append(g.Units, model.ProductionFlowUnit{Stage: "review", Status: "running", InputJSON: "{}"})
	rows = productionFlowStages(g, workflow, false, false)
	if rows[4].Percent != 100 || rows[5].Total != 9 || rows[5].Status != "running" {
		t.Fatal(rows)
	}
	rows = productionFlowStages(g, workflow, true, false)
	if rows[6].Status != "running" || rows[6].Percent != 0 {
		t.Fatal(rows)
	}
	rows = productionFlowStages(g, workflow, true, true)
	if rows[6].Percent != 100 {
		t.Fatal(rows)
	}
}

func TestProductionFlowStagesInventoryTotalsRemainProvisional(t *testing.T) {
	input := productionFlowJSON(map[string]any{"sources": []productionFlowSource{{ID: "a"}}})
	g := productionFlowGraph{Root: "inventory", Units: []model.ProductionFlowUnit{{Stage: "extract", Status: "accepted", InputJSON: input}, {Stage: "extract", Status: "running", InputJSON: input}}}
	rows := productionFlowStages(g, nil, false, false)
	if rows[0].Percent != 50 || rows[1].TotalKnown || rows[2].TotalKnown {
		t.Fatal(rows)
	}
	g.Units = append(g.Units, model.ProductionFlowUnit{Stage: "resolve", Status: "accepted", InputJSON: "{}"})
	rows = productionFlowStages(g, nil, false, false)
	if rows[1].Percent == 100 || rows[1].TotalKnown {
		t.Fatal(rows)
	}
}

func TestProductionFlowTransientUpstreamEventDoesNotHoldUnit(t *testing.T) {
	s, db, id := flowFixture(t)
	g, _ := flowGraph(t, s, id, "story")
	u, work, task := installFlowResponse(t, s, db, id, g.Units[0], "{}")
	task.Status, task.Error = model.TaskStatusFailed, "上游 Responses 流式请求失败（upstream_error），生成未完成"
	if err := db.Save(task).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{ID: "unavailable", TaskID: task.ID, StatusCode: 200, ErrorCode: "upstream_error", Error: "Upstream service temporarily unavailable"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.settleProductionFlow("user", id, work, task); err != nil {
		t.Fatal(err)
	}
	saved, _ := s.repo.ProductionFlowUnit("user", id, u.ID)
	_, state := productionRuntimeState(t, s, id)
	retry := state.ProductionParallel[u.Key]
	if saved.Status != "repair" || saved.Attempts != 0 || retry.RetryAt == 0 || retry.TransientAttempts != 1 || !strings.Contains(saved.IssuesJSON, "暂时不可用") {
		t.Fatal("transient event stopped flow or hid cause", saved, retry)
	}
	settleFlowReply(t, s, db, id, *saved, flowReply(*saved))
}

func TestProductionFlowStoppedReasonRemainsVisible(t *testing.T) {
	s, _, id := flowFixture(t)
	if _, err := s.holdProductionFlow("user", id, "主任务租约过期，等待继续"); err != nil {
		t.Fatal(err)
	}
	run, state := productionRuntimeState(t, s, id)
	_, manifest, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		t.Fatal(err)
	}
	progress := s.productionFlowProgress("user", id, &state, manifest, doc, nil)
	if progress == nil || progress.StopReason != "主任务租约过期，等待继续" || run.FailureMessage != progress.StopReason {
		t.Fatal("stop reason was dropped", progress)
	}
}
