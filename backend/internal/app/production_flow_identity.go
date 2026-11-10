package app

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
)

type productionFlowIdentityGroup struct {
	Canonical string                   `json:"canonical"`
	Members   []string                 `json:"members"`
	Reason    string                   `json:"reason"`
	Purpose   string                   `json:"purpose"`
	Evidence  []productionFlowEvidence `json:"evidence"`
}

// Normalization only retrieves possible matches. It never merges identities.
func productionFlowIdentityLabel(name string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || unicode.IsPunct(r) || r == '的' {
			return -1
		}
		return unicode.ToLower(r)
	}, name)
}

func productionFlowIdentitySchema() map[string]any {
	str := map[string]any{"type": "string"}
	return map[string]any{"type": "object", "additionalProperties": false, "required": []string{"groups"}, "properties": map[string]any{
		"groups": map[string]any{"type": "array", "items": map[string]any{"type": "object", "additionalProperties": false,
			"required": []string{"canonical", "members", "reason", "purpose", "evidence"}, "properties": map[string]any{
				"canonical": str, "members": map[string]any{"type": "array", "items": str}, "reason": str,
				"purpose":  str,
				"evidence": map[string]any{"type": "array", "items": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"ref", "quote"}, "properties": map[string]any{"ref": str, "quote": str}}},
			},
		}},
	}}
}

func productionFlowValidateIdentity(raw json.RawMessage, input map[string]any) []productionFlowIssue {
	var groups []productionFlowIdentityGroup
	var entities []productionFlowEntity
	var evidence map[string][]productionFlowCandidate
	_ = decodeFlowValue(input["entities"], &entities)
	_ = decodeFlowValue(input["evidence"], &evidence)
	assigned := map[string]productionFlowEntity{}
	for _, e := range entities {
		assigned[e.ID] = e
	}
	issues := []productionFlowIssue{}
	add := func(id, msg string) {
		issues = append(issues, productionFlowIssueAt("schema", "identity_audit", id, msg))
	}
	if json.Unmarshal(raw, &groups) != nil {
		add("groups", "身份复核需返回分组数组")
		return issues
	}
	seen := map[string]bool{}
	for _, group := range groups {
		if len(group.Members) == 0 || !cloudAgentContainsString(group.Members, group.Canonical) || strings.TrimSpace(group.Reason) == "" || strings.TrimSpace(group.Purpose) == "" || utf8.RuneCountInString(group.Purpose) > 300 {
			add(group.Canonical, "每组需有效的归属身份、成员、判断依据及300字内的简明剧情用途")
		}
		proven := map[string]bool{}
		for _, ev := range group.Evidence {
			valid := false
			for _, c := range evidence[ev.Ref] {
				valid = valid || strings.TrimSpace(ev.Quote) != "" && strings.Contains(c.Quote, ev.Quote)
			}
			if !valid || !cloudAgentContainsString(group.Members, ev.Ref) {
				add(ev.Ref, "合并证据必须逐字引用该组身份的原文")
			} else {
				proven[ev.Ref] = true
			}
		}
		for _, id := range group.Members {
			if _, ok := assigned[id]; !ok || seen[id] {
				add(id, "身份超出范围或被重复归组")
			}
			seen[id] = true
			if len(group.Members) > 1 && !proven[id] {
				add(id, "合并需分别提供每个身份的原文证据，不能仅凭同名或职业合并")
			}
		}
	}
	for id := range assigned {
		if !seen[id] {
			add(id, "身份复核遗漏此项")
		}
	}
	return issues
}

func productionFlowIdentityEvidence(entities []productionFlowEntity, byID map[string]productionFlowCandidate) map[string][]productionFlowCandidate {
	result := map[string][]productionFlowCandidate{}
	for _, e := range entities {
		seen := map[string]bool{}
		// First and latest actions preserve continuity; prefer a different
		// location/ownership context for the third representative.
		for _, reverse := range []bool{false, true, false} {
			for n := 0; n < len(e.Members); n++ {
				i := n
				if reverse {
					i = len(e.Members) - 1 - n
				}
				c, ok := byID[e.Members[i]]
				if !ok || seen[c.ID] {
					continue
				}
				if len(result[e.ID]) == 2 && c.Context == result[e.ID][0].Context {
					continue
				}
				seen[c.ID] = true
				result[e.ID] = append(result[e.ID], productionFlowIdentityProjection(c))
				break
			}
		}
		if len(result[e.ID]) < 3 {
			for _, id := range e.Members {
				if c, ok := byID[id]; ok && !seen[id] {
					result[e.ID] = append(result[e.ID], productionFlowIdentityProjection(c))
					seen[id] = true
				}
				if len(result[e.ID]) == 3 {
					break
				}
			}
		}
	}
	return result
}

func productionFlowIdentityProjection(c productionFlowCandidate) productionFlowCandidate {
	excerpt := func(text string, limit int) string {
		if utf8.RuneCountInString(text) <= limit {
			return text
		}
		return string([]rune(text)[:limit])
	}
	// The full evidence remains in the immutable extraction. These exact
	// excerpts bound retrieval context without inventing a shortened quote.
	c.Quote, c.Context = excerpt(c.Quote, 600), excerpt(c.Context, 300)
	c.Action, c.State, c.Reason = excerpt(c.Action, 300), excerpt(c.State, 300), excerpt(c.Reason, 200)
	c.Locations, c.SubjectRefs, c.DependsOnRefs = nil, nil, nil
	return c
}

func productionFlowOrderIdentityMatches(items []productionFlowEntity, byID map[string]productionFlowCandidate) {
	parent := make([]int, len(items))
	for i := range parent {
		parent[i] = i
	}
	var root func(int) int
	root = func(n int) int {
		if parent[n] != n {
			parent[n] = root(parent[n])
		}
		return parent[n]
	}
	labels, contexts := map[string]int{}, map[string]int{}
	join := func(index map[string]int, key string, n int) {
		if key == "" {
			return
		}
		if other, ok := index[key]; ok {
			a, b := root(other), root(n)
			if a != b {
				if a > b {
					a, b = b, a
				}
				parent[b] = a
			}
		} else {
			index[key] = n
		}
	}
	for n, e := range items {
		for _, name := range append([]string{e.Name}, e.Aliases...) {
			join(labels, productionFlowIdentityLabel(name), n)
		}
		for _, id := range e.Members {
			if c, ok := byID[id]; ok {
				join(contexts, productionFlowIdentityLabel(c.Context), n)
			}
		}
	}
	groups := make(map[string]int, len(items))
	for n, e := range items {
		groups[e.ID] = root(n)
	}
	// Connected aliases/context are adjacent even if their display names sort
	// far apart. This is a review assignment, never an identity decision.
	sort.SliceStable(items, func(i, j int) bool { return groups[items[i].ID] < groups[items[j].ID] })
}

func productionFlowResolveEnd(batch []productionFlowCandidate, start int) int {
	end, size := start, 0
	for end < len(batch) && end < start+96 {
		next := utf8.RuneCountInString(productionFlowJSON(batch[end]))
		if end > start && size+next > 18000 {
			break
		}
		size += next
		end++
	}
	return end
}

// The shortlist is indexed once per reconstruction. A batch carries relevant
// identities plus primary and recent fallback entries, rather than all history.
type productionFlowIdentityIndex struct {
	byLabel map[string][]int
	byID    map[string]int
	prior   []productionFlowEntity
}

func (index *productionFlowIdentityIndex) append(e productionFlowEntity) {
	if index.byID == nil {
		index.byID = map[string]int{}
	}
	n, exists := index.byID[e.ID]
	if exists {
		index.prior[n] = e
	} else {
		n = len(index.prior)
		index.prior = append(index.prior, e)
		index.byID[e.ID] = n
	}
	for _, name := range append([]string{e.Name}, e.Aliases...) {
		key := productionFlowIdentityLabel(name)
		if !containsProductionEpisode(index.byLabel[key], n) {
			index.byLabel[key] = append(index.byLabel[key], n)
		}
	}
}
func (index *productionFlowIdentityIndex) selectFor(batch []productionFlowCandidate) []productionFlowEntity {
	chosen := map[int]bool{}
	matched := map[int]bool{}
	for _, c := range batch {
		for _, n := range index.byLabel[productionFlowIdentityLabel(c.Label)] {
			if len(chosen) < 64 {
				chosen[n] = true
				matched[n] = true
			}
		}
	}
	for n, e := range index.prior {
		if len(chosen) < 48 && e.Importance == "primary" {
			chosen[n] = true
		}
	}
	for n := len(index.prior) - 1; n >= 0 && len(chosen) < 48; n-- {
		chosen[n] = true
	}
	numbers := make([]int, 0, len(chosen))
	for n := range chosen {
		numbers = append(numbers, n)
	}
	sort.Slice(numbers, func(i, j int) bool {
		if matched[numbers[i]] != matched[numbers[j]] {
			return matched[numbers[i]]
		}
		return numbers[i] < numbers[j]
	})
	result := make([]productionFlowEntity, 0, len(numbers))
	for _, n := range numbers {
		e := index.prior[n]
		e.Members = nil
		result = append(result, e)
	}
	return result
}

func productionFlowResolveContext(index *productionFlowIdentityIndex, batch []productionFlowCandidate, byID map[string]productionFlowCandidate) ([]productionFlowEntity, map[string][]productionFlowCandidate) {
	result, evidence := []productionFlowEntity{}, map[string][]productionFlowCandidate{}
	size := 0
	for _, e := range index.selectFor(batch) {
		full := index.prior[index.byID[e.ID]]
		proof := productionFlowIdentityEvidence([]productionFlowEntity{full}, byID)[e.ID]
		if utf8.RuneCountInString(e.Reason) > 300 {
			e.Reason = string([]rune(e.Reason)[:300])
		}
		next := utf8.RuneCountInString(productionFlowJSON(e)) + utf8.RuneCountInString(productionFlowJSON(proof))
		if len(result) > 0 && size+next > 18000 {
			break
		}
		result = append(result, e)
		evidence[e.ID] = proof
		size += next
	}
	return result, evidence
}

func productionFlowIdentityGraph(g *productionFlowGraph, byID map[string]productionFlowCandidate) bool {
	entities := productionFlowBaseEntities(g.Units)
	ready := true
	for _, kind := range productionCurrentPlanKinds {
		items := []productionFlowEntity{}
		for _, e := range entities {
			if e.Kind == kind && e.Disposition != "excluded" {
				items = append(items, e)
			}
		}
		sort.Slice(items, func(i, j int) bool {
			a, b := productionFlowIdentityLabel(items[i].Name), productionFlowIdentityLabel(items[j].Name)
			if a != b {
				return a < b
			}
			return items[i].ID < items[j].ID
		})
		productionFlowOrderIdentityMatches(items, byID)
		if len(items) < 2 {
			continue
		}
		for start, part := 0, 0; start < len(items); part++ {
			end, size := start, 0
			evidence := map[string][]productionFlowCandidate{}
			for end < len(items) && end < start+48 {
				e := items[end]
				proof := productionFlowIdentityEvidence([]productionFlowEntity{e}, byID)[e.ID]
				// Only original quotes and identity context are needed for audit.
				for i := range proof {
					proof[i].Locations = nil
					proof[i].SubjectRefs = nil
					proof[i].DependsOnRefs = nil
				}
				next := utf8.RuneCountInString(productionFlowJSON(proof)) + utf8.RuneCountInString(productionFlowJSON(e))
				if end > start+1 && size+next > 18000 {
					break
				}
				evidence[e.ID] = proof
				size += next
				end++
			}
			compact := append([]productionFlowEntity{}, items[start:end]...)
			for i := range compact {
				compact[i].Members = nil
			}
			_, ok := g.add(fmt.Sprintf("identity/%s/%04d", kind, part), "identity", "发布前身份复核："+productionPlanGroupLabels[kind], map[string]any{"entities": compact, "evidence": evidence, "auditRevision": g.AuditRevision})
			ready = ready && ok
			if end == len(items) {
				break
			}
			start = end - 1
		}
	}
	return ready
}

func productionFlowApplyIdentity(entities []productionFlowEntity, units []model.ProductionFlowUnit) []productionFlowEntity {
	parent := map[string]string{}
	for _, e := range entities {
		parent[e.ID] = e.ID
	}
	var root func(string) string
	root = func(id string) string {
		if parent[id] != id {
			parent[id] = root(parent[id])
		}
		return parent[id]
	}
	for _, u := range units {
		if u.Stage != "identity" || u.Status != "accepted" {
			continue
		}
		var groups []productionFlowIdentityGroup
		_ = decodeFlowValue(productionFlowValue(u)["groups"], &groups)
		for _, group := range groups {
			if _, ok := parent[group.Canonical]; !ok {
				continue
			}
			for _, id := range group.Members {
				if _, ok := parent[id]; !ok {
					continue
				}
				a, b := root(group.Canonical), root(id)
				if a != b {
					parent[b] = a
				}
			}
		}
	}
	byID := map[string]productionFlowEntity{}
	for _, e := range entities {
		byID[e.ID] = e
	}
	purposeWeight := map[string]int{}
	for _, u := range units {
		if u.Stage != "identity" || u.Status != "accepted" {
			continue
		}
		var groups []productionFlowIdentityGroup
		_ = decodeFlowValue(productionFlowValue(u)["groups"], &groups)
		for _, group := range groups {
			if _, ok := parent[group.Canonical]; ok {
				e := byID[root(group.Canonical)]
				if len(group.Members) > purposeWeight[e.ID] {
					e.Purpose = group.Purpose
					byID[e.ID] = e
					purposeWeight[e.ID] = len(group.Members)
				}
			}
		}
	}
	merged, order := map[string]productionFlowEntity{}, []string{}
	for _, e := range entities {
		id := root(e.ID)
		x, ok := merged[id]
		if !ok {
			x = byID[id]
			x.Members = nil
			x.Aliases = append([]string{}, x.Aliases...)
			order = append(order, id)
		}
		x.Members = append(x.Members, e.Members...)
		if e.Name != x.Name {
			x.Aliases = append(x.Aliases, e.Name)
		}
		x.Aliases = append(x.Aliases, e.Aliases...)
		if e.Importance == "primary" || e.Importance == "secondary" && x.Importance != "primary" {
			x.Importance = e.Importance
		}
		merged[id] = x
	}
	result := make([]productionFlowEntity, 0, len(order))
	for _, id := range order {
		x := merged[id]
		x.Members = productionFlowUnique(x.Members)
		x.Aliases = productionFlowUnique(x.Aliases)
		result = append(result, x)
	}
	return result
}

func productionFlowUnique(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, v := range values {
		if v != "" && !seen[v] {
			seen[v] = true
			result = append(result, v)
		}
	}
	return result
}
