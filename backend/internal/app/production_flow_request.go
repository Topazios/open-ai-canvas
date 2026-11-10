package app

import (
	"encoding/json"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// Narrow field repair requests, never the saved assignment or its final checks.
func productionFlowRequestUnit(unit model.ProductionFlowUnit) model.ProductionFlowUnit {
	if unit.Status == "repair" && unit.Stage == "extract" && productionFlowInput(unit)["coveragePolicy"] == "integrated-v2" {
		input := productionFlowInput(unit)
		input["covered"] = productionFlowValue(unit)["candidates"]
		unit.InputJSON = productionFlowJSON(input)
		return unit
	}
	fields := productionFlowUnitFields(unit)
	if unit.Status != "repair" || len(fields) == 0 {
		return unit
	}
	var issues []productionFlowIssue
	_ = json.Unmarshal([]byte(unit.IssuesJSON), &issues)
	wanted := map[string]bool{}
	adopted := productionFlowObject(unit.ResultJSON)
	for _, field := range fields {
		if len(adopted[field]) == 0 {
			wanted[field] = true
		}
	}
	for _, issue := range issues {
		if issue.Layer != "schema" && issue.Layer != "protocol" {
			return unit // Semantic repairs can change several interdependent fields.
		}
		if cloudAgentContainsString(fields, issue.Target) {
			wanted[issue.Target] = true
		}
	}
	selected := []string{}
	for _, field := range fields {
		if wanted[field] || field == "episode" {
			selected = append(selected, field)
		}
	}
	if len(wanted) == 0 || len(selected) == len(fields) {
		return unit
	}
	input := productionFlowInput(unit)
	input["selectedFields"] = selected
	unit.InputJSON = productionFlowJSON(input)
	return unit
}

func productionFlowHeldMessage(units []model.ProductionFlowUnit) string {
	for _, unit := range units {
		if unit.Status != "held" {
			continue
		}
		var issues []productionFlowIssue
		_ = json.Unmarshal([]byte(unit.IssuesJSON), &issues)
		for _, issue := range issues {
			if issue.Layer == "protocol" || issue.Layer == "execution" {
				return unit.Name + "未完成：" + strings.TrimSpace(issue.Message) + "。已保存成果保留，可继续重试未完成步骤"
			}
		}
	}
	for _, unit := range units {
		if unit.Status != "held" {
			continue
		}
		var issues []productionFlowIssue
		_ = json.Unmarshal([]byte(unit.IssuesJSON), &issues)
		if len(issues) > 0 {
			return unit.Name + "自动修复未通过：" + strings.TrimSpace(issues[0].Message) + "。已保留成果，可重试未完成步骤"
		}
	}
	return "局部内容修复已达本轮上限，已保存成果保留；可重试未完成单元"
}
