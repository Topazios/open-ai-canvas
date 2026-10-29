package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func cloudAgentToolArgumentLimit(production bool, name string) int {
	if production && strings.HasPrefix(name, "production_") {
		return productionToolArgumentsMaxBytes
	}
	return 32000
}

// Large document bodies remain in their task/typed artifact records. SSE needs
// receipts, not another full copy that can exceed the journal payload contract.
func productionCompactToolJournal(call cloudAgentCall, result any, payload map[string]any) {
	if len(call.Function.Arguments) > 8192 {
		var args map[string]any
		_ = json.Unmarshal([]byte(call.Function.Arguments), &args)
		summary := map[string]any{"argumentBytes": len(call.Function.Arguments)}
		for _, key := range []string{"key", "name", "pageId", "assetKey"} {
			if value, ok := args[key].(string); ok {
				summary[key] = truncateRunes(value, 160)
			}
		}
		encoded, _ := json.Marshal(summary)
		payload["arguments"] = string(encoded)
	}
	encoded, _ := json.Marshal(result)
	if len(encoded) <= 32768 {
		return
	}
	summary := map[string]any{"resultBytes": len(encoded)}
	if fields, ok := result.(map[string]any); ok {
		for key, value := range fields {
			switch typed := value.(type) {
			case string:
				if key != "text" && key != "content" {
					summary[key] = truncateRunes(typed, 512)
				}
			case bool, int, int64, float64:
				summary[key] = value
			}
		}
		for _, key := range []string{"validationIssueCount", "validationScope", "validationProblemSignature", "retry"} {
			if value, exists := fields[key]; exists {
				summary[key] = value
			}
		}
		if raw, exists := fields["validationIssues"]; exists {
			if issues, ok := raw.([]cloudAgentValidationIssue); ok {
				count, ok := fields["validationIssueCount"].(int)
				if !ok {
					count = len(issues)
				}
				// Compute the array budget once. The placeholder deliberately uses
				// the longest possible counters and `false`, so the final metadata
				// can only be the same size or smaller.
				summary["validationIssues"] = []cloudAgentValidationIssue{}
				summary["validationIssuesIncluded"] = count
				summary["validationIssuesOmitted"] = count
				summary["validationReportComplete"] = false
				base, _ := json.Marshal(summary)
				budget := 32768 - len(base)
				included := make([]cloudAgentValidationIssue, 0, len(issues))
				for _, issue := range issues {
					item, _ := json.Marshal(issue)
					cost := len(item)
					if len(included) > 0 {
						cost++
					}
					if cost > budget {
						break
					}
					budget -= cost
					included = append(included, issue)
				}
				summary["validationIssues"] = included
				summary["validationIssuesIncluded"] = len(included)
				summary["validationIssuesOmitted"] = max(0, count-len(included))
				summary["validationReportComplete"] = len(included) == count
			}
		}
	}
	payload["result"] = summary
}

// Select capabilities from the persisted work type, never from checkpoint
// presence or the tool registry supplied by a restored runtime session.
func productionRuntimeTools(manifest productionManifest, work map[string]any) []map[string]any {
	if manifest.Plan == nil && manifest.Storyboard != nil {
		return storyboardTools()
	}
	allowed := map[string]bool{
		"production_status": true, "production_read": true, "production_query": true,
		"production_submit": true, "production_check": true,
	}
	if manifest.Plan != nil {
		allowed["production_plan_inventory"] = true
	} else {
		allowed["production_facts"] = true
	}
	var tools []map[string]any
	for _, tool := range productionAgentTools() {
		function, _ := tool["function"].(map[string]any)
		if function["name"] == "production_plan_inventory" && manifest.Plan != nil {
			tool = productionPlanTools(manifest.Plan.Version)[0]
		}
		if function["name"] == "production_facts" && manifest.Category == "reconcile" {
			parameters := function["parameters"].(map[string]any)["properties"].(map[string]any)
			fields := parameters["facts"].(map[string]any)["items"].(map[string]any)["properties"].(map[string]any)
			fields["kind"].(map[string]any)["enum"] = []string{"character", "environment", "prop", "setting", "style", "sound"}
		}
		if allowed[stringValue(function["name"])] {
			tools = append(tools, tool)
		}
	}
	if manifest.Plan != nil && manifest.Plan.Version >= 2 {
		tools = productionPlanScopedTools(tools, work, manifest.Plan.Version)
		pages := []string{}
		for _, source := range manifest.Sources {
			pages = append(pages, source.Pages...)
		}
		for _, tool := range tools {
			function := tool["function"].(map[string]any)
			if function["name"] == "production_read" && len(pages) > 0 {
				properties := function["parameters"].(map[string]any)["properties"].(map[string]any)
				properties["pageId"] = map[string]any{"type": "string", "enum": pages, "description": "只读取本任务来源页 ID；已保存文稿用 production_query 的 assetKey 读取，不能把文稿 key 当作 pageId。"}
			}
		}
	}
	return tools
}

func productionRuntimeUnknownCall(tools []map[string]any, calls []cloudAgentCall) bool {
	allowed := make(map[string]bool, len(tools))
	for _, tool := range tools {
		function, _ := tool["function"].(map[string]any)
		allowed[stringValue(function["name"])] = true
	}
	for _, call := range calls {
		if call.Function.Name == "" || !allowed[call.Function.Name] {
			return true
		}
	}
	return false
}

// A stale session may already contain a rejected tool result. Catch its latest
// call group before paying for an explanation. A new user turn starts a resume.
func productionRuntimeLatestCalls(messages []map[string]any) []cloudAgentCall {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i]["role"] == "user" {
			break
		}
		if messages[i]["role"] == "assistant" {
			encoded, _ := json.Marshal(messages[i]["tool_calls"])
			var calls []cloudAgentCall
			_ = json.Unmarshal(encoded, &calls)
			return calls
		}
	}
	return nil
}

var errProductionRuntimeUnknownTool = errors.New("制作工具与当前任务不匹配")
var errProductionRuntimePlanBlocked = errors.New("制作方案当前检查点的前置条件未满足")
var errProductionRuntimeNoProgress = errors.New("当前制作步骤尚未产生可验证进度")

const productionRuntimeContinuationRepairKey = "production_runtime_continuation"

// Local orchestration and validation faults stay inside the production loop.
// Callers use this signal to schedule the same durable checkpoint again without
// converting a successful provider response into a failed or user-blocked run.
type productionRuntimeContinueError struct {
	Reason string
	Cause  error
	Quiet  bool
}

func (e *productionRuntimeContinueError) Error() string {
	if e == nil || e.Cause == nil {
		return "production runtime continuation"
	}
	return e.Cause.Error()
}

func (e *productionRuntimeContinueError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func productionBlockRuntime(run *model.CloudAgentExecution, state *cloudAgentRuntime) {
	run.Status, run.FailureMessage = "running", ""
	state.ActiveTaskID, state.ActiveTextDraft, state.LastError = "", "", ""
}

func productionRuntimeQuietHold(state *cloudAgentRuntime) bool {
	for toolName, repair := range state.ToolRepairs {
		if strings.HasPrefix(toolName, "production_") && repair.ProductionProgressStep == state.ProductionProgressStep && repair.Attempt >= 2 {
			return true
		}
	}
	return false
}

func productionRuntimeNoProgressError(state *cloudAgentRuntime) error {
	for i := len(state.Events) - 1; i >= 0; i-- {
		event := state.Events[i]
		if !strings.HasPrefix(stringValue(event.Payload["toolName"]), "production_") {
			continue
		}
		message := truncateRunes(stringValue(event.Payload["text"]), 500)
		switch event.Type {
		case "production_validation":
			return fmt.Errorf("%w；当前提交的本地校验问题：%s", errProductionRuntimeNoProgress, message)
		case "tool_failed":
			return fmt.Errorf("%w；当前工具执行失败：%s", errProductionRuntimeNoProgress, message)
		}
	}
	return errProductionRuntimeNoProgress
}

// Bump when the durable context contract changes. Old provider receipts and
// loop evidence must not bypass a newly repaired context after deployment.
const productionRuntimeContextRevision = 18

// The checkpoint already supplies phase/status and the exact source range.
// Scope provider tools without narrowing the durable execution whitelist: a
// restored response can still settle its previously authorized context read.
func productionConstrainStoryboard(work map[string]any, canonical *canonicalAgentRequest) {
	next := stringValue(work["nextTool"])
	phase := stringValue(work["phase"])
	if !strings.HasPrefix(next, "production_storyboard_") || phase == "" {
		return
	}
	var tools []map[string]any
	for _, tool := range canonical.Tools {
		fn, _ := tool["function"].(map[string]any)
		name := stringValue(fn["name"])
		if name == next || (name == "production_storyboard_plan" && phase == "layout" && work["canRebudget"] == true) || (name == "production_storyboard_read" && (phase == "scene" || phase == "review")) || (name == "production_storyboard_reset" && phase == "scene") {
			tools = append(tools, tool)
		}
	}
	if len(tools) > 0 {
		canonical.Tools, canonical.ToolChoice = tools, "auto"
	}
}

// Include durable inputs and receipts so an identical runtime transcript cannot
// replay a response from before a read, fact extraction, or saved artifact.
func productionRuntimeCheckpoint(repo *repository.Repository, run *model.CloudAgentExecution, manifest productionManifest) (string, error) {
	artifacts, err := repo.ProductionAgentArtifacts(run.UserID, run.ID)
	if err != nil {
		return "", err
	}
	facts, done, total, err := productionFacts(repo, run.UserID, manifest)
	if err != nil {
		return "", err
	}
	return productionHash([]any{productionRuntimeContextRevision, manifest, artifacts, facts, done, total}), nil
}

func productionRuntimeModelKey(messages []map[string]any, thinking string, correction []map[string]any, checkpoint string) string {
	return productionHash([]any{messages, thinking, correction, checkpoint})
}

// Model success does not imply that its proposed tool calls were accepted.
// Keep the billed result for audit, but never replay a rejected proposal.
func productionRuntimeReusableReceipt(repo *repository.Repository, userID string, state *cloudAgentRuntime, taskID string) (bool, error) {
	task, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return false, err
	}
	var result struct {
		ToolCalls []cloudAgentCall `json:"toolCalls"`
	}
	if err := json.Unmarshal([]byte(task.ResultJSON), &result); err != nil {
		return false, err
	}
	_, failed, _, err := productionRuntimeReadOutcomes(repo, userID, state, task.CreatedAt)
	if err != nil {
		return false, err
	}
	for _, call := range result.ToolCalls {
		if _, rejected := failed[call.ID]; rejected {
			return false, nil
		}
	}
	return true, nil
}

type productionRuntimeRecovery struct {
	Reads                      map[string]bool             `json:"reads"`
	RepairAttempts             int                         `json:"repairAttempts,omitempty"`
	ValidationProblems         []string                    `json:"validationProblems,omitempty"`
	ValidationIssues           []cloudAgentValidationIssue `json:"validationIssues,omitempty"`
	ValidationCallID           string                      `json:"validationCallId,omitempty"`
	ValidationMessage          string                      `json:"validationMessage,omitempty"`
	ValidationProblemSignature string                      `json:"validationProblemSignature,omitempty"`
	ValidationTool             string                      `json:"validationTool,omitempty"`
}

type productionRuntimeRepairReceipt struct {
	Repairable                 bool
	Problems                   []string
	ValidationIssues           []cloudAgentValidationIssue
	ValidationMessage          string
	ValidationProblemSignature string
	ToolName                   string
	Attempt                    int
}

func productionRuntimePendingRepair(state *cloudAgentRuntime, preferredTool string) *productionRuntimeRecovery {
	var selected cloudAgentToolRepair
	selectedTool := ""
	for toolName, repair := range state.ToolRepairs {
		if toolName == productionRuntimeContinuationRepairKey || !strings.HasPrefix(toolName, "production_") || repair.ProductionProgressStep != state.ProductionProgressStep || repair.Attempt == 0 {
			continue
		}
		prefer := toolName == preferredTool && selectedTool != preferredTool
		better := selectedTool == "" || prefer || (selectedTool != preferredTool && (repair.Attempt > selected.Attempt || repair.Attempt == selected.Attempt && toolName < selectedTool))
		if better {
			selected, selectedTool = repair, toolName
		}
	}
	if selectedTool == "" {
		return nil
	}
	issues := append([]cloudAgentValidationIssue(nil), selected.ValidationIssues...)
	return &productionRuntimeRecovery{
		Reads:                      map[string]bool{},
		RepairAttempts:             selected.Attempt,
		ValidationProblems:         productionValidationProblems(issues, selected.ValidationMessage),
		ValidationIssues:           issues,
		ValidationCallID:           selected.CallID,
		ValidationMessage:          selected.ValidationMessage,
		ValidationProblemSignature: selected.ValidationProblemSignature,
		ValidationTool:             selectedTool,
	}
}

type productionRuntimeStepInput struct {
	Checkpoint   string                     `json:"productionCheckpoint"`
	Recovery     *productionRuntimeRecovery `json:"productionRecovery,omitempty"`
	RequiredTool string                     `json:"productionRequiredTool,omitempty"`
}

// The checkpoint contains the prerequisites for the next plan operation. Narrow
// only the provider request; restored, authorized tool receipts can still settle.
// RequiredTool is enforced by orchestration, not the optional wire-level choice:
// reasoning models can support tools while rejecting forced tool selection.
func productionConstrainPlan(work map[string]any, canonical *canonicalAgentRequest) string {
	next, _ := work["nextAction"].(map[string]any)
	name := stringValue(next["tool"])
	if stringValue(next["phase"]) == "" || stringValue(next["blockedReason"]) != "" || !cloudAgentContainsString([]string{"production_read", "production_submit", "production_plan_inventory", "production_check"}, name) {
		return ""
	}
	for _, tool := range canonical.Tools {
		fn, _ := tool["function"].(map[string]any)
		if fn["name"] == name {
			canonical.Tools = []map[string]any{tool}
			canonical.ToolChoice = "auto"
			if next["key"] != "generation" {
				return name
			}
			canonical.Messages = append(canonical.Messages, map[string]any{"role": "user", "content": "故事总纲、资产清单、美术与导演规范已完成。直接依据当前公共规范与已登记资产索引编写并提交 generation 的完整 document；先定义跨资产通用执行、引用、状态衔接、验收和返修规则，具体资产参数由后续档案落实。规范齐备后检查并结束方案，资产仅在用户手动启动后制作。不得声称资产档案或媒体已经完成，不等待或读取尚不存在的档案，不输出启动说明代替文稿。"})
			return "production_submit"
		}
	}
	return ""
}

// Compare effective read arguments, not call IDs, JSON formatting or prose.
// Offsets, query kinds, asset keys and source ranges remain distinct work.
func productionRuntimeReadSignature(call cloudAgentCall) string {
	var args map[string]any
	if json.Unmarshal([]byte(call.Function.Arguments), &args) != nil {
		return ""
	}
	var fields []string
	switch call.Function.Name {
	case "production_status":
		fields = []string{"offset"}
	case "production_query":
		fields = []string{"kind", "offset", "assetKey"}
	case "production_read":
		fields = []string{"pageId"}
	case "production_storyboard_read":
		fields = []string{"sourceId", "sceneId", "start", "end"}
	case "production_check", "production_storyboard_context":
	default:
		return ""
	}
	normalized := map[string]any{}
	for _, field := range fields {
		value := args[field]
		if value != nil && value != "" && value != float64(0) {
			normalized[field] = value
		}
	}
	return productionHash([]any{call.Function.Name, normalized})
}

// This bounds inspection cost, never the number of calls or distinct reads a
// production job may make. Only the suffix at the current checkpoint counts.
func productionRuntimeReadCycle(repo *repository.Repository, userID string, state *cloudAgentRuntime, checkpoint string) (*productionRuntimeRecovery, error) {
	type observation struct {
		task  *model.Task
		calls []cloudAgentCall
	}
	var history []observation
	seenTasks := map[string]bool{}
	for i := len(state.TaskIDs) - 1; i >= 0 && len(history) < 32; i-- {
		id := state.TaskIDs[i]
		if seenTasks[id] {
			continue
		}
		seenTasks[id] = true
		task, err := repo.TaskForUser(userID, id)
		if err != nil {
			return nil, err
		}
		if task.Operation != cloudAgentStepOperation {
			continue
		}
		var input productionRuntimeStepInput
		var result struct {
			ToolCalls []cloudAgentCall `json:"toolCalls"`
		}
		if task.Status != model.TaskStatusSucceeded || json.Unmarshal([]byte(task.InputJSON), &input) != nil ||
			input.Checkpoint != checkpoint || json.Unmarshal([]byte(task.ResultJSON), &result) != nil {
			break
		}
		history = append(history, observation{task, result.ToolCalls})
	}
	if len(history) < 4 {
		return nil, nil
	}
	// Only successful, novel reads are discovery progress. A failed or missing
	// receipt at the same durable checkpoint must not reset the idle sequence.
	outcomes, repairs, resumed, err := productionRuntimeReadOutcomes(repo, userID, state, history[len(history)-1].task.CreatedAt)
	if err != nil {
		return nil, err
	}
	reads := map[string]bool{}
	successfulReads := map[string]bool{}
	repeated := 0
	repairAttempts := 0
	var previousProblems []string
	problemCounts := map[string]int{}
	var problemHistory []string
	for i := len(history) - 1; i >= 0; i-- {
		item := history[i]
		if !resumed.IsZero() && !item.task.CreatedAt.After(resumed) {
			continue
		}
		signatures := []string{}
		novel := false
		repairable := len(item.calls) > 0
		var problems []string
		for _, call := range item.calls {
			signature := productionRuntimeReadSignature(call)
			repair := repairs[call.ID]
			repairable = repairable && signature == "" && repair.Repairable
			for _, problem := range repair.Problems {
				problems = append(problems, productionHash([]string{call.Function.Name, problem}))
			}
			if signature == "" {
				continue
			}
			signatures = append(signatures, signature)
			if outcomes[call.ID] == signature {
				if !successfulReads[signature] {
					novel = true
				}
				successfulReads[signature] = true
			}
		}
		if len(item.calls) == 0 {
			// Paraphrasing an introduction is still the same non-action.
			signatures = []string{"prose"}
		}
		for _, signature := range signatures {
			if signature == "prose" && !reads[signature] {
				novel = true
			}
			reads[signature] = true
		}
		var input productionRuntimeStepInput
		_ = json.Unmarshal([]byte(item.task.InputJSON), &input)
		if repairable {
			// The current checkpoint fixes the work identity. Editing an unrelated
			// argument or alternating two unresolved issue sets is not progress.
			problemCounts, repairAttempts = productionTrackValidationProblems(problems, problemCounts, &problemHistory)
			previousProblems = problems
		}
		if input.Recovery != nil && !novel {
			// Executed, pre-write argument errors deserve bounded correction.
			// Missing receipts, unchanged writes and repeated reads do not.
			if !repairable || repairAttempts >= cloudAgentToolAttemptLimit-1 || (len(input.Recovery.ValidationProblems) == 0 && input.Recovery.RepairAttempts >= cloudAgentToolAttemptLimit) {
				return nil, errProductionRuntimeNoProgress
			}
		}
		if novel {
			repeated = 0
		} else {
			repeated++
		}
	}
	if repeated < 3 {
		return nil, nil
	}
	return &productionRuntimeRecovery{Reads: reads, RepairAttempts: repairAttempts, ValidationProblems: previousProblems}, nil
}

func productionRuntimeReadOutcomes(repo *repository.Repository, userID string, state *cloudAgentRuntime, since time.Time) (map[string]string, map[string]productionRuntimeRepairReceipt, time.Time, error) {
	outcomes := map[string]string{}
	repairs := map[string]productionRuntimeRepairReceipt{}
	for toolName, repair := range state.ToolRepairs {
		if !strings.HasPrefix(toolName, "production_") || repair.CallID == "" || repair.ProductionProgressStep != state.ProductionProgressStep {
			continue
		}
		issues := append([]cloudAgentValidationIssue(nil), repair.ValidationIssues...)
		repairs[repair.CallID] = productionRuntimeRepairReceipt{
			Repairable:                 true,
			Problems:                   productionValidationProblems(issues, repair.ValidationMessage),
			ValidationIssues:           issues,
			ValidationMessage:          repair.ValidationMessage,
			ValidationProblemSignature: repair.ValidationProblemSignature,
			ToolName:                   toolName,
			Attempt:                    repair.Attempt,
		}
	}
	seen := map[string]bool{}
	events := state.Events
	for {
		for i := len(events) - 1; i >= 0; i-- {
			event := events[i]
			if event.CreatedAt.Before(since) {
				return outcomes, repairs, time.Time{}, nil
			}
			if event.Type == "production_control" && event.Payload["action"] == "resume" {
				return outcomes, repairs, event.CreatedAt, nil
			}
			if event.Type != "tool_completed" && event.Type != "tool_failed" && event.Type != "production_validation" {
				continue
			}
			id := stringValue(event.Payload["callId"])
			if seen[id] {
				continue
			}
			seen[id] = true
			if event.Type == "tool_completed" {
				call := cloudAgentCall{ID: id}
				call.Function.Name = stringValue(event.Payload["toolName"])
				call.Function.Arguments = stringValue(event.Payload["arguments"])
				outcomes[id] = productionRuntimeReadSignature(call)
			} else {
				result, _ := event.Payload["result"].(map[string]any)
				retry, _ := result["retry"].(map[string]any)
				var issues []cloudAgentValidationIssue
				if raw, err := json.Marshal(result["validationIssues"]); err == nil {
					_ = json.Unmarshal(raw, &issues)
				}
				if len(issues) == 0 && stringValue(result["field"]) != "" {
					issues = []cloudAgentValidationIssue{{Field: stringValue(result["field"]), Issue: stringValue(result["issue"])}}
				}
				repairs[id] = productionRuntimeRepairReceipt{
					Repairable:                 result["reason"] == "invalid_tool_arguments" && result["requiredAction"] == "fix_arguments" && result["retryable"] == true && retry["terminal"] != true && result["taskSubmitted"] != true && result["phase"] != "completion",
					Problems:                   productionValidationProblems(issues, stringValue(result["error"])),
					ValidationIssues:           issues,
					ValidationMessage:          stringValue(result["error"]),
					ValidationProblemSignature: stringValue(result["validationProblemSignature"]),
					ToolName:                   stringValue(event.Payload["toolName"]),
				}
				if signature := stringValue(result["validationProblemSignature"]); signature != "" {
					repair := repairs[id]
					repair.Problems = []string{signature}
					repairs[id] = repair
				}
			}
		}
		if len(events) == 0 || events[0].Seq <= 1 {
			return outcomes, repairs, time.Time{}, nil
		}
		records, err := repo.CloudAgentEventRecordsBefore(userID, state.RuntimeRunID, events[0].Seq, 128)
		if err != nil {
			return nil, nil, time.Time{}, err
		}
		events = nil
		for _, record := range records {
			var event CloudAgentEvent
			if err := json.Unmarshal([]byte(record.EventJSON), &event); err != nil {
				return nil, nil, time.Time{}, err
			}
			events = append(events, event)
		}
	}
}

func (s *Service) correctProductionRuntimeCycle(userID, runID string, state *cloudAgentRuntime, checkpoint string, work map[string]any, canonical *canonicalAgentRequest) (*productionRuntimeRecovery, error) {
	next, _ := work["nextAction"].(map[string]any)
	if next == nil && stringValue(work["nextTool"]) != "" {
		next = map[string]any{"tool": work["nextTool"]}
	}
	if next == nil {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return nil, err
		}
		_, manifest, _, err := productionLoad(s.repo, run, state)
		if err != nil {
			return nil, err
		}
		next, err = productionNextAction(s.repo, userID, manifest, runID)
		if err != nil {
			return nil, err
		}
	}
	name := stringValue(next["tool"])
	recovery := productionRuntimePendingRepair(state, name)
	if recovery == nil {
		var err error
		recovery, err = productionRuntimeReadCycle(s.repo, userID, state, checkpoint)
		if err != nil || recovery == nil {
			return recovery, err
		}
	}
	args, _ := json.Marshal(next["arguments"])
	probe := cloudAgentCall{}
	probe.Function.Name, probe.Function.Arguments = name, string(args)
	// Prefer nextAction. If it only points back to an already consumed read,
	// expose productive tools so the model can author the missing facts/body.
	productive := recovery.Reads[productionRuntimeReadSignature(probe)]
	var tools []map[string]any
	for _, tool := range canonical.Tools {
		fn, _ := tool["function"].(map[string]any)
		toolName := stringValue(fn["name"])
		if recovery.ValidationTool != "" {
			if toolName == recovery.ValidationTool {
				tools = append(tools, tool)
			}
			continue
		}
		candidate := cloudAgentCall{}
		candidate.Function.Name, candidate.Function.Arguments = toolName, "{}"
		if (!productive && toolName == name) || (productive && productionRuntimeReadSignature(candidate) == "" && toolName != "production_storyboard_reset") {
			tools = append(tools, tool)
		}
	}
	if len(tools) > 0 {
		canonical.Tools, canonical.ToolChoice = tools, "auto"
	}
	body, _ := json.Marshal(map[string]any{
		"reason":                     "production_current_step_validation",
		"nextAction":                 next,
		"validationCallId":           recovery.ValidationCallID,
		"validationAttempt":          recovery.RepairAttempts,
		"validationIssues":           recovery.ValidationIssues,
		"validationMessage":          recovery.ValidationMessage,
		"validationProblemSignature": recovery.ValidationProblemSignature,
		"validationTool":             recovery.ValidationTool,
		"instruction":                "以上是当前制作步骤一次校验得到的完整问题集合。请在本次调用中同时满足全部问题与当前 schema，并重新提交当前步骤所需的完整结果；提交前自行检查字段、来源证据和内容完整性。不得把任一问题留给后续制作步骤，不得用读取、状态说明或开场文字代替当前结果。",
	})
	canonical.Messages = append(append([]map[string]any(nil), canonical.Messages...), map[string]any{"role": "user", "content": string(body)})
	return recovery, nil
}

// A corrective response may perform a genuinely new read or author a mutation.
// Returning to the same read-only cycle (or paraphrased prose) is terminal at
// this checkpoint; receipt replays do not create additional observations.
func productionRuntimeIgnoredRecovery(task *model.Task, checkpoint string, calls []cloudAgentCall) bool {
	var input productionRuntimeStepInput
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || input.Checkpoint != checkpoint || input.Recovery == nil {
		return false
	}
	for _, call := range calls {
		signature := productionRuntimeReadSignature(call)
		if signature == "" || !input.Recovery.Reads[signature] {
			return false
		}
	}
	return true
}

func (s *Service) productionRuntimeRecoveryFailed(userID, runID string, task *model.Task, calls []cloudAgentCall) (bool, error) {
	var input productionRuntimeStepInput
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || input.Recovery == nil {
		return false, nil
	}
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return false, err
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		return false, err
	}
	_, manifest, _, err := productionLoad(s.repo, run, &state)
	if err != nil {
		return false, err
	}
	checkpoint, err := productionRuntimeCheckpoint(s.repo, run, manifest)
	if err != nil {
		return false, err
	}
	return productionRuntimeIgnoredRecovery(task, checkpoint, calls), nil
}

// Reject an invalid batch before any tool executes. A successful billed model
// task stays successful; only its unusable replay receipt is removed on block.
func (s *Service) blockProductionRuntimeTool(userID, runID, taskID string) error {
	return s.blockProductionRuntime(userID, runID, taskID, "unknown_production_tool", errProductionRuntimeUnknownTool)
}

func (s *Service) blockProductionRuntime(userID, runID, taskID, reason string, cause error) error {
	return s.setProductionRuntimeContinuation(userID, runID, taskID, reason, cause, false)
}

func (s *Service) quietProductionRuntime(userID, runID, taskID, reason string, cause error) error {
	return s.setProductionRuntimeContinuation(userID, runID, taskID, reason, cause, true)
}

func (s *Service) setProductionRuntimeContinuation(userID, runID, taskID, reason string, cause error, forceQuiet bool) error {
	for attempt := 0; attempt < 8; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		quiet := forceQuiet
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
			if cloudAgentRunTerminal(current.Status) {
				return nil
			}
			state, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			if state.Request.Production != nil {
				if job, err := s.repo.ProductionAgentJob(userID, runID); err == nil {
					var manifest productionManifest
					if json.Unmarshal([]byte(job.ManifestJSON), &manifest) == nil && manifest.Plan != nil && manifest.Plan.Version >= 5 {
						forceQuiet = true
						quiet = true
					}
				}
			}
			for key, receipt := range state.ProductionModelReceipts {
				if taskID != "" && receipt == taskID {
					delete(state.ProductionModelReceipts, key)
				}
			}
			if state.ToolRepairs == nil {
				state.ToolRepairs = map[string]cloudAgentToolRepair{}
			}
			repair := state.ToolRepairs[productionRuntimeContinuationRepairKey]
			if repair.ProductionProgressStep != state.ProductionProgressStep {
				repair = cloudAgentToolRepair{ProductionProgressStep: state.ProductionProgressStep}
			}
			if repair.Attempt < 2 {
				repair.Attempt++
			}
			if forceQuiet && repair.Attempt < 2 {
				repair.Attempt = 2
			}
			repair.ValidationMessage = cloudAgentSafeToolError(cause)
			repair.ValidationProblemSignature = productionHash([]any{reason, repair.ValidationMessage})
			state.ToolRepairs[productionRuntimeContinuationRepairKey] = repair
			state.ProductionRepairs = repair.Attempt
			quiet = quiet || repair.Attempt >= 2
			productionBlockRuntime(current, &state)
			return cloudAgentSave(current, &state)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		if err != nil {
			return err
		}
		s.projectProductionAgentStatus(userID, runID)
		return &productionRuntimeContinueError{Reason: reason, Cause: cause, Quiet: quiet}
	}
	return repository.ErrCreationConflict
}
