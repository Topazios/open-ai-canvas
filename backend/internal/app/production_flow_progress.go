package app

import (
	"encoding/json"
	"errors"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/kernel"
	"time"

	"infinite-canvas/backend/internal/model"
)

type ProductionFlowProgress struct {
	Root           string                        `json:"root"`
	Stage          string                        `json:"stage"`
	Total          int                           `json:"total"`
	Saved          int                           `json:"saved"`
	Accepted       int                           `json:"accepted"`
	Running        int                           `json:"running"`
	Queued         int                           `json:"queued"`
	Scheduler      *productionFlowControl        `json:"scheduler,omitempty"`
	Repair         int                           `json:"repair"`
	Held           int                           `json:"held"`
	LastProgressAt time.Time                     `json:"lastProgressAt"`
	Units          []ProductionFlowUnitProgress  `json:"units"`
	Stages         []ProductionFlowStageProgress `json:"stages"`
	StopReason     string                        `json:"stopReason,omitempty"`
}
type ProductionFlowStageProgress struct {
	Key        string `json:"key"`
	Name       string `json:"name"`
	Total      int    `json:"total"`
	TotalKnown bool   `json:"totalKnown"`
	Completed  int    `json:"completed"`
	Percent    int    `json:"percent"`
	Running    int    `json:"running"`
	Repair     int    `json:"repair"`
	Held       int    `json:"held"`
	Status     string `json:"status"`
}
type ProductionFlowUnitProgress struct {
	ID            string                `json:"id"`
	Key           string                `json:"key"`
	Name          string                `json:"name"`
	Stage         string                `json:"stage"`
	Status        string                `json:"status"`
	Generation    int                   `json:"generation"`
	Attempts      int                   `json:"attempts"`
	Issues        []productionFlowIssue `json:"issues"`
	Percent       int                   `json:"percent"`
	RetryAt       int64                 `json:"retryAt,omitempty"`
	RetryAttempts int                   `json:"retryAttempts,omitempty"`
}

func (s *Service) productionFlowProgress(userID, runID string, state *cloudAgentRuntime, m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) *ProductionFlowProgress {
	if m.Plan == nil || m.Plan.FlowVersion != 1 || m.Plan.AssetsStarted {
		return nil
	}
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return nil
	}
	root := productionFlowRoot(m, doc, artifacts)
	if root == "" {
		root = "story"
		if m.Plan.Complete {
			root = "inventory"
		}
	}
	g, complete, err := s.productionFlowGraph(run, state, m, doc, artifacts, root)
	if err != nil {
		return nil
	}
	view := &ProductionFlowProgress{Root: root, Total: len(g.Units), Units: []ProductionFlowUnitProgress{}}
	if state.ProductionFlowControl.Scope == root+":"+g.Source {
		c := state.ProductionFlowControl
		view.Scheduler = &c
	}
	ids := []string{}
	for _, u := range g.Units {
		if u.Status == "running" {
			ids = append(ids, u.TaskID)
		}
	}
	taskRows, taskErr := s.repo.TaskStatesForUser(userID, ids)
	taskStatuses := map[string]model.TaskStatus{}
	if taskErr == nil {
		for _, row := range taskRows {
			taskStatuses[row.ID] = row.Status
		}
	}
	if state.ProductionPaused || run.Status == "waiting_user" || run.Status == "failed" {
		view.StopReason = firstNonEmpty(run.FailureMessage, state.LastError)
	}
	for _, u := range g.Units {
		issues := []productionFlowIssue{}
		_ = json.Unmarshal([]byte(u.IssuesJSON), &issues)
		item := ProductionFlowUnitProgress{ID: u.ID, Key: u.Key, Name: u.Name, Stage: u.Stage, Status: u.Status, Generation: u.Generation, Attempts: u.Attempts, Issues: issues}
		item.Percent = productionFlowUnitPercent(u)
		if u.Status == "running" && taskStatuses[u.TaskID] == model.TaskStatusQueued {
			item.Status = "queued"
		}
		if work := state.ProductionParallel[u.Key]; work.FlowUnitID == u.ID {
			item.RetryAt, item.RetryAttempts = work.RetryAt, work.TransientAttempts
		}
		view.Units = append(view.Units, item)
		if u.ResultJSON != "" && u.ResultJSON != "{}" {
			view.Saved++
		}
		switch u.Status {
		case "accepted":
			view.Accepted++
		case "running":
			if taskStatuses[u.TaskID] == model.TaskStatusQueued {
				view.Queued++
			} else {
				view.Running++
			}
		case "repair":
			view.Repair++
		case "held":
			view.Held++
		}
		if u.Status != "accepted" && view.Stage == "" {
			view.Stage = u.Name
		}
		if u.UpdatedAt.After(view.LastProgressAt) && u.ResultJSON != "{}" {
			view.LastProgressAt = u.UpdatedAt
		}
	}
	if view.Stage == "" {
		view.Stage = "正在汇总发布"
	}
	view.Stages = productionFlowStages(g, productionWorkflow(productionNode(doc, m.FrameID)), complete, productionPlanArtifactValid(m, doc, artifacts, root))
	return view
}

func productionFlowUnitPercent(unit model.ProductionFlowUnit) int {
	if unit.Status == "accepted" {
		return 100
	}
	if unit.Stage == "cards" {
		input := productionFlowInput(unit)
		total := int(numberValue(input["end"], 0)) - int(numberValue(input["start"], 0)) + 1
		var cards []productionPlanningCard
		_ = decodeFlowValue(productionFlowValue(unit)["episodes"], &cards)
		if total > 0 {
			return min(99, len(cards)*100/total)
		}
	}
	fields := productionFlowUnitFields(unit)
	if len(fields) == 0 {
		return 0
	}
	adopted := productionFlowObject(unit.ResultJSON)
	done, total := 0, 0
	for _, field := range fields {
		if field == "episode" {
			continue
		}
		total++
		if len(adopted[field]) > 0 {
			done++
		}
	}
	if total == 0 {
		return 0
	}
	return min(99, done*100/total)
}

// Top-level assignments are the denominator. Splitting or retrying an
// assignment must not inflate completion; unpublished work never reads 100%.
func productionFlowStages(g productionFlowGraph, workflow map[string]any, ready, published bool) []ProductionFlowStageProgress {
	keys := []string{"foundation", "characters", "arcs", "registry", "cards", "review", "publish"}
	labels := map[string]string{"foundation": "主线、结局与世界规则", "characters": "人物关系与跨单元线索", "arcs": "单元阶段分配", "registry": "主要与单元资产登记", "cards": "每集叙事要点", "review": "叙事衔接与资产覆盖核对", "catalog": "资产汇总与使用关系", "extract": "资产提取与覆盖核对", "omissions": "资产补漏核对", "resolve": "资产身份归并", "identity": "资产身份复核", "publish": "汇总与发布"}
	if g.Root == "inventory" {
		keys = []string{"extract", "resolve", "identity", "publish"}
		if g.AuditRevision > 0 {
			keys = []string{"extract", "omissions", "resolve", "identity", "publish"}
		}
		if g.Catalog != nil {
			keys = []string{"catalog", "publish"}
		}
	}
	rows := map[string]*ProductionFlowStageProgress{}
	for _, key := range keys {
		rows[key] = &ProductionFlowStageProgress{Key: key, Name: labels[key], Status: "pending"}
	}
	for _, u := range g.Units {
		input := productionFlowInput(u)
		row := rows[u.Stage]
		if row == nil {
			continue
		}
		if input["parentUnitId"] == nil {
			weight := 1
			if u.Stage == "cards" {
				weight = int(numberValue(input["end"], 0)) - int(numberValue(input["start"], 0)) + 1
			}
			if u.Stage == "extract" {
				var sources []productionFlowSource
				_ = decodeFlowValue(input["sources"], &sources)
				weight = len(sources)
			}
			row.Total += weight
			if u.Status == "accepted" {
				row.Completed += weight
			} else if u.Stage == "cards" {
				var cards []productionPlanningCard
				_ = decodeFlowValue(productionFlowValue(u)["episodes"], &cards)
				row.Completed += len(cards)
			}
		}
		switch u.Status {
		case "running":
			row.Running++
		case "repair", "split":
			row.Repair++
		case "held":
			row.Held++
		}
	}
	if g.Root == "story" {
		for _, key := range []string{"foundation", "characters", "arcs"} {
			rows[key].Total = 1
			rows[key].TotalKnown = true
		}
		rows["registry"].Total = len(productionCurrentPlanKinds)
		rows["registry"].TotalKnown = false
		params, _ := workflow["parameters"].(map[string]any)
		count := int(numberValue(params["episodeCount"], 0))
		rows["cards"].Total = max(count, rows["cards"].Total)
		rows["cards"].TotalKnown = count > 0
		for _, u := range g.Units {
			if u.Stage == "arcs" && u.Status == "accepted" && productionFlowInput(u)["parentUnitId"] == nil {
				var arcs []productionFlowArc
				_ = decodeFlowValue(productionFlowValue(u)["arcs"], &arcs)
				rows["registry"].Total += len(arcs)
				rows["registry"].TotalKnown = true
				total := 1
				for _, arc := range arcs {
					total += (arc.End - arc.Start + 16) / 16
				}
				rows["review"].Total = total
				rows["review"].TotalKnown = true
			}
		}
	} else if g.Catalog != nil {
		rows["catalog"].Total = 1
		rows["catalog"].TotalKnown = true
	} else {
		rows["extract"].TotalKnown = rows["extract"].Total > 0
		extracted := rows["extract"].TotalKnown && rows["extract"].Completed == rows["extract"].Total
		if row := rows["omissions"]; row != nil {
			row.TotalKnown = extracted
			extracted = extracted && row.Completed == row.Total
		}
		rows["resolve"].TotalKnown = extracted && rows["resolve"].Completed == rows["resolve"].Total
		rows["identity"].TotalKnown = rows["resolve"].TotalKnown && rows["identity"].Completed == rows["identity"].Total
	}
	rows["publish"].Total = 1
	rows["publish"].TotalKnown = true
	if published {
		rows["publish"].Completed = 1
	}
	result := make([]ProductionFlowStageProgress, 0, len(keys))
	for _, key := range keys {
		row := rows[key]
		if row.Total > 0 {
			row.Percent = min(99, row.Completed*100/row.Total)
		}
		if row.TotalKnown && row.Completed == row.Total {
			row.Status, row.Percent = "completed", 100
		} else if row.Held > 0 {
			row.Status = "blocked"
		} else if row.Running > 0 {
			row.Status = "running"
		} else if row.Repair > 0 {
			row.Status = "repair"
		}
		if key == "publish" && ready && !published {
			row.Status = "running"
		}
		result = append(result, *row)
	}
	return result
}

func (s *Service) ProductionFlowUnitDetail(userID, runID, unitID string) (map[string]any, error) {
	if _, err := s.repo.CloudAgent(userID, runID); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, kernel.NotFound("制作任务不存在")
		}
		return nil, err
	}
	unit, err := s.repo.ProductionFlowUnit(userID, runID, unitID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, kernel.NotFound("制作工作单元不存在")
		}
		return nil, err
	}
	history, err := s.repo.ProductionFlowReceipts(userID, runID, unitID)
	if err != nil {
		return nil, err
	}
	records := []map[string]any{}
	for _, r := range history {
		var received any = r.ArgumentsJSON
		if json.Valid([]byte(r.ArgumentsJSON)) {
			received = json.RawMessage(r.ArgumentsJSON)
		}
		records = append(records, map[string]any{"taskId": r.TaskID, "generation": r.Generation, "received": received, "adopted": json.RawMessage(r.AdoptedJSON), "issues": json.RawMessage(r.IssuesJSON), "createdAt": r.CreatedAt})
	}
	return map[string]any{"id": unit.ID, "key": unit.Key, "stage": unit.Stage, "name": unit.Name, "status": unit.Status, "sourceVersion": unit.SourceHash, "generation": unit.Generation, "input": json.RawMessage(unit.InputJSON), "adopted": json.RawMessage(unit.ResultJSON), "issues": json.RawMessage(unit.IssuesJSON), "history": records}, nil
}
