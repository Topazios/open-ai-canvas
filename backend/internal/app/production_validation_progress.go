package app

import (
	"sort"
)

// Error text may include a changed title or name. Only the independently
// diagnosed fields and rules identify an unresolved problem, not its wording.
func productionValidationProblems(issues []cloudAgentValidationIssue, fallback string) []string {
	seen := map[string]bool{}
	for _, issue := range issues {
		seen[productionHash([]string{issue.Field, issue.Issue})] = true
	}
	if len(seen) == 0 {
		seen[productionHash([]string{"unclassified", fallback})] = true
	}
	keys := make([]string, 0, len(seen))
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// A new, reduced defect set gets its own allowance. Retain recent sets across
// reductions so reintroducing solved defects and alternating A/B cannot reset
// the counter. Distinct repairs never consume a document-wide attempt limit.
func productionTrackValidationProblems(current []string, counts map[string]int, history ...*[]string) (map[string]int, int) {
	current = append([]string{}, current...)
	sort.Strings(current)
	unique := current[:0]
	for _, problem := range current {
		if len(unique) == 0 || unique[len(unique)-1] != problem {
			unique = append(unique, problem)
		}
	}
	current = unique
	if counts == nil {
		counts = map[string]int{}
	}
	signature := productionHash(current)
	counts[signature]++
	if len(history) > 0 {
		entries := append(*history[0], signature)
		if len(entries) > 32 {
			counts[entries[0]]--
			if counts[entries[0]] == 0 {
				delete(counts, entries[0])
			}
			entries = entries[1:]
		}
		*history[0] = entries
	}
	return counts, counts[signature]
}
