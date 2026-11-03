package app

import (
	"strings"
	"testing"
)

func TestProductionProgressIssuesLimitsCountAndLength(t *testing.T) {
	issues := []cloudAgentValidationIssue{
		{Message: strings.Repeat("长", 300)},
		{Message: "  "},
		{Issue: "missing_asset_source"},
		{Message: "b"},
		{Message: "c"},
	}
	got := productionProgressIssues(issues)
	if len(got) != productionProgressIssueLimit {
		t.Fatalf("expected %d issues, got %d: %v", productionProgressIssueLimit, len(got), got)
	}
	if n := len([]rune(got[0])); n != productionProgressIssueRunes+1 {
		t.Fatalf("expected truncated message of %d runes, got %d", productionProgressIssueRunes+1, n)
	}
	if got[1] != "missing_asset_source" || got[2] != "b" {
		t.Fatalf("unexpected issues: %v", got)
	}
}
