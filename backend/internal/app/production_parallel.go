package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type productionParallelOutputError struct{ error }

// Task identities and input receipts survive process restarts. Model calls use
// the regular queue/billing path; only their result commits are serialized.
type productionParallelWork struct {
	Key          string `json:"key"`
	Name         string `json:"name"`
	TaskID       string `json:"taskId,omitempty"`
	Step         int    `json:"step"`
	Attempts     int    `json:"attempts"`
	Dependencies string `json:"dependencies"`
	Correction   string `json:"correction,omitempty"`
	Error        string `json:"error,omitempty"`
	RetryAt      int64  `json:"retryAt,omitempty"`
}

func productionParallelReady(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) []productionParallelWork {
	if m.Plan == nil || m.Plan.Version < 2 {
		return nil
	}
	next := productionPlanNextAction(m, doc, artifacts)
	if stringValue(next["blockedReason"]) != "" {
		return nil
	}
	var candidates []productionParallelWork
	switch productionPlanPhase(stringValue(next["phase"])) {
	case planPhaseStandards:
		for _, key := range []string{"visual", "direction"} {
			section, _ := planSection(key)
			candidates = append(candidates, productionParallelWork{Key: key, Name: section.Title})
		}
	case planPhaseAssets:
		for _, item := range m.Plan.Assets {
			candidates = append(candidates, productionParallelWork{Key: item.Key, Name: item.Name})
		}
	default:
		return nil
	}
	ready := []productionParallelWork{}
	for _, work := range candidates {
		if productionPlanArtifactValid(m, doc, artifacts, work.Key) || productionPlanPrerequisites(m, doc, artifacts, work.Key) != nil {
			continue
		}
		work.Dependencies = productionStoredValueHash(productionPlanDependencies(m, artifacts, work.Key))
		ready = append(ready, work)
	}
	return ready
}

func productionParallelKeys(work map[string]productionParallelWork) []string {
	keys := make([]string, 0, len(work))
	for key := range work {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// Invoked at a Pi model boundary, so the serial model lane is never active
// while independent dossiers are being drafted.
func (s *Service) runProductionParallel(ctx context.Context, userID, runID string) (bool, error) {
	handled := false
	for {
		if err := ctx.Err(); err != nil {
			return handled, err
		}
		if s.IsDraining() {
			return handled, context.Canceled
		}
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return handled, err
		}
		state, err := cloudAgentDecode(run)
		if err != nil {
			return handled, err
		}
		if cloudAgentRunTerminal(run.Status) {
			return handled, context.Canceled
		}
		if state.Request.Production == nil || state.ActiveTaskID != "" || state.MediaTaskID != "" {
			return handled, nil
		}
		_, m, doc, err := productionLoad(s.repo, run, &state)
		if err != nil {
			return handled, err
		}
		if m.Plan == nil || m.Plan.Version < 2 {
			return handled, nil
		}
		if len(state.ProductionParallel) == 0 {
			changed, err := s.ensureProductionPlanGroups(userID, runID)
			if errors.Is(err, repository.ErrCreationConflict) {
				continue
			}
			if err != nil {
				return handled, err
			}
			if changed {
				continue
			}
		}
		artifacts, err := s.repo.ProductionAgentArtifacts(userID, runID)
		if err != nil {
			return handled, err
		}
		changed, running, failed := false, false, ""
		for _, key := range productionParallelKeys(state.ProductionParallel) {
			work := state.ProductionParallel[key]
			if work.Error != "" {
				failed = work.Name + "：" + work.Error
				continue
			}
			if work.TaskID == "" {
				if work.Dependencies != productionStoredValueHash(productionPlanDependencies(m, artifacts, key)) || productionPlanPrerequisites(m, doc, artifacts, key) != nil {
					return true, BadAuthRequest("前置文稿已变化或缺失，已停止旧版本重试：" + work.Name)
				}
				continue
			}
			task, err := s.repo.TaskForUser(userID, work.TaskID)
			if err != nil {
				return true, err
			}
			if !cloudAgentTaskTerminal(task.Status) {
				running = true
				continue
			}
			err = s.settleProductionParallel(userID, runID, work, task)
			if errors.Is(err, repository.ErrCreationConflict) {
				changed = true
				break
			}
			if err != nil {
				return true, err
			}
			changed = true
			break
		}
		if changed {
			handled = true
			continue
		}
		if failed != "" && !running {
			return true, BadAuthRequest("部分文稿未完成，已有产物已保留，可在详情继续：" + failed)
		}
		if !state.ProductionPaused && failed == "" {
			policy, err := s.runtimeConcurrencySetting()
			if err != nil {
				return handled, err
			}
			ready := productionParallelReady(m, doc, artifacts)
			capacityBlocked := false
			inFlight := 0
			for _, work := range state.ProductionParallel {
				if work.TaskID != "" {
					inFlight++
				}
			}
			for _, work := range ready {
				// A smaller policy drains existing requests before admitting new work,
				// including retries whose checkpoint no longer has a task receipt.
				if inFlight >= policy.ConcurrencyFor(model.TaskConcurrencyAgent) {
					break
				}
				if existing, ok := state.ProductionParallel[work.Key]; ok {
					if existing.TaskID != "" || existing.RetryAt > time.Now().UnixMilli() {
						continue
					}
					work = existing
				}
				err = s.enqueueProductionParallel(run, &state, m, doc, artifacts, work)
				if errors.Is(err, repository.ErrActiveTaskLimit) {
					capacityBlocked = true
					break
				}
				if errors.Is(err, repository.ErrCreationConflict) {
					changed = true
					break
				}
				if err != nil {
					return true, err
				}
				changed = true
				handled = true
				break
			}
			if changed {
				continue
			}
			if len(state.ProductionParallel) == 0 && !capacityBlocked {
				return handled, nil
			}
		}
		select {
		case <-ctx.Done():
			return handled, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (s *Service) enqueueProductionParallel(run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, work productionParallelWork) error {
	if state.ProductionPaused {
		return repository.ErrCreationConflict
	}
	if err := productionPlanPrerequisites(m, doc, artifacts, work.Key); err != nil {
		return err
	}
	if work.Dependencies != productionStoredValueHash(productionPlanDependencies(m, artifacts, work.Key)) {
		return BadAuthRequest("前置文稿版本已变化，未继续旧文稿调用")
	}
	context, err := productionPlanContext(s.repo, run, m, doc)
	if err != nil {
		return err
	}
	args := map[string]any{"key": work.Key, "name": work.Name, "factIds": []string{}}
	for _, a := range artifacts {
		if a.Key == work.Key {
			args["expectedHash"] = a.ContentHash
		}
	}
	context["nextAction"] = map[string]any{"key": work.Key, "name": work.Name, "kind": productionPlanKind(m, work.Key), "tool": "production_submit", "arguments": args}
	context["requiredDocuments"] = productionPlanRequiredContext(m, doc, artifacts, work.Key)
	context["instruction"] = "本次只完成指定文稿。上下文已提供当前版本前置成果，直接调用 production_submit 保存；不读取或查询状态，不输出开场说明，不生成其他文稿。所有模板必填字段完整填写。"
	if work.Correction != "" {
		context["correction"] = work.Correction
	}
	tools := productionRuntimeTools(m, context)
	var submit []map[string]any
	for _, tool := range tools {
		if tool["function"].(map[string]any)["name"] == "production_submit" {
			submit = append(submit, tool)
		}
	}
	canonical := canonicalAgentRequest{SystemPrompt: productionScopedPolicy(state.Canonical.SystemPrompt, m), Tools: submit, ToolChoice: "required", Messages: productionCheckpointMessages(nil, state.Request.Prompt, context, productionScopedPolicy(state.Canonical.SystemPrompt, m)), PromptCacheKey: state.Canonical.PromptCacheKey}
	state.StepLimits, err = s.cloudAgentStepLimits()
	if err != nil {
		return err
	}
	state.Canonical.Tools = productionRuntimeTools(m, nil)
	work.Attempts++
	thinking := cloudAgentReasoningEnabled(state.Policy.ReasoningMode) && !state.ForceThinkingOff
	input := map[string]any{"mode": "text", "prompt": state.Request.Prompt, "agentRequests": map[string]any{"canonical": canonical}, "config": map[string]any{"channelId": state.Request.ChannelID, "channelModelKey": state.Request.ChannelModelKey, "model": firstNonEmpty(state.Request.ChannelModelKey, state.Request.Model)}, "textOptions": map[string]any{"stream": true, "thinking": thinking, "reasoningEffort": state.Request.ReasoningEffort.effective(), "reasoningDisabled": !thinking, "maxOutputTokens": cloudAgentStepOutputBudget(state.StepLimits, state.BoostStepOutputBudget)}, "productionParallelKey": work.Key, "productionDependencies": work.Dependencies}
	req := CreateTaskRequest{ProjectID: state.Request.CanvasID, Type: "canvas_text", Operation: cloudAgentStepOperation, Prompt: state.Request.Prompt, Model: firstNonEmpty(state.Request.ChannelModelKey, state.Request.Model), LogicalModelID: state.Request.LogicalModelID, Input: input}
	if err = s.enqueueCloudAgentTaskWithWork(run, state, req, nil, &work); err == nil {
		s.wakeTaskDispatcher()
	}
	return err
}

func (s *Service) settleProductionParallel(userID, runID string, work productionParallelWork, task *model.Task) error {
	var failure error
	retryable := false
	if task.Status != model.TaskStatusSucceeded {
		failure = BadAuthRequest(userFacingTaskFailure(task))
		retryable = s.cloudAgentModelTaskRetryable(task.ID)
	} else {
		var result struct {
			ToolCalls []cloudAgentCall `json:"toolCalls"`
		}
		if err := json.Unmarshal([]byte(task.ResultJSON), &result); err != nil || len(result.ToolCalls) != 1 || result.ToolCalls[0].Function.Name != "production_submit" {
			failure = BadAuthRequest("请直接调用 production_submit，仅保存指定的一份完整文稿")
			retryable = true
		} else {
			call := result.ToolCalls[0]
			call.ID = "parallel-" + task.ID
			var args map[string]any
			if json.Unmarshal([]byte(call.Function.Arguments), &args) != nil || stringValue(args["key"]) != work.Key || stringValue(args["name"]) != work.Name {
				failure = BadAuthRequest("返回的文稿 key/name 与当前分工不一致，请沿用指定 key/name")
				retryable = true
			} else {
				failure = s.commitProductionParallel(userID, runID, work, task, call)
				var outputError productionParallelOutputError
				if errors.As(failure, &outputError) {
					retryable = true
				} else {
					// A storage, source-version or cancellation failure must not
					// trigger another billed model call for a valid response.
					return failure
				}
			}
		}
		if failure == nil || errors.Is(failure, repository.ErrCreationConflict) {
			return failure
		}
	}
	return s.recordProductionParallelFailure(userID, runID, work, task, failure, retryable)
}

func (s *Service) commitProductionParallel(userID, runID string, work productionParallelWork, task *model.Task, call cloudAgentCall) error {
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return err
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	return s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		if cloudAgentRunTerminal(current.Status) {
			return context.Canceled
		}
		if state.ProductionParallel[work.Key].TaskID != task.ID {
			return repository.ErrCreationConflict
		}
		_, m, doc, err := productionLoad(repo, current, &state)
		if err != nil {
			return err
		}
		artifacts, err := repo.ProductionAgentArtifacts(userID, runID)
		if err != nil {
			return err
		}
		if reason := stringValue(productionPlanNextAction(m, doc, artifacts)["blockedReason"]); reason != "" {
			return BadAuthRequest(reason)
		}
		if work.Dependencies != productionStoredValueHash(productionPlanDependencies(m, artifacts, work.Key)) {
			return BadAuthRequest("前置文稿版本已变化，旧结果未写入")
		}
		if err := productionPlanPrerequisites(m, doc, artifacts, work.Key); err != nil {
			return err
		}
		if !productionPlanArtifactValid(m, doc, artifacts, work.Key) {
			if _, err = productionAgentTool(repo, current, &state, call, policy); err != nil {
				var invalid *kernel.AppError
				if errors.As(err, &invalid) && invalid.Status == 400 {
					return productionParallelOutputError{err}
				}
				return err
			}
		}
		payload := productionModelCompletedPayload(task, work.Step, "文稿已保存")
		payload["itemName"] = work.Name
		state.event(runID, "production_model_completed", payload)
		delete(state.ProductionParallel, work.Key)
		return cloudAgentSave(current, &state)
	})
}

func (s *Service) recordProductionParallelFailure(userID, runID string, work productionParallelWork, task *model.Task, failure error, retryable bool) error {
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return err
	}
	return s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		if cloudAgentRunTerminal(current.Status) {
			return context.Canceled
		}
		if state.ProductionParallel[work.Key].TaskID != task.ID {
			return repository.ErrCreationConflict
		}
		work.Correction = truncateRunes(cloudAgentSafeToolError(failure), 1200)
		payload := productionModelCompletedPayload(task, work.Step, work.Correction)
		payload["status"] = "failed"
		payload["itemName"] = work.Name
		state.event(runID, "production_model_completed", payload)
		if retryable && work.Attempts <= cloudAgentModelStepRetries {
			work.TaskID = ""
			work.RetryAt = time.Now().Add(time.Duration(1<<(work.Attempts-1)) * time.Second).UnixMilli()
			state.event(runID, "production_progress", map[string]any{"text": fmt.Sprintf("%s：本项将自动重试，其他已保存文稿保留", work.Name)})
		} else {
			work.Error = work.Correction
		}
		state.ProductionParallel[work.Key] = work
		return cloudAgentSave(current, &state)
	})
}
