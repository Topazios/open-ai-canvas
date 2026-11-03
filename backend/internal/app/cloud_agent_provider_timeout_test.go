package app

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func providerTimeoutTask(t *testing.T, status model.TaskStatus, code string) *model.Task {
	t.Helper()
	raw, err := json.Marshal(model.TaskExecutionDiagnostic{Code: code, RetryClass: "new_generation_authorization"})
	if err != nil {
		t.Fatal(err)
	}
	return &model.Task{Status: status, ExecutionDiagnosticJSON: string(raw)}
}

func TestCloudAgentProviderRequestTimeoutCountsAsStepTimeout(t *testing.T) {
	for _, tc := range []struct {
		name string
		task *model.Task
		want bool
	}{
		{name: "provider timeout", task: providerTimeoutTask(t, model.TaskStatusFailed, "provider_request_timeout"), want: true},
		{name: "wall clock marker", task: &model.Task{Status: model.TaskStatusFailed, Error: cloudAgentStepTimeoutError}, want: true},
		{name: "other diagnostic", task: providerTimeoutTask(t, model.TaskStatusFailed, "server_error")},
		{name: "succeeded task", task: providerTimeoutTask(t, model.TaskStatusSucceeded, "provider_request_timeout")},
		{name: "no diagnostic", task: &model.Task{Status: model.TaskStatusFailed}},
		{name: "nil task"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := cloudAgentStepTimedOut(tc.task); got != tc.want {
				t.Fatalf("cloudAgentStepTimedOut = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestForceCloudAgentThinkingOffPersistsOnce(t *testing.T) {
	s, _, root := reliableAgentRoot(t)

	if err := s.forceCloudAgentThinkingOff("user", root.ID); err != nil {
		t.Fatal(err)
	}
	_, state := agentInterjectionState(t, s, root.ID)
	if !state.ForceThinkingOff {
		t.Fatal("ForceThinkingOff 没有写入运行状态")
	}
	if !agentHasEventWithReason(state, "model_failure_recovered", "provider_timeout_thinking_off") {
		t.Fatal("缺少关思考重试事件")
	}

	// 再次调用不重复追加事件，也不改变修订之外的状态。
	before := len(state.Events)
	if err := s.forceCloudAgentThinkingOff("user", root.ID); err != nil {
		t.Fatal(err)
	}
	_, again := agentInterjectionState(t, s, root.ID)
	if len(again.Events) != before {
		t.Fatalf("重复调用追加了事件: %d -> %d", before, len(again.Events))
	}
}
