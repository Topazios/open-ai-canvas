package app

import (
	"encoding/json"
	"errors"
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
		tools = productionPlanScopedTools(tools, work)
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

var errProductionRuntimeUnknownTool = errors.New("制作工具与当前任务不匹配，已停止调用并保存进度；可继续任务重试")
var errProductionRuntimePlanBlocked = errors.New("制作方案当前检查点无法继续，已停止调用并保留现场；请检查文稿及前置依赖，修复后继续或创建新的方案版本")
var errProductionRuntimeNoProgress = errors.New("模型重复读取或说明且制作进度未变化，纠偏后仍未推进，已停止调用并保存进度；可继续任务重试")

// Bump when the durable context contract changes. Old provider receipts and
// loop evidence must not bypass a newly repaired context after deployment.
const productionRuntimeContextRevision = 7

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
		canonical.Tools, canonical.ToolChoice = tools, "required"
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

type productionRuntimeRecovery struct {
	Reads map[string]bool `json:"reads"`
}

type productionRuntimeStepInput struct {
	Checkpoint   string                     `json:"productionCheckpoint"`
	Recovery     *productionRuntimeRecovery `json:"productionRecovery,omitempty"`
	RequiredTool string                     `json:"productionRequiredTool,omitempty"`
}

// The final plan is a writing step, not another discovery loop. Its checkpoint
// already carries the common standards and registered asset index.
func productionConstrainFinalPlan(work map[string]any, canonical *canonicalAgentRequest) string {
	next, _ := work["nextAction"].(map[string]any)
	if next["key"] != "generation" || next["tool"] != "production_submit" {
		return ""
	}
	for _, tool := range canonical.Tools {
		fn, _ := tool["function"].(map[string]any)
		if fn["name"] == "production_submit" {
			canonical.Tools = []map[string]any{tool}
			canonical.ToolChoice = "required"
			canonical.Messages = append(canonical.Messages, map[string]any{"role": "user", "content": "前置方案及资产均已完成。直接依据当前公共规范与资产索引编写并提交 generation 的完整 document；定义跨资产通用执行、引用、状态衔接、验收和返修规则，具体资产参数以其已保存档案为权威引用，不重新逐项读取或复制全部档案，不输出启动说明代替文稿。"})
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
	// Journal receipts prove execution succeeded. Missing/failed executions do
	// not become read-loop evidence merely because the model task succeeded.
	outcomes, resumed, err := productionRuntimeReadOutcomes(repo, userID, state, history[len(history)-1].task.CreatedAt)
	if err != nil {
		return nil, err
	}
	reads := map[string]bool{}
	repeated := 0
	for i := len(history) - 1; i >= 0; i-- {
		item := history[i]
		if !resumed.IsZero() && !item.task.CreatedAt.After(resumed) {
			continue
		}
		signatures := []string{}
		valid := true
		for _, call := range item.calls {
			signature := productionRuntimeReadSignature(call)
			if signature == "" || outcomes[call.ID] != signature {
				valid = false
				break
			}
			signatures = append(signatures, signature)
		}
		if !valid {
			reads, repeated = map[string]bool{}, 0
			continue
		}
		if len(item.calls) == 0 {
			// Paraphrasing an introduction is still the same non-action.
			signatures = []string{"prose"}
		}
		novel := false
		for _, signature := range signatures {
			if !reads[signature] {
				novel = true
			}
			reads[signature] = true
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
	return &productionRuntimeRecovery{Reads: reads}, nil
}

func productionRuntimeReadOutcomes(repo *repository.Repository, userID string, state *cloudAgentRuntime, since time.Time) (map[string]string, time.Time, error) {
	outcomes := map[string]string{}
	seen := map[string]bool{}
	events := state.Events
	for {
		for i := len(events) - 1; i >= 0; i-- {
			event := events[i]
			if event.CreatedAt.Before(since) {
				return outcomes, time.Time{}, nil
			}
			if event.Type == "production_control" && event.Payload["action"] == "resume" {
				return outcomes, event.CreatedAt, nil
			}
			if event.Type != "tool_completed" && event.Type != "tool_failed" {
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
			}
		}
		if len(events) == 0 || events[0].Seq <= 1 {
			return outcomes, time.Time{}, nil
		}
		records, err := repo.CloudAgentEventRecordsBefore(userID, state.RuntimeRunID, events[0].Seq, 128)
		if err != nil {
			return nil, time.Time{}, err
		}
		events = nil
		for _, record := range records {
			var event CloudAgentEvent
			if err := json.Unmarshal([]byte(record.EventJSON), &event); err != nil {
				return nil, time.Time{}, err
			}
			events = append(events, event)
		}
	}
}

func (s *Service) correctProductionRuntimeCycle(userID, runID string, state *cloudAgentRuntime, checkpoint string, work map[string]any, canonical *canonicalAgentRequest) (*productionRuntimeRecovery, error) {
	recovery, err := productionRuntimeReadCycle(s.repo, userID, state, checkpoint)
	if err != nil || recovery == nil {
		return recovery, err
	}
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
		candidate := cloudAgentCall{}
		candidate.Function.Name, candidate.Function.Arguments = toolName, "{}"
		if (!productive && toolName == name) || (productive && productionRuntimeReadSignature(candidate) == "" && toolName != "production_storyboard_reset") {
			tools = append(tools, tool)
		}
	}
	if len(tools) == 0 {
		return nil, errProductionRuntimeNoProgress
	}
	canonical.Tools, canonical.ToolChoice = tools, "required"
	body, _ := json.Marshal(map[string]any{
		"reason": "production_read_cycle", "nextAction": next,
		"instruction": "相同持久状态下已反复成功读取或返回说明。使用当前检查点中的来源正文、已有结果及完整 nextAction 执行下一项工作，按 documentSchema 编写完整正文后提交；不得再以相同读取、状态检查或开场说明代替工作。若 nextAction 指向已读正文，保存事实或当前缺失文稿，不编造工具参数或空文稿。",
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
// task stays successful; only its unusable replay receipt is removed on failure.
func (s *Service) failProductionRuntimeTool(userID, runID, taskID string) error {
	return s.failProductionRuntime(userID, runID, taskID, "unknown_production_tool", errProductionRuntimeUnknownTool)
}

func (s *Service) failProductionRuntime(userID, runID, taskID, reason string, cause error) error {
	for attempt := 0; attempt < 8; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
			if cloudAgentRunTerminal(current.Status) {
				return nil
			}
			state, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			for key, receipt := range state.ProductionModelReceipts {
				if taskID != "" && receipt == taskID {
					delete(state.ProductionModelReceipts, key)
				}
			}
			current.Status = "failed"
			current.FailureMessage = cause.Error()
			state.LastError = current.FailureMessage
			state.event(runID, "run_failed", map[string]any{"reason": reason, "error": current.FailureMessage})
			return cloudAgentSave(current, &state)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		if err != nil {
			return err
		}
		s.projectProductionAgentStatus(userID, runID)
		return cause
	}
	return repository.ErrCreationConflict
}
