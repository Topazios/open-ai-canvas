package app

import (
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestProductionRuntimeOutputLimitRecovery(t *testing.T) {
	for _, secondFails := range []bool{false, true} {
		name := "recovery succeeds"
		if secondFails {
			name = "recovery exhausts"
		}
		t.Run(name, func(t *testing.T) {
			s, db, run := planFixture(t, 2)
			productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
			submitOrderedPlan(t, s, run.ID, "story", "", "故事总纲")
			before := productionHash(mustPlanArtifacts(t, s, run.ID))
			first, done := productionRuntimeStart(t, s, run.ID, []map[string]any{{"role": "user", "content": "continue production"}})
			firstOptions := stepTaskTextOptions(t, s, first)
			productionRuntimeMutate(t, s, run.ID, func(state *cloudAgentRuntime) {
				if state.ProductionModelReceipts == nil {
					state.ProductionModelReceipts = map[string]string{}
				}
				state.ProductionModelReceipts["failed-receipt"] = first.ID
			})
			if err := db.Model(&model.Task{}).Where("id = ?", first.ID).Updates(map[string]any{
				"status": model.TaskStatusFailed, "error": errProviderOutputLimit.Error(),
			}).Error; err != nil {
				t.Fatal(err)
			}
			var retry *model.Task
			deadline := time.Now().Add(5 * time.Second)
			for time.Now().Before(deadline) {
				_, state := productionRuntimeState(t, s, run.ID)
				if state.ActiveTaskID != "" && state.ActiveTaskID != first.ID {
					var err error
					retry, err = s.repo.Task(state.ActiveTaskID)
					if err != nil {
						t.Fatal(err)
					}
					if state.OutputLimitEscalated != 1 || state.ProductionModelReceipts["failed-receipt"] != "" || !agentHasEventWithReason(state, "model_failure_recovered", "output_limit_retried") {
						t.Fatal("recovery did not persist its limit, clear the failed receipt and record its reason")
					}
					break
				}
				select {
				case got := <-done:
					t.Fatalf("bridge returned before output-limit recovery: %v", got.err)
				case <-time.After(10 * time.Millisecond):
				}
			}
			if retry == nil {
				t.Fatal("output-limit recovery was never scheduled")
			}
			options := stepTaskTextOptions(t, s, retry)
			if options["maxOutputTokens"] != firstOptions["maxOutputTokens"] || options["thinking"] != false || options["reasoningDisabled"] != true {
				t.Fatalf("recovery must disable reasoning without increasing the policy budget: %v", options)
			}
			if secondFails {
				if err := db.Model(&model.Task{}).Where("id = ?", retry.ID).Updates(map[string]any{
					"status": model.TaskStatusFailed, "error": errProviderOutputLimit.Error(),
				}).Error; err != nil {
					t.Fatal(err)
				}
				select {
				case got := <-done:
					if got.err == nil || cloudAgentUserFailureMessage(run.ID, got.err) != errProviderOutputLimit.Error() {
						t.Fatalf("second failure must stop with the output-limit reason: %v", got.err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("bridge kept retrying output-limit failures")
				}
				var count int64
				if err := db.Model(&model.Task{}).Where("agent_run_id = ? AND operation = ?", run.ID, cloudAgentStepOperation).Count(&count).Error; err != nil || count != 2 {
					t.Fatalf("output-limit retry count=%d, want exactly two attempts, err=%v", count, err)
				}
			} else if result := productionRuntimeFinish(t, db, retry.ID, done, productionRuntimeCall("production_plan_inventory")); result.err != nil {
				t.Fatal(result.err)
			}
			if after := productionHash(mustPlanArtifacts(t, s, run.ID)); after != before {
				t.Fatal("output-limit recovery changed already saved documents")
			}
		})
	}
}

func TestCloudAgentOutputLimitClassification(t *testing.T) {
	s, db := modelRetryTestService(t)
	for _, message := range []string{errProviderOutputLimit.Error(), "Responses 输出达到 token 上限，生成未完成；请增加输出上限或拆分任务"} {
		task := model.Task{ID: newID(), Status: model.TaskStatusFailed, Error: message}
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&model.ApiCallLog{ID: newID(), TaskID: task.ID, StatusCode: 200, ErrorCode: "upstream_response_invalid"}).Error; err != nil {
			t.Fatal(err)
		}
		if s.cloudAgentModelTaskTransientFailure(task.ID) {
			t.Fatal("output limit must not trigger unchanged transient retries")
		}
		text, reason := cloudAgentModelFailure(&task)
		if reason != providerOutputLimitCode || !strings.Contains(text, errProviderOutputLimit.Error()) {
			t.Fatalf("lost output-limit failure explanation: %s %s", reason, text)
		}
	}
	if cloudAgentOutputLimitReached(&model.Task{Status: model.TaskStatusSucceeded, Error: errProviderOutputLimit.Error()}) || cloudAgentOutputLimitReached(&model.Task{Status: model.TaskStatusCancelled, Error: errProviderOutputLimit.Error()}) {
		t.Fatal("successful and cancelled tasks must not trigger output-limit recovery")
	}
}
