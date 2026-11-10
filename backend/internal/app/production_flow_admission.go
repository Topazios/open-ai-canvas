package app

import (
	"errors"
	"time"

	"infinite-canvas/backend/internal/model"
)

var errProductionFlowRecoveryExhausted = errors.New("production flow recovery without progress exhausted")

func productionFlowIsRetry(unit model.ProductionFlowUnit) bool {
	return unit.Status == "repair" || unit.Attempts > 0 || productionFlowInput(unit)["parentUnitId"] != nil
}

// Shared by the run, persisted with its result/event transaction. Channel-wide
// admission and circuit breaking remain owned by the existing coordinator.
type productionFlowControl struct {
	Scope               string `json:"scope,omitempty"`
	Window              int    `json:"window,omitempty"`
	Successes           int    `json:"successes,omitempty"`
	Failures            int    `json:"failures,omitempty"`
	ConsecutiveFailures int    `json:"consecutiveFailures,omitempty"`
	RetrySpent          int    `json:"retrySpent,omitempty"`
	RetryBudget         int    `json:"retryBudget,omitempty"`
	TotalRetries        int    `json:"totalRetries,omitempty"`
	ManualRounds        int    `json:"manualRounds,omitempty"`
	RecoveryRounds      int    `json:"recoveryRounds,omitempty"`
	Submitted           int    `json:"submitted,omitempty"`
	Received            int    `json:"received,omitempty"`
	CooldownUntil       int64  `json:"cooldownUntil,omitempty"`
}

func (c *productionFlowControl) initialize(root, source string, ceiling, planned int) {
	scope := root + ":" + source
	if c.Scope != scope {
		*c = productionFlowControl{Scope: scope}
	}
	if c.Window < 1 {
		c.Window = min(8, max(1, ceiling))
	}
	c.RetryBudget = max(c.RetryBudget, max(6, min(24, (planned+2)/3)))
}

func (c productionFlowControl) limit(ceiling int, now time.Time) int {
	if c.CooldownUntil > now.UnixMilli() {
		return 0
	}
	return min(max(1, ceiling), max(1, c.Window))
}

func (c *productionFlowControl) accepted(ceiling int) {
	c.Successes++
	c.ConsecutiveFailures = 0
	// Bound retries without progress, not all repairs across a long production.
	c.RetrySpent, c.RecoveryRounds = 0, 0
	if c.Successes >= max(1, c.Window) {
		c.Window = min(max(1, ceiling), c.Window+1)
		c.Successes = 0
	}
}

// A drained retry window can recover without a user click, but a persistent
// outage cannot create unlimited paid attempts. Unit-specific limits still apply.
func (c *productionFlowControl) recover(now time.Time) bool {
	if c.RecoveryRounds >= 3 {
		return false
	}
	c.RecoveryRounds++
	c.RetrySpent = 0
	c.Successes = 0
	c.Window = max(1, c.Window/2)
	c.CooldownUntil = now.Add(time.Duration(15*(1<<(c.RecoveryRounds-1))) * time.Second).UnixMilli()
	return true
}

func (c *productionFlowControl) congestion(now time.Time) {
	c.Failures++
	c.ConsecutiveFailures++
	c.Successes = 0
	// One reduction per cooldown, not once for every old in-flight failure.
	if now.UnixMilli() >= c.CooldownUntil {
		c.Window = max(1, c.Window/2)
		c.CooldownUntil = now.Add(15 * time.Second).UnixMilli()
	}
}

func (c *productionFlowControl) retry() bool {
	if c.RetrySpent >= c.RetryBudget {
		return false
	}
	c.RetrySpent++
	c.TotalRetries++
	return true
}

func productionFlowEffort(unit model.ProductionFlowUnit, requested ReasoningEffort) ReasoningEffort {
	if productionFlowHasBatchPolicy(productionFlowInput(unit)) && (unit.Stage == "extract" || unit.Stage == "omissions") {
		return ReasoningLow
	}
	return requested.effective()
}

func productionFlowRequests(g productionFlowGraph) int {
	total := 0
	for _, u := range g.Units {
		if u.Stage != "catalog" {
			total++
		}
	}
	return total
}
