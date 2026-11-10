package app

import (
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestProductionFlowTransportRetryIsDurableAndBounded(t *testing.T) {
	s, db, id := flowFixture(t)
	g, _ := flowGraph(t, s, id, "story")
	u := g.Units[0]
	for n := 1; n <= productionParallelTransientRetries+1; n++ {
		var task *model.Task
		var work productionParallelWork
		u, work, task = installFlowResponse(t, s, db, id, u, "{}")
		mutateParallelState(t, s, id, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
			work.TransientAttempts = n - 1
			state.ProductionParallel[u.Key] = work
		})
		task.Status, task.Error, task.ResultJSON = model.TaskStatusFailed, "http2: client connection lost", ""
		if err := db.Save(task).Error; err != nil {
			t.Fatal(err)
		}
		if err := s.settleProductionFlow("user", id, work, task); err != nil {
			t.Fatal(err)
		}
		saved, _ := s.repo.ProductionFlowUnit("user", id, u.ID)
		u = *saved
		_, state := productionRuntimeState(t, s, id)
		retry := state.ProductionParallel[u.Key]
		if n <= productionParallelTransientRetries {
			if u.Status != "repair" || retry.TaskID != "" || retry.RetryAt <= time.Now().UnixMilli() || retry.TransientAttempts != n || u.Attempts != 0 {
				t.Fatal("transport failure consumed content budget or lost retry", u, retry)
			}
		} else if u.Status != "held" || !retry.QuietHold {
			t.Fatal("retry budget not enforced", u, retry)
		}
	}
	receipts, _ := s.repo.ProductionFlowReceipts("user", id, u.ID)
	if len(receipts) != productionParallelTransientRetries+1 {
		t.Fatal("failed calls missing from history", len(receipts))
	}
}

func TestProductionFlowPermanentOrUncertainFailureDoesNotRetry(t *testing.T) {
	for _, tc := range []struct {
		name, message string
		cancel        model.ProviderCancelStatus
	}{
		{name: "quota", message: "insufficient_quota"},
		{name: "uncertain", message: "http2: client connection lost", cancel: model.ProviderCancelStatusUncertain},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db, id := flowFixture(t)
			g, _ := flowGraph(t, s, id, "story")
			u, work, task := installFlowResponse(t, s, db, id, g.Units[0], "{}")
			task.Status, task.Error, task.ProviderCancelStatus = model.TaskStatusFailed, tc.message, tc.cancel
			if err := db.Save(task).Error; err != nil {
				t.Fatal(err)
			}
			if err := s.settleProductionFlow("user", id, work, task); err != nil {
				t.Fatal(err)
			}
			saved, _ := s.repo.ProductionFlowUnit("user", id, u.ID)
			if saved.Status != "held" || strings.Contains(productionFlowHeldMessage([]model.ProductionFlowUnit{*saved}), "修复已达") {
				t.Fatal("permanent failure retried or mislabeled as content repair", saved)
			}
		})
	}
}

func TestProductionFlowBackoffDoesNotDispatchOrPause(t *testing.T) {
	s, db, id := flowFixture(t)
	g, _ := flowGraph(t, s, id, "story")
	u := g.Units[0]
	u.Status = "repair"
	if err := s.repo.SaveProductionFlowUnit(&u, u.TaskID, u.Generation); err != nil {
		t.Fatal(err)
	}
	mutateParallelState(t, s, id, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) {
		state.ProductionParallel = map[string]productionParallelWork{u.Key: {Key: u.Key, FlowUnitID: u.ID, RetryAt: time.Now().Add(time.Minute).UnixMilli(), TransientAttempts: 1}}
	})
	run, state := productionRuntimeState(t, s, id)
	_, manifest, doc, err := productionLoad(s.repo, run, &state)
	if err != nil {
		t.Fatal(err)
	}
	artifacts, err := s.repo.ProductionAgentArtifacts("user", id)
	if err != nil {
		t.Fatal(err)
	}
	var before, after int64
	db.Model(&model.Task{}).Count(&before)
	changed, err := s.advanceProductionFlow(run, &state, manifest, doc, artifacts, "story")
	if err != nil || changed {
		t.Fatal("backoff was not idle", changed, err)
	}
	db.Model(&model.Task{}).Count(&after)
	if before != after {
		t.Fatal("submitted before retry deadline")
	}
	run, state = productionRuntimeState(t, s, id)
	if run.Status != "running" || state.ProductionPaused {
		t.Fatal("backoff paused root")
	}
	if state.ProductionParallel[u.Key].RetryAt <= time.Now().UnixMilli() {
		t.Fatal("retry deadline lost from saved checkpoint")
	}
}
