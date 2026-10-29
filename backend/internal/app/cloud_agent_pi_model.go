// Agent 运行时的模型调用桥：把运行时的一次模型请求转成平台文本任务并等待结果。
//
// 模型步走平台任务体系（计费、渠道路由、超时都复用文本任务）；临时故障与
// 截断的工具参数会在同一步内重试，次数上限见 cloudAgentModelStepRetries。

package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// cloudAgentPiModel 模型调用桥接
func (s *Service) cloudAgentPiModel(ctx context.Context, userID, runID string, payload map[string]json.RawMessage) (any, error) {
	var request struct {
		Messages      []map[string]any `json:"messages"`
		Tools         []map[string]any `json:"tools"`
		ThinkingLevel string           `json:"thinkingLevel"`
	}
	if err := decodePiPayload(payload, &request); err != nil {
		return nil, err
	}
	if len(request.Messages) == 0 {
		return nil, fmt.Errorf("no messages")
	}
	if err := s.prepareStoryboardEpisode(ctx, userID, runID); err != nil {
		return nil, err
	}

	// 上游临时故障（5xx、429、超时、连接错误、空回复）自动重试，首次失败后最多再试 3 次，
	// 指数退避。参数/鉴权类 4xx 重试也不会变好，直接失败。
	// 模型吐出损坏的工具参数 JSON（截断或多一个括号）时，那次调用并没有被执行：
	// 与 Go 执行循环的 correctCloudAgentTruncatedCalls 一致，附上 truncated_tool_arguments
	// 纠偏上下文重做这一步，而不是把整轮判死。次数与临时故障共用同一个上限。
	var lastErr error
	var correction []map[string]any
	for attempt := 0; ; {
		if attempt > 0 {
			delay := time.Duration(1<<(attempt-1)) * time.Second
			log.Printf("[Agent] model step retry run=%s attempt=%d/%d after %s: %v", runID, attempt, cloudAgentModelStepRetries, delay, lastErr)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(delay):
			}
		}
		result, retryable, err := s.runCloudAgentModelStep(ctx, userID, runID, request.Messages, request.ThinkingLevel, correction...)
		if err == nil {
			return result, nil
		}
		var continuation *productionRuntimeContinueError
		if errors.As(err, &continuation) {
			correction = nil
			if continuation.Quiet {
				return map[string]any{"text": "", "toolCalls": []any{}}, nil
			}
			continue
		}
		lastErr = err
		if !retryable {
			return nil, err
		}
		if attempt >= cloudAgentModelStepRetries {
			return nil, lastErr
		}
		if errors.Is(err, errCloudAgentTruncatedToolArguments) && correction == nil {
			correction = []map[string]any{cloudAgentRuntimeMessage(cloudAgentRuntimeContext{Kind: cloudAgentContextTruncatedArguments})}
		}
		attempt++
	}
}

// cloudAgentModelStepRetries 是单步模型调用首次失败后的最大重试次数。
const cloudAgentModelStepRetries = 3

// errCloudAgentTruncatedToolArguments 标记"模型返回的工具参数不是完整 JSON"：
// 调用未执行，可以带纠偏上下文重做同一步。
var errCloudAgentTruncatedToolArguments = errors.New("truncated tool arguments")

func (s *Service) productionPlanSingleAttempt(userID, runID string) bool {
	job, err := s.repo.ProductionAgentJob(userID, runID)
	if err != nil {
		return false
	}
	var manifest productionManifest
	return json.Unmarshal([]byte(job.ManifestJSON), &manifest) == nil && manifest.Plan != nil && manifest.Plan.Version >= 5
}

// runCloudAgentModelStep 调度并等待一次模型步骤；第二个返回值表示失败是否值得重试。
func (s *Service) runCloudAgentModelStep(ctx context.Context, userID, runID string, messages []map[string]any, thinkingLevel string, correction ...map[string]any) (any, bool, error) {
	if err := s.waitProductionAgentBoundary(ctx, userID, runID); err != nil {
		return nil, false, err
	}
	// Re-enter this lane on every retry as well as after restart. An oversized
	// serial document may have just moved to durable section work.
	if handled, err := s.runProductionParallel(ctx, userID, runID); handled || err != nil {
		if err != nil {
			return nil, false, err
		}
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return nil, false, err
		}
		state, err := cloudAgentDecode(run)
		if err != nil {
			return nil, false, err
		}
		job, manifest, _, err := productionLoad(s.repo, run, &state)
		if err != nil {
			return nil, false, err
		}
		if manifest.Plan != nil && manifest.Plan.Version >= 5 {
			if job.Validated {
				text := "故事总纲与世界规则已保存。可右键创作其他制作方案。"
				if manifest.Plan.PlansStarted {
					text = "其他制作方案已分别保存。"
				}
				return map[string]any{"text": text, "toolCalls": []any{}}, false, nil
			}
			if productionParallelQuietHeld(state) || productionRuntimeQuietHold(&state) {
				return map[string]any{"text": "", "toolCalls": []any{}}, false, nil
			}
			return nil, false, errors.New("独立制作方案调度未保存阶段完成回执")
		}
		nextTool := "production_status"
		if manifest.Storyboard != nil {
			nextTool = "production_storyboard_context"
		}
		return map[string]any{"text": "本批独立内容已保存，继续检查下一阶段。", "toolCalls": []map[string]any{{"id": generateID(), "name": nextTool, "arguments": map[string]any{}}}}, false, nil
	}
	// 运行时发起 /model 的同时会并发推送事件（message_start、session_snapshot 等），
	// 这些事件也会推进运行 revision。调度模型步骤是 CAS 写入：冲突时重新读取
	// 最新状态再调度，而不是把整轮判失败。冲突时事务整体回滚，不会产生任务或扣费。
	var state cloudAgentRuntime
	var productionCheckpoint string
	for attempt := 0; attempt < 8; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return nil, false, err
		}
		state, err = cloudAgentDecode(run)
		if err != nil {
			return nil, false, err
		}
		if state.Request.Production != nil && run.Status == "waiting_user" {
			err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
				currentState, decodeErr := cloudAgentDecode(current)
				if decodeErr != nil {
					return decodeErr
				}
				productionBlockRuntime(current, &currentState)
				return cloudAgentSave(current, &currentState)
			})
			if errors.Is(err, repository.ErrCreationConflict) {
				continue
			}
			if err != nil {
				return nil, false, err
			}
			s.projectProductionAgentStatus(userID, runID)
			continue
		}
		if cloudAgentRunTerminal(run.Status) || run.Status == "waiting_user" {
			return nil, false, fmt.Errorf("run already terminated")
		}
		productionPolicy := state.Canonical.SystemPrompt
		var productionWork map[string]any
		if state.Request.Production != nil {
			job, manifest, doc, err := productionLoad(s.repo, run, &state)
			if err != nil {
				return nil, false, err
			}
			productionPolicy = productionScopedPolicy(state.Canonical.SystemPrompt, manifest)
			if manifest.Plan != nil {
				productionWork, err = productionPlanContext(s.repo, run, manifest, doc)
				if err != nil {
					return nil, false, err
				}
			} else if manifest.Storyboard != nil {
				productionWork, err = storyboardContext(s.repo, userID, manifest, doc)
				if err != nil {
					return nil, false, err
				}
			}
			if productionRuntimeQuietHold(&state) {
				return map[string]any{"text": "", "toolCalls": []any{}}, false, nil
			}
			tools := productionRuntimeTools(manifest, productionWork)
			// Refresh the durable whitelist before reusing an in-flight task or a
			// model receipt. Runtime session schemas are never authoritative.
			if productionHash(state.Canonical.Tools) != productionHash(tools) || state.Canonical.SystemPrompt != productionPolicy {
				state.Canonical.Tools = tools
				state.Canonical.SystemPrompt = productionPolicy
				err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
					return cloudAgentSave(current, &state)
				})
				if err != nil && !errors.Is(err, repository.ErrCreationConflict) {
					return nil, false, err
				}
				continue
			}
			if state.ActiveTaskID == "" && job.Validated {
				facts, done, total, err := productionFacts(s.repo, userID, manifest)
				if err != nil {
					return nil, false, err
				}
				artifacts, err := s.repo.ProductionAgentArtifacts(userID, runID)
				if err != nil {
					return nil, false, err
				}
				if productionCoverage(manifest, doc, facts, artifacts, done, total)["valid"] == true {
					if manifest.Plan != nil {
						if manifest.Plan.Version >= 2 && !manifest.Plan.AssetsStarted {
							return map[string]any{"text": "制作方案与全部规范已保存，完整性检查通过。资产清单已登记，可手动点击生成资产。", "toolCalls": []any{}}, false, nil
						}
						return map[string]any{"text": "故事总纲与计划资产已分组保存，清单覆盖检查通过；内容质量待人工验收。", "toolCalls": []any{}}, false, nil
					}
					if manifest.Storyboard != nil {
						return map[string]any{"text": "全部场次镜头已保存，整集校验通过；制作质量待人工验收。", "toolCalls": []any{}}, false, nil
					}
					return map[string]any{"text": fmt.Sprintf("已解析 %d/%d 页并保存 %d 项资产，覆盖检查通过；语义质量待人工验收。", done, total, len(artifacts)), "toolCalls": []any{}}, false, nil
				}
			}
			if state.ActiveTaskID == "" && !job.Validated && manifest.Plan != nil && manifest.Plan.Version >= 2 {
				next, _ := productionWork["nextAction"].(map[string]any)
				if next["tool"] == "production_check" && next["phase"] == string(planPhaseValidation) && stringValue(next["blockedReason"]) == "" {
					return map[string]any{"text": "全部计划文稿已保存，执行完整性检查。", "toolCalls": []map[string]any{{"id": generateID(), "name": "production_check", "arguments": map[string]any{}}}}, false, nil
				}
			}
			productionCheckpoint, err = productionRuntimeCheckpoint(s.repo, run, manifest)
			if err != nil {
				return nil, false, err
			}
		}
		if state.Request.Production != nil {
			if state.ActiveTaskID != "" {
				break
			}
			state.ProductionModelKey = productionRuntimeModelKey(messages, thinkingLevel, correction, productionCheckpoint)
			if receipt := state.ProductionModelReceipts[state.ProductionModelKey]; receipt != "" {
				reusable, err := productionRuntimeReusableReceipt(s.repo, userID, &state, receipt)
				if err != nil {
					return nil, false, err
				}
				if reusable {
					state.ActiveTaskID = receipt
					break
				}
				delete(state.ProductionModelReceipts, state.ProductionModelKey)
			}
			next, _ := productionWork["nextAction"].(map[string]any)
			if stringValue(next["blockedReason"]) != "" {
				return map[string]any{"text": "", "toolCalls": []any{}}, false, nil
			}
		}
		if cloudAgentStepBudgetExhausted(&state) {
			return nil, false, BadAuthRequest("本轮调用次数已用完，已保存进度；可在节点详情追加次数并继续")
		}
		// Production remains completion-driven; repeated successful reads are
		// corrected below without imposing a task or credit quota.
		if state.StepLimits, err = s.cloudAgentStepLimits(); err != nil {
			return nil, false, err
		}
		// 一个运行同一时刻只能有一个活动任务。媒体任务还没回写时不能再入队模型步骤，
		// 否则检查点校验会拒绝（"多个活动任务"）并让整轮失败。先等媒体结果落库。
		if state.MediaTaskID != "" {
			if _, waitErr := s.waitCloudAgentTask(ctx, state.MediaTaskID); waitErr != nil && ctx.Err() != nil {
				return nil, false, ctx.Err()
			}
			if err := s.settleCloudAgentMedia(userID, runID); err != nil {
				return nil, false, err
			}
			continue
		}

		canonical := canonicalFromRuntimeMessages(messages, state.Canonical.Tools, state.Canonical.SystemPrompt)
		if state.Request.Production != nil {
			if productionRuntimeUnknownCall(canonical.Tools, productionRuntimeLatestCalls(canonical.Messages)) {
				return nil, false, s.blockProductionRuntimeTool(userID, runID, "")
			}
			canonical.Messages = productionCheckpointMessages(canonical.Messages, state.Request.Prompt, productionWork, productionPolicy)
		}
		// A continuation starts a fresh Pi process. If its session snapshot was
		// unavailable, the runtime transcript is shorter than the server-authored
		// canonical history. Reuse canonical directly so provider tool_calls are
		// not accidentally converted as if they were Pi content blocks.
		if len(state.Canonical.Messages) > len(messages) && state.Request.Production == nil {
			canonical = state.Canonical
		}
		canonical.PromptCacheKey = state.Canonical.PromptCacheKey
		if len(canonical.Messages) == 0 {
			return nil, false, fmt.Errorf("no canonical messages")
		}
		state.Canonical = canonical
		var recovery *productionRuntimeRecovery
		if state.Request.Production != nil {
			recovery, err = s.correctProductionRuntimeCycle(userID, runID, &state, productionCheckpoint, productionWork, &canonical)
			if errors.Is(err, errProductionRuntimeNoProgress) {
				return nil, false, s.blockProductionRuntime(userID, runID, "", "production_no_progress", productionRuntimeNoProgressError(&state))
			}
			if err != nil {
				return nil, false, err
			}
		}
		if len(correction) > 0 {
			// 纠偏上下文只用于这一次请求，不写回运行状态，避免下一步重复出现。
			canonical.Messages = append(append([]map[string]any(nil), canonical.Messages...), correction...)
		}
		requiredProductionTool := productionConstrainPlan(productionWork, &canonical)
		if recovery != nil && len(canonical.Tools) == 1 {
			requiredProductionTool = stringValue(canonical.Tools[0]["function"].(map[string]any)["name"])
		}
		productionConstrainStoryboard(productionWork, &canonical)
		input := map[string]any{
			"mode":          "text",
			"prompt":        state.Request.Prompt,
			"agentRequests": map[string]any{"canonical": canonical},
			"config": map[string]any{
				"channelId":       state.Request.ChannelID,
				"channelModelKey": state.Request.ChannelModelKey,
				"model":           firstNonEmpty(state.Request.ChannelModelKey, state.Request.Model),
			},
			"textOptions": map[string]any{
				"stream":            true,
				"thinking":          cloudAgentPiThinkingEnabled(thinkingLevel) && !state.ForceThinkingOff,
				"reasoningEffort":   state.Request.ReasoningEffort.effective(),
				"reasoningDisabled": !cloudAgentPiThinkingEnabled(thinkingLevel) || state.ForceThinkingOff,
				"maxOutputTokens":   cloudAgentStepOutputBudget(state.StepLimits, state.BoostStepOutputBudget),
			},
		}
		if state.Request.Production != nil {
			input["productionCheckpoint"] = productionCheckpoint
			input["productionRecovery"] = recovery
			input["productionRequiredTool"] = requiredProductionTool
		}
		req := CreateTaskRequest{
			ProjectID: state.Request.CanvasID,
			Type:      "canvas_text",
			// Operation: cloudAgentStepOperation
			Operation:      cloudAgentStepOperation,
			Prompt:         state.Request.Prompt,
			Model:          firstNonEmpty(state.Request.ChannelModelKey, state.Request.Model),
			LogicalModelID: state.Request.LogicalModelID,
			Input:          input,
		}
		err = s.enqueueCloudAgentTask(run, &state, req, nil)
		if errors.Is(err, repository.ErrCreationConflict) {
			state.ActiveTaskID = ""
			time.Sleep(time.Duration(attempt+1) * 20 * time.Millisecond)
			continue
		}
		if err != nil {
			return nil, false, err
		}
		break
	}
	if state.ActiveTaskID == "" {
		return nil, false, fmt.Errorf("Agent model step was not scheduled: %w", repository.ErrCreationConflict)
	}
	// 任务已入队：立刻唤醒调度器，不等下一次轮询。
	s.wakeTaskDispatcher()
	taskID := state.ActiveTaskID
	task, err := s.waitCloudAgentTask(ctx, taskID)
	if err != nil {
		truncated := false
		if failed, lookupErr := s.repo.Task(taskID); lookupErr == nil && failed != nil && failed.Status != model.TaskStatusSucceeded {
			if ctx.Err() == nil && cloudAgentOutputLimitReached(failed) {
				if s.productionPlanSingleAttempt(userID, runID) {
					return nil, false, s.quietProductionRuntime(userID, runID, taskID, "production_output_incomplete", err)
				}
				recovered, recoveryErr := s.recoverCloudAgentOutputLimit(userID, runID, taskID)
				if recoveryErr != nil {
					return nil, false, recoveryErr
				}
				return nil, recovered, err
			}
			truncated = cloudAgentTruncatedToolArguments(failed)
		}
		retryable := ctx.Err() == nil && (truncated || s.cloudAgentModelTaskRetryable(taskID))
		if retryable {
			// 释放失败的步骤，下一次重试才能重新入队。
			if releaseErr := s.finishCloudAgentPiModelStep(userID, runID, taskID, "", ""); releaseErr != nil {
				return nil, false, releaseErr
			}
		}
		if truncated {
			err = fmt.Errorf("%w: %v", errCloudAgentTruncatedToolArguments, err)
		}
		return nil, retryable, err
	}
	var result struct {
		Text      string           `json:"text"`
		Reasoning string           `json:"reasoning,omitempty"`
		ToolCalls []cloudAgentCall `json:"toolCalls"`
	}
	if err := json.Unmarshal([]byte(task.ResultJSON), &result); err != nil {
		return nil, false, fmt.Errorf("decode model result: %w", err)
	}
	if err := s.finishCloudAgentPiModelStep(userID, runID, task.ID, result.Text, result.Reasoning); err != nil {
		return nil, false, err
	}
	var instruction productionRuntimeStepInput
	if state.Request.Production != nil {
		_ = json.Unmarshal([]byte(task.InputJSON), &instruction)
	}
	if state.Request.Production != nil && productionRuntimeUnknownCall(state.Canonical.Tools, result.ToolCalls) {
		if instruction.Recovery != nil {
			return nil, false, s.quietProductionRuntime(userID, runID, task.ID, "unknown_production_tool", errProductionRuntimeUnknownTool)
		}
		return nil, false, s.blockProductionRuntimeTool(userID, runID, task.ID)
	}
	if state.Request.Production != nil && instruction.RequiredTool != "" {
		if len(result.ToolCalls) != 1 || result.ToolCalls[0].Function.Name != instruction.RequiredTool {
			cause := fmt.Errorf("模型未执行当前步骤指定制作工具 %s", instruction.RequiredTool)
			if instruction.Recovery != nil {
				return nil, false, s.quietProductionRuntime(userID, runID, task.ID, "production_required_output_missing", cause)
			}
			return nil, false, s.blockProductionRuntime(userID, runID, task.ID, "production_required_output_missing", cause)
		}
	}
	if state.Request.Production != nil && len(result.ToolCalls) > 0 {
		ignored, err := s.productionRuntimeRecoveryFailed(userID, runID, task, result.ToolCalls)
		if err != nil {
			return nil, false, err
		}
		if ignored {
			return nil, false, s.quietProductionRuntime(userID, runID, task.ID, "production_no_progress", errProductionRuntimeNoProgress)
		}
	}
	if state.Request.Production != nil && len(result.ToolCalls) == 0 {
		cause := errors.New("模型未提交当前制作步骤结果")
		if instruction.Recovery != nil {
			return nil, false, s.quietProductionRuntime(userID, runID, task.ID, "production_empty_output", cause)
		}
		return nil, false, s.blockProductionRuntime(userID, runID, task.ID, "production_empty_output", cause)
	}
	return map[string]any{"text": result.Text, "reasoning": result.Reasoning, "toolCalls": runtimeToolCalls(result.ToolCalls)}, false, nil
}

// cloudAgentPiThinkingEnabled treats an omitted thinking level the same as Pi's
// explicit "off" value. Pi omits the field when thinking is disabled, and the
// Go JSON decoder represents that omitted field as an empty string.
func cloudAgentPiThinkingEnabled(thinkingLevel string) bool {
	return thinkingLevel != "" && thinkingLevel != "off"
}

// Include structured stream errors even when the transport returned HTTP 200.
func (s *Service) cloudAgentModelTaskRetryable(taskID string) bool {
	return s.cloudAgentModelTaskTransientFailure(taskID)
}

// finishCloudAgentPiModelStep 释放已完成的模型步骤，并把最终正文写入 Agent 事件流。
// 不释放 ActiveTaskID 的话，completeCloudAgentPiRun 会一直认为还有任务在跑。
func (s *Service) finishCloudAgentPiModelStep(userID, runID, taskID, text, reasoning string) error {
	for attempt := 0; attempt < 8; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			fresh, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			if fresh.ActiveTaskID != taskID {
				return nil
			}
			fresh.ActiveTaskID = ""
			fresh.ActiveTextDraft = ""
			if fresh.Request.Production != nil {
				if task, err := repo.TaskForUser(userID, taskID); err == nil {
					payload := productionModelCompletedPayload(task, fresh.Step, "模型调用已完成")
					if task.Status != model.TaskStatusSucceeded {
						payload["text"] = cloudAgentSafeMediaTaskError(task)
					}
					fresh.event(runID, "production_model_completed", payload)
				}
				if task, err := repo.TaskForUser(userID, taskID); err == nil && task.Status != model.TaskStatusSucceeded {
					for key, id := range fresh.ProductionModelReceipts {
						if id == taskID {
							delete(fresh.ProductionModelReceipts, key)
						}
					}
				}
			}
			if reasoning != "" {
				fresh.event(runID, "reasoning_message", map[string]any{"messageId": taskID + ":reasoning", "text": truncateRunes(reasoning, 8000)})
			}
			// Production runs must persist documents through production_submit. Do
			// not copy a model's free-form document into the execution journal;
			// otherwise an unsubmitted answer looks like a saved canvas result.
			if text != "" && fresh.Request.Production == nil {
				fresh.event(runID, "assistant_message", map[string]any{"messageId": taskID, "text": text})
			}
			return cloudAgentSave(current, &fresh)
		})
		if !errors.Is(err, repository.ErrCreationConflict) {
			return err
		}
	}
	return repository.ErrCreationConflict
}

func (s *Service) waitCloudAgentTask(ctx context.Context, taskID string) (*model.Task, error) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		task, err := s.repo.Task(taskID)
		if err != nil {
			return nil, err
		}
		if cloudAgentTaskTerminal(task.Status) {
			if task.Status != model.TaskStatusSucceeded {
				// 与画布节点同一套失败分类（网络/审核/存储/HTTP 状态/供应商原因），
				// 原始错误保留在任务中心诊断里，不直接抛给用户。
				return nil, BadAuthRequest(userFacingTaskFailure(task))
			}
			return task, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}
