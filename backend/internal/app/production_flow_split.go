package app

import (
	"encoding/json"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/model"
)

type productionFlowSplit struct {
	Inputs []map[string]any `json:"inputs"`
}

func productionFlowUnitFields(unit model.ProductionFlowUnit) []string {
	var input struct {
		SelectedFields []string `json:"selectedFields"`
	}
	_ = json.Unmarshal([]byte(unit.InputJSON), &input)
	if len(input.SelectedFields) > 0 {
		return input.SelectedFields
	}
	fields := productionFlowFields(unit.Stage)
	return fields
}

// At most one restructuring per lineage. Its children use the same contracts
// and persistent ownership as ordinary units; aggregation is a local operation.
func productionFlowRestructure(unit *model.ProductionFlowUnit) bool {
	input := productionFlowInput(*unit)
	if input["restructured"] == true || unit.SplitJSON != "" {
		return false
	}
	split := productionFlowSplit{}
	add := func(changes map[string]any) {
		next := productionFlowInput(*unit)
		for k, v := range changes {
			next[k] = v
		}
		next["restructured"], next["parentUnitId"], next["parentAdopted"] = true, unit.ID, productionFlowValue(*unit)
		split.Inputs = append(split.Inputs, next)
	}
	fields := productionFlowUnitFields(*unit)
	if len(fields) > 1 {
		missing := []string{}
		for _, field := range fields {
			if _, ok := productionFlowValue(*unit)[field]; !ok {
				missing = append(missing, field)
			}
		}
		if len(missing) == 0 {
			return false
		}
		size := max(1, (len(missing)+1)/2)
		for start := 0; start < len(missing); start += size {
			add(map[string]any{"selectedFields": missing[start:min(start+size, len(missing))]})
		}
	} else if unit.Stage == "cards" {
		covered := map[int]bool{}
		var prior []map[string]any
		_ = decodeFlowValue(productionFlowValue(*unit)["episodes"], &prior)
		for _, ep := range prior {
			covered[int(numberValue(ep["episode"], 0))] = true
		}
		start, end := int(numberValue(input["start"], 0)), int(numberValue(input["end"], 0))
		if start == end {
			return false
		}
		for n := start; n <= end; n++ {
			if !covered[n] {
				add(map[string]any{"start": n, "end": n})
			}
		}
	} else if unit.Stage == "extract" || unit.Stage == "omissions" {
		var sources []productionFlowSource
		_ = decodeFlowValue(input["sources"], &sources)
		if len(sources) > 1 {
			add(map[string]any{"sources": sources[:len(sources)/2]})
			add(map[string]any{"sources": sources[len(sources)/2:]})
		} else {
			for _, source := range sources {
				runes := []rune(source.Text)
				if len(runes) < 2 {
					return false
				}
				cut := productionFlowNaturalCut(runes)
				if cut == 0 {
					return false
				}
				for _, part := range []string{string(runes[:cut]), string(runes[cut:])} {
					if strings.TrimSpace(part) == "" {
						continue
					}
					src := source
					src.Text = part
					add(map[string]any{"sources": []productionFlowSource{src}})
				}
			}
		}
	} else if unit.Stage == "arcs" {
		count := int(numberValue(input["episodeCount"], 0))
		if count < 2 {
			return false
		}
		add(map[string]any{"start": 1, "end": count / 2})
		add(map[string]any{"start": count/2 + 1, "end": count, "serialAfterPart": 1})
	} else if unit.Stage == "resolve" {
		var candidates []productionFlowCandidate
		_ = decodeFlowValue(input["assignedCandidates"], &candidates)
		var adopted, existing []productionFlowEntity
		_ = decodeFlowValue(productionFlowValue(*unit)["entities"], &adopted)
		_ = decodeFlowValue(input["existingEntities"], &existing)
		covered := map[string]bool{}
		for _, entity := range adopted {
			for _, id := range entity.Members {
				covered[id] = true
			}
		}
		pending := []productionFlowCandidate{}
		for _, candidate := range candidates {
			if !covered[candidate.ID] {
				pending = append(pending, candidate)
			}
		}
		if len(pending) == 0 || len(pending) == 1 && len(adopted) == 0 {
			return false
		}
		existing = append(existing, adopted...)
		if len(pending) == 1 {
			add(map[string]any{"assignedCandidates": pending, "existingEntities": existing})
		} else {
			add(map[string]any{"assignedCandidates": pending[:len(pending)/2], "existingEntities": existing})
			add(map[string]any{"assignedCandidates": pending[len(pending)/2:], "existingEntities": existing, "serialAfterPart": 1})
		}
	}
	if unit.Stage == "identity" {
		var entities []productionFlowEntity
		_ = decodeFlowValue(input["entities"], &entities)
		if len(entities) < 2 {
			return false
		}
		for _, part := range [][]productionFlowEntity{entities[:len(entities)/2], entities[len(entities)/2:]} {
			var all map[string][]productionFlowCandidate
			_ = decodeFlowValue(input["evidence"], &all)
			evidence := map[string][]productionFlowCandidate{}
			for _, entity := range part {
				evidence[entity.ID] = all[entity.ID]
			}
			add(map[string]any{"entities": part, "evidence": evidence})
		}
	}
	if len(split.Inputs) == 0 {
		return false
	}
	unit.SplitJSON, unit.Status = productionFlowJSON(split), "split"
	return true
}

func (g *productionFlowGraph) splitChildren(parent model.ProductionFlowUnit) {
	var split productionFlowSplit
	if json.Unmarshal([]byte(parent.SplitJSON), &split) != nil {
		return
	}
	children := []model.ProductionFlowUnit{}
	readyAll := true
	for i, input := range split.Inputs {
		if input["serialAfterPart"] != nil {
			if !readyAll {
				return
			}
			if parent.Stage == "arcs" {
				input["precedingArcs"] = productionFlowValue(children[len(children)-1])
			} else {
				var existing []productionFlowEntity
				_ = decodeFlowValue(input["existingEntities"], &existing)
				for _, previous := range children {
					var batch []productionFlowEntity
					_ = decodeFlowValue(productionFlowValue(previous)["entities"], &batch)
					existing = append(existing, batch...)
				}
				input["existingEntities"] = existing
			}
		}
		u, ready := g.add(strings.TrimPrefix(parent.Key, "flow/"+g.Root+"/")+fmt.Sprintf("/part/%02d", i+1), parent.Stage, fmt.Sprintf("%s · 补充%d", parent.Name, i+1), input)
		readyAll = readyAll && ready
		children = append(children, u)
	}
	if len(children) > 0 && readyAll {
		if g.Aggregates == nil {
			g.Aggregates = map[string][]model.ProductionFlowUnit{}
		}
		g.Aggregates[parent.ID] = children
	}
}

func productionFlowAggregate(parent model.ProductionFlowUnit, children []model.ProductionFlowUnit) (string, []productionFlowIssue) {
	result := productionFlowValue(parent)
	for _, child := range children {
		for key, value := range productionFlowValue(child) {
			if key == "episodes" || key == "candidates" || key == "entities" || key == "arcs" || key == "groups" {
				var prior, incoming []map[string]any
				_ = decodeFlowValue(result[key], &prior)
				_ = decodeFlowValue(value, &incoming)
				for _, row := range incoming {
					if key == "entities" {
						// The second half can reference an entity introduced by the
						// first half. Fold it locally before validating original scope.
						existing := stringValue(row["existing"])
						merged := false
						for _, item := range prior {
							if existing != "" && stringValue(item["id"]) == existing {
								var a, b []string
								_ = decodeFlowValue(item["members"], &a)
								_ = decodeFlowValue(row["members"], &b)
								item["members"] = append(a, b...)
								merged = true
								break
							}
						}
						if merged {
							continue
						}
					}
					if key == "candidates" {
						delete(row, "id")
						delete(row, "locations")
						row["localRef"] = child.ID[:12] + ":" + stringValue(row["localRef"])
					}
					prior = append(prior, row)
				}
				result[key] = prior
			} else {
				result[key] = value
			}
		}
	}
	// Strip server-owned fields from adopted candidates before revalidating the
	// combined result against the original full source (including byte offsets).
	if parent.Stage == "extract" || parent.Stage == "omissions" {
		var rows []map[string]any
		_ = decodeFlowValue(result["candidates"], &rows)
		for _, row := range rows {
			delete(row, "id")
			delete(row, "locations")
		}
		result["candidates"] = rows
		if (parent.Stage == "omissions" || productionFlowInput(parent)["coveragePolicy"] == "integrated-v2") && productionFlowInput(parent)["coveragePolicy"] != nil {
			productionFlowMergeCoverage(parent, result, children)
		}
		if productionFlowInput(parent)["coveragePolicy"] == "integrated-v2" {
			productionFlowMergeSourceReviews(parent, result, children)
		}
	}
	if parent.Stage == "resolve" {
		var rows []map[string]any
		_ = decodeFlowValue(result["entities"], &rows)
		for _, row := range rows {
			delete(row, "id")
			delete(row, "kind")
			delete(row, "aliases")
		}
		result["entities"] = rows
	}
	return productionFlowValidate(parent, productionFlowJSON(result))
}

func productionFlowNaturalCut(text []rune) int {
	best, distance := 0, len(text)
	for n, r := range text {
		if n < len(text)/4 || n >= len(text)*3/4 {
			continue
		}
		if !strings.ContainsRune("\n。！？!?；;", r) {
			continue
		}
		d := n - len(text)/2
		if d < 0 {
			d = -d
		}
		if d < distance {
			best, distance = n+1, d
		}
	}
	return best
}
