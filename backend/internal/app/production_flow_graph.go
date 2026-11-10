package app

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/model"
)

type productionFlowGraph struct {
	Catalog       *productionPlan
	AuditRevision int
	ResumeHeld    bool
	Aggregates    map[string][]model.ProductionFlowUnit
	Units         []model.ProductionFlowUnit
	Existing      map[string]model.ProductionFlowUnit
	UserID        string
	RunID         string
	Root          string
	Source        string
}

func decodeFlowValue(value any, target any) error {
	return json.Unmarshal([]byte(productionFlowJSON(value)), target)
}
func productionFlowRoot(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) string {
	if m.Plan == nil || m.Plan.FlowVersion != 1 || m.Storyboard != nil {
		return ""
	}
	if !productionPlanArtifactValid(m, doc, artifacts, "story") {
		return "story"
	}
	if !m.Plan.AssetsStarted && (m.Plan.PlansStarted && cloudAgentContainsString(m.Plan.SelectedPlanKeys, "inventory") || len(m.Plan.SelectedAssetKinds) > 0) && !productionPlanArtifactValid(m, doc, artifacts, "inventory") {
		return "inventory"
	}
	return ""
}
func productionFlowSourceHash(m productionManifest, root string, artifacts []model.ProductionAgentArtifact) string {
	if root == "inventory" {
		return productionDocumentTargetHash(artifacts, "story")
	}
	return productionInputVersion(m)
}

func (g *productionFlowGraph) add(key, stage, name string, input map[string]any) (model.ProductionFlowUnit, bool) {
	input["executionPolicy"] = productionFlowBatchPolicy
	if g.Root == "story" {
		input["planningTemplate"] = productionPlanningTemplate
	}
	key = "flow/" + g.Root + "/" + key
	body := productionFlowJSON(input)
	id := productionHash([]string{g.UserID, g.RunID, g.Source, key, body})
	unit := model.ProductionFlowUnit{ID: id, UserID: g.UserID, RunID: g.RunID, Root: g.Root, SourceHash: g.Source, Key: key, Stage: stage, Name: name, Contract: 1, InputJSON: body, ResultJSON: "{}", IssuesJSON: "[]", Status: "pending"}
	if saved, ok := g.Existing[id]; ok {
		unit = saved
	}
	g.Units = append(g.Units, unit)
	if unit.Status == "split" || g.ResumeHeld && unit.Status == "held" && unit.SplitJSON != "" {
		g.splitChildren(unit)
	}
	return unit, unit.Status == "accepted"
}
func productionFlowValue(unit model.ProductionFlowUnit) map[string]any {
	return productionFlowInput(model.ProductionFlowUnit{InputJSON: unit.ResultJSON})
}
func productionFlowGlobal(units []model.ProductionFlowUnit) map[string]any {
	result := map[string]any{}
	for _, unit := range units {
		if unit.Stage == "foundation" || unit.Stage == "characters" {
			for k, v := range productionFlowValue(unit) {
				result[k] = v
			}
		}
	}
	return result
}

func productionFlowCandidates(units []model.ProductionFlowUnit) []productionFlowCandidate {
	seen := map[string]bool{}
	result := []productionFlowCandidate{}
	for _, unit := range units {
		if productionFlowInput(unit)["parentUnitId"] != nil {
			continue
		}
		if unit.Stage != "extract" && unit.Stage != "omissions" {
			continue
		}
		var batch []productionFlowCandidate
		_ = decodeFlowValue(productionFlowValue(unit)["candidates"], &batch)
		for _, c := range batch {
			if !seen[c.ID] {
				seen[c.ID] = true
				result = append(result, c)
			}
		}
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}
func productionFlowEntities(units []model.ProductionFlowUnit) []productionFlowEntity {
	return productionFlowApplyIdentity(productionFlowBaseEntities(units), units)
}
func productionFlowBaseEntities(units []model.ProductionFlowUnit) []productionFlowEntity {
	result := []productionFlowEntity{}
	index := map[string]int{}
	for _, u := range units {
		if u.Stage == "resolve" && u.Status == "accepted" && productionFlowInput(u)["parentUnitId"] == nil {
			var batch []productionFlowEntity
			_ = decodeFlowValue(productionFlowValue(u)["entities"], &batch)
			for _, e := range batch {
				if n, exists := index[e.ID]; exists {
					result[n].Members = append(result[n].Members, e.Members...)
					result[n].Aliases = append(result[n].Aliases, e.Aliases...)
				} else {
					index[e.ID] = len(result)
					result = append(result, e)
				}
			}
		}
	}
	return result
}
func productionFlowSources(hash string, sections []string, bodies map[string]string) []productionFlowSource {
	var result []productionFlowSource
	for _, section := range sections {
		paragraphs := strings.Split(bodies[section], "\n\n")
		chunks := []string{}
		current := ""
		for _, p := range paragraphs {
			if current != "" && len([]rune(current))+len([]rune(p)) > 2400 {
				chunks = append(chunks, current)
				current = ""
			}
			if current != "" {
				current += "\n\n"
			}
			current += p
		}
		if current != "" {
			chunks = append(chunks, current)
		}
		for i, chunk := range chunks {
			if strings.TrimSpace(chunk) == "" {
				continue
			}
			src := productionFlowSource{ID: productionHash([]string{hash, section, fmt.Sprint(i), chunk})[:24], Section: section, Text: chunk}
			if strings.HasPrefix(section, "episodeArchitecture/") {
				fmt.Sscanf(strings.TrimPrefix(section, "episodeArchitecture/"), "EP-%d", &src.Episode)
			}
			result = append(result, src)
		}
	}
	return result
}
