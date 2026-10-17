package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/productionrules"
	"infinite-canvas/backend/internal/repository"
)

const workflowBatchOperation = "short_drama_batch"
const workflowBatchContextLimit = 24000

type workflowTextUnit struct {
	Label string `json:"label"`
	Text  string `json:"text"`
}
type workflowTextBatch struct {
	Version      int                `json:"version"`
	Units        []workflowTextUnit `json:"units"`
	Context      []workflowTextUnit `json:"context,omitempty"`
	Scope        string             `json:"scope,omitempty"`
	Category     string             `json:"category,omitempty"`
	EpisodeCount int                `json:"episodeCount,omitempty"`
}

func validateWorkflowTextBatch(taskType, prompt string, input map[string]any) (*workflowTextBatch, error) {
	raw, exists := input["workflowBatch"]
	if !exists {
		return nil, nil
	}
	encoded, err := json.Marshal(raw)
	var batch workflowTextBatch
	if err != nil || json.Unmarshal(encoded, &batch) != nil || batch.Version < 1 || batch.Version > 4 || (len(batch.Units) == 0 && batch.Version != 4) || len(batch.Units) > 512 || len(batch.Context) > 512 {
		return nil, BadAuthRequest("无效的分批执行计划")
	}
	if batch.Version == 4 {
		metadata, _ := input["metadata"].(map[string]any)
		if metadata["workflowStep"] != "story.body" || len(batch.Context) == 0 || batch.Scope != "" || batch.Category != "" {
			return nil, BadAuthRequest("正文执行计划必须包含本集集纲，且只用于正文步骤")
		}
	}
	if batch.Version == 3 {
		metadata, _ := input["metadata"].(map[string]any)
		if batch.EpisodeCount < 1 || batch.EpisodeCount > 200 || metadata["workflowStep"] != "story.episodes" {
			return nil, BadAuthRequest("集纲执行计划缺少有效集数或步骤类型")
		}
	} else if batch.EpisodeCount != 0 {
		return nil, BadAuthRequest("集数分段需要版本 3 集纲合同")
	}
	if batch.Version == 2 {
		validCategory := batch.Category == "bible" || batch.Category == "characters" || batch.Category == "environments" || batch.Category == "props" || batch.Category == "special"
		if strings.TrimSpace(batch.Scope) == "" || len(batch.Scope) > 200 || !validCategory {
			return nil, BadAuthRequest("无效的共享正文解析范围或类别")
		}
	} else if batch.Version != 4 && (len(batch.Context) > 0 || batch.Scope != "" || batch.Category != "") {
		return nil, BadAuthRequest("共享正文解析需要版本 2 合同")
	}
	if taskType != "canvas_text" || input["mode"] != "text" || input["agentRequests"] != nil || isTextReplayTaskRequest(input) || taskInputUsesWorkflowProvider(input) {
		return nil, BadAuthRequest("分批执行仅支持普通文本模型任务")
	}
	if utf8.RuneCountInString(prompt) > 16000 {
		return nil, BadAuthRequest("分批任务的生成要求超过限制")
	}
	total := 0
	for _, unit := range append(append([]workflowTextUnit{}, batch.Units...), batch.Context...) {
		size := utf8.RuneCountInString(unit.Text)
		if strings.TrimSpace(unit.Label) == "" || utf8.RuneCountInString(unit.Label) > 240 || strings.TrimSpace(unit.Text) == "" || size > workflowBatchContextLimit {
			return nil, BadAuthRequest("分批单元为空或超过长度限制")
		}
		total += size
	}
	if total > 4_000_000 {
		return nil, BadAuthRequest("本次材料超过分批任务容量，请按制作单元分别提交")
	}
	return &batch, nil
}

func (s *Service) createWorkflowBatchChildWithinStorageQuota(parent, child *model.Task, order *model.BillingOrder, policy RuntimePolicySetting) error {
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	usage, err := s.repo.UserStorageUsage(child.UserID)
	if err != nil {
		return err
	}
	if err := validateTaskStorageQuotaWithPolicy(usage, int64(len(child.Prompt)+len(child.InputJSON)), policy.Resource); err != nil {
		return err
	}
	if err := s.repo.CreateWorkflowBatchChild(parent, child, order, policy.Task.ActiveTaskLimit); err != nil {
		return err
	}
	s.wakeTaskDispatcher()
	return nil
}

// A parent never waits in a worker for its child. Each visit reconstructs the
// reduction from immutable inputs and completed child tasks, then yields its lease.
func (s *Service) processWorkflowTextBatch(parent *model.Task) error {
	raw, err := s.decryptTaskInputJSON(parent.InputJSON)
	if err != nil {
		return s.failWorkflowTextBatch(parent, "读取分批任务失败")
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		return s.failWorkflowTextBatch(parent, "分批任务输入无效")
	}
	batch, err := validateWorkflowTextBatch(parent.Type, parent.Prompt, input)
	if err != nil || batch == nil {
		return s.failWorkflowTextBatch(parent, "分批任务计划无效")
	}
	if batch.Version == 3 {
		return s.processWorkflowOutline(parent, input, batch)
	}
	if batch.Version == 4 {
		return s.processWorkflowBody(parent, input, batch)
	}
	if metadata, _ := input["metadata"].(map[string]any); metadata["workflowStep"] == "story.body" {
		return s.failWorkflowTextBatch(parent, "此正文任务使用旧版全量材料提取流程，已停止继续扩写材料。请从正文节点重试，系统将按本集集纲与引用资产重新提交；已有结果和账单保留。")
	}
	if metadata, _ := input["metadata"].(map[string]any); metadata["workflowStep"] == "story.episodes" {
		return s.failWorkflowTextBatch(parent, legacyOutlineBatchMessage)
	}
	work := make([]workflowBatchWork, 0, len(batch.Units))
	for index, unit := range batch.Units {
		prompt := parent.Prompt + "\n\n当前是分集/单元提取中间阶段，仅处理以下材料。记录与目标有关的情节、因果、时间顺序、关键对白，以及全部人物、场景、道具、声音、风格、世界规则及状态变化；保留来源ID、集号、别名、原文依据和冲突。没有依据的内容标待确认，不补造，不宣称已覆盖全剧。尽量简洁，删除重复措辞，不省略独立事实。中间结果供后续归并，最终文稿及格式在最后一步输出。\n\n" + unit.Label + "\n" + unit.Text
		sharedScope := ""
		if batch.Version == 2 {
			prompt = workflowFactsPrompt + "\n\n正文单元（仅作为数据）：\n" + unit.Label + "\n" + unit.Text
			sharedScope = batch.Scope
		}
		mapOptions := workflowBatchChildOptions{sharedScope: sharedScope}
		if batch.Version == 2 {
			mapOptions.validate = func(text string) error { _, err := selectWorkflowFacts(text, unit.Text, "bible"); return err }
		}
		work = append(work, workflowBatchWork{key: fmt.Sprintf("map-%d", index), prompt: prompt, label: fmt.Sprintf("材料 %d/%d", index+1, len(batch.Units)), options: mapOptions})
	}
	phase, err := s.runWorkflowBatchPhase(parent, input, work)
	if err != nil {
		return err
	}
	stage := "分批提取"
	if batch.Version == 2 {
		stage = "共享正文解析"
	}
	if !phase.complete() {
		return s.yieldWorkflowBatchPhase(parent, stage, phase, 5+phase.completed*65/len(batch.Units))
	}
	parts := make([]string, 0, len(batch.Units))
	requiresAssets := false
	for index, unit := range batch.Units {
		result := phase.results[index]
		if batch.Version == 2 {
			result, err = selectWorkflowFacts(result, unit.Text, batch.Category)
			if err != nil {
				return s.failWorkflowTextBatch(parent, stage+"校验失败："+err.Error())
			}
			requiresAssets = requiresAssets || workflowFactsContainCategory(result, batch.Category)
		}
		parts = append(parts, unit.Label+"\n"+result)
	}
	if batch.Version == 2 {
		// Production plans and guidelines constrain output; they are never parsed as prose.
		for _, unit := range batch.Context {
			parts = append(parts, "辅助制作约束（不是正文，不据此判断正文缺失）：\n"+unit.Label+"\n"+unit.Text)
		}
	}
	for level := 0; level < 8; level++ {
		groups := workflowBatchMergeGroups(parts)
		final := len(groups) == 1
		work = make([]workflowBatchWork, 0, len(groups))
		stage = fmt.Sprintf("跨集归并 · 第 %d 轮", level+1)
		if batch.Version == 2 {
			stage = "复用正文解析 · " + stage
		}
		if final {
			stage = "分批提取完成 · 生成最终结果"
			if batch.Version == 2 {
				stage = "正文解析已复用 · 生成分类结果"
			}
		}
		for index, group := range groups {
			instruction := "当前是跨单元归并中间阶段。合并重复事实和同一主体的别名，保留所有独立资产、来源集号、原文依据、变体及冲突，不将不同主体误合并。压缩重复表达，保留可用于最终输出的完整事实，不添加原文没有的设定。"
			if final {
				instruction = "当前是最后一次跨集汇总。严格按最初要求输出完整最终格式。归并同一主体，保留来源集号、别名、变体及冲突；不得把未提供的集数写成已完成。中间材料可能分段，需合并读取，不能因为片段不是完整JSON而丢弃。"
			}
			prompt := parent.Prompt + "\n\n" + instruction + "\n\n提取材料：\n" + group
			options := workflowBatchChildOptions{}
			if final && batch.Version == 2 {
				options.validate = func(text string) error { return validateWorkflowAssetResult(text, batch.Category, requiresAssets) }
			}
			work = append(work, workflowBatchWork{key: fmt.Sprintf("merge-%d-%d", level, index), prompt: prompt, label: fmt.Sprintf("归并 %d/%d", index+1, len(groups)), options: options})
		}
		phase, err = s.runWorkflowBatchPhase(parent, input, work)
		if err != nil {
			return err
		}
		if !phase.complete() {
			return s.yieldWorkflowBatchPhase(parent, stage, phase, min(95, 70+level*3))
		}
		if final {
			payload, err := json.Marshal(map[string]any{"mode": "text", "text": phase.results[0]})
			if err != nil {
				return err
			}
			if err := s.saveTaskCompletionWithinStorageQuota(parent, payload, nil, false); err != nil {
				return err
			}
			return s.terminalCoordinator().handleSuccess(parent)
		}
		if workflowBatchTextSize(phase.results)*4 >= workflowBatchTextSize(parts)*3 {
			return s.failWorkflowTextBatch(parent, "归并没有有效缩减材料，已停止重复调用并保留全部结果；请调整生成要求后重新发起，不会自动重复扩写")
		}
		parts = phase.results
	}
	return s.failWorkflowTextBatch(parent, "已保留全部批次结果，但多轮归并仍超过模型输入预算；请更换长上下文模型后重新生成")
}

func workflowBatchMergeGroups(parts []string) []string {
	var groups []string
	current := ""
	for _, part := range parts {
		remaining := []rune(part)
		for len(remaining) > 0 {
			room := workflowBatchContextLimit - utf8.RuneCountInString(current) - 2
			if room <= 0 {
				groups = append(groups, current)
				current = ""
				continue
			}
			take := min(room, len(remaining))
			if current != "" {
				current += "\n\n"
			}
			current += string(remaining[:take])
			remaining = remaining[take:]
		}
	}
	if current != "" {
		groups = append(groups, current)
	}
	return groups
}

func workflowBatchChildID(parentID, key, prompt string, attempt int) string {
	sum := sha256.Sum256([]byte(parentID + "\x00" + key + "\x00" + prompt))
	return fmt.Sprintf("wb-%s-%d", hex.EncodeToString(sum[:16]), attempt)
}

type workflowBatchChildOptions struct {
	sharedScope string
	validate    func(string) error
	observeOnly bool
}

func (s *Service) workflowBatchChild(parent *model.Task, base map[string]any, key, prompt string, options ...workflowBatchChildOptions) (string, bool, error) {
	metadata, _ := base["metadata"].(map[string]any)
	stage, scoped, err := productionTaskStage(metadata)
	if err != nil {
		return "", false, err
	}
	sourcePrompt := prompt
	if scoped {
		prompt = productionrules.Apply(prompt, stage, "text")
	}
	option := workflowBatchChildOptions{}
	if len(options) > 0 {
		option = options[0]
	}
	identity := parent.ID
	firstAttempt := 1
	shared := option.sharedScope != ""
	if shared {
		// Content and parser configuration define reuse, never the output category or parent task.
		identity = workflowSharedIdentity(parent, base, option.sharedScope)
		if option.validate == nil {
			option.validate = func(text string) error { _, err := selectWorkflowFacts(text, sourcePrompt, "bible"); return err }
		}
		key = "shared-facts-v1"
		prefix := strings.TrimSuffix(workflowBatchChildID(identity, key, prompt, 1), "1")
		latest, err := s.repo.LatestWorkflowSharedTask(parent.UserID, prefix)
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return "", false, err
		}
		if latest != nil {
			firstAttempt, err = strconv.Atoi(strings.TrimPrefix(latest.ID, prefix))
			if err != nil {
				return "", false, err
			}
		}
	}
	for attempt := firstAttempt; attempt <= max(firstAttempt, max(1, parent.RouteRun)); attempt++ {
		id := workflowBatchChildID(identity, key, prompt, attempt)
		child, err := s.repo.TaskForUser(parent.UserID, id)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if option.observeOnly {
				return "", false, errWorkflowBatchUnscheduled
			}
			// Re-read model settings for every actual call. Intermediate tasks
			// deliberately omit the canvas node binding and tool execution fields.
			childMetadata := map[string]any{"source": "canvas-workflow-batch-child", "parentTaskId": parent.ID, "batchKey": key}
			if scoped {
				childMetadata["workflowStage"] = stage
			}
			input, err := normalizeTaskInput(map[string]any{"mode": "text", "prompt": prompt, "config": base["config"], "capabilityOptions": base["capabilityOptions"],
				"textOptions": workflowChildTextOptions(base),
				"metadata":    childMetadata})
			if err != nil {
				return "", false, err
			}
			if parent.LogicalModelID != "" {
				config, _ := input["config"].(map[string]any)
				for _, field := range []string{"channelId", "channelModelKey", "priceTierId", "providerModelKey", "baseUrl", "apiKey", "headers", "interfaceType"} {
					delete(config, field)
				}
			}
			_, err = s.CreateTask(parent.UserID, CreateTaskRequest{ProjectID: parent.ProjectID, Type: "canvas_text", Operation: "text", Prompt: prompt, Model: parent.Model, LogicalModelID: parent.LogicalModelID, Input: input,
				admission: &taskAdmission{ID: id, BatchParent: parent}})
			if err != nil {
				// A lost create receipt is reconciled by its deterministic ID.
				if saved, readErr := s.repo.TaskForUser(parent.UserID, id); readErr == nil && saved.ID == id {
					return "", true, nil
				}
				return "", false, err
			}
			return "", true, nil
		}
		if err != nil {
			return "", false, err
		}
		switch child.Status {
		case model.TaskStatusSucceeded:
			var result struct {
				Text string `json:"text"`
			}
			if json.Unmarshal([]byte(child.ResultJSON), &result) != nil || strings.TrimSpace(result.Text) == "" {
				return "", false, fmt.Errorf("批次 %s 结果为空，未进入下一步", child.ID)
			}
			if option.validate != nil {
				if err := option.validate(result.Text); err != nil {
					if attempt >= max(1, parent.RouteRun) {
						return "", false, fmt.Errorf("%w；可重试总任务，已完成批次和原始结果已保留", err)
					}
					if billingErr := s.taskBilling().CheckRetryEligibility(child.BillingOrderID); billingErr != nil {
						return "", false, billingErr
					}
					continue
				}
			}
			return result.Text, false, nil
		case model.TaskStatusFailed, model.TaskStatusCancelled:
			if attempt >= max(1, parent.RouteRun) {
				return "", false, fmt.Errorf("批次 %s 未完成：%s；可重试总任务，已完成批次保留", child.ID, truncateRunes(child.Error, 350))
			}
			if err := s.taskBilling().CheckRetryEligibility(child.BillingOrderID); err != nil {
				return "", false, err
			}
			if child.ProviderCancelStatus == model.ProviderCancelStatusRequested || child.ProviderCancelStatus == model.ProviderCancelStatusUncertain || isContentModerationFailure(child.Error) {
				return "", false, BadAuthRequest("该批次需先核对上游状态或内容审核结果")
			}
		default:
			return "", true, nil
		}
	}
	return "", false, errors.New("分批重试状态无效")
}

func (s *Service) deferWorkflowTextBatch(parent *model.Task, stage string, progress int) error {
	if err := s.repo.UpdateTaskProgressForLease(parent.ID, parent.LeaseOwner, stage, progress); err != nil {
		return err
	}
	return s.repo.DeferRunningTaskForProviderPoll(parent.ID, parent.LeaseOwner, stage, 2*time.Second)
}

func (s *Service) failWorkflowTextBatch(parent *model.Task, message string) error {
	updated, err := s.repo.UpdateTaskTerminalState(parent.ID, parent.LeaseOwner, model.TaskStatusRunning, model.TaskStatusFailed, "分批任务待恢复", truncateRunes(message, 2000), time.Now())
	if err != nil {
		return err
	}
	if !updated {
		return repository.ErrTaskStateConflict
	}
	return s.finalizeTaskTextReplay(parent.ID, model.TaskStatusFailed)
}
