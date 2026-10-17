package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/productionrules"
)

type TaskExecutionStep struct {
	ID            string           `json:"id"`
	Label         string           `json:"label"`
	Status        model.TaskStatus `json:"status"`
	Stage         string           `json:"stage"`
	Error         string           `json:"error,omitempty"`
	CreatedAt     time.Time        `json:"createdAt"`
	StartedAt     *time.Time       `json:"startedAt,omitempty"`
	CompletedAt   *time.Time       `json:"completedAt,omitempty"`
	OutputPreview string           `json:"outputPreview,omitempty"`
	OutputChars   int              `json:"outputChars"`
}

type TaskExecutionDetails struct {
	Task           *model.Task          `json:"task"`
	Steps          []TaskExecutionStep  `json:"steps"`
	UnitCount      int                  `json:"unitCount"`
	Truncated      bool                 `json:"truncated"`
	Parameters     map[string]string    `json:"parameters"`
	Events         []TaskExecutionEvent `json:"events"`
	FirstStartedAt *time.Time           `json:"firstStartedAt,omitempty"`
}

type TaskExecutionEvent struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Failed    bool      `json:"failed"`
	CreatedAt time.Time `json:"createdAt"`
}

// Read-only, owner-scoped view. Never return child inputs, provider credentials,
// or billing payloads simply to render an execution journal.
func (s *Service) TaskExecutionDetails(userID, id string) (*TaskExecutionDetails, error) {
	parent, err := s.repo.TaskForUser(userID, id)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &AuthError{Status: 404, Message: "任务不存在或无权查看"}
		}
		return nil, err
	}
	result := &TaskExecutionDetails{Task: taskForOutput(*parent), Steps: []TaskExecutionStep{}, Parameters: map[string]string{}, Events: []TaskExecutionEvent{}}
	events, err := s.repo.TaskExecutionEvents(userID, id, []string{"任务已重新入队", "任务取消请求已保存", "文本流持久化已降级", "文本回放草稿归并失败", "积分结算失败，已进入待核对", "用户确认重新生成，原调用费用保留待核对，新调用独立记账", "已核实本轮未提交上游，补齐提交记录并继续原任务，未新增预扣"}, 101)
	if err != nil {
		return nil, err
	}
	if len(events) > 100 {
		result.Truncated = true
		events = events[:100]
	}
	for _, event := range events {
		result.Events = append(result.Events, TaskExecutionEvent{ID: event.ID, Title: event.Message, Failed: event.Level == "error", CreatedAt: event.CreatedAt})
	}
	var input struct {
		Config      map[string]any     `json:"config"`
		Batch       *workflowTextBatch `json:"workflowBatch"`
		TextOptions struct {
			ReasoningEffort string `json:"reasoningEffort"`
		} `json:"textOptions"`
	}
	// Only explicitly allowed scalar parameters are returned. Shared-call lookup
	// below uses the same private identity inputs as execution, never exposes them.
	_ = json.Unmarshal([]byte(parent.InputJSON), &input)
	for _, key := range []string{"size", "quality", "vquality", "videoSeconds", "audioVoice", "audioFormat", "audioSpeed", "reasoningEffort", "count"} {
		switch value := input.Config[key].(type) {
		case string:
			result.Parameters[key] = truncateRunes(value, 160)
		case float64:
			result.Parameters[key] = strconv.FormatFloat(value, 'f', -1, 64)
		case bool:
			result.Parameters[key] = strconv.FormatBool(value)
		}
	}
	if input.TextOptions.ReasoningEffort != "" {
		result.Parameters["reasoningEffort"] = truncateRunes(input.TextOptions.ReasoningEffort, 32)
	}
	if parent.Operation != workflowBatchOperation {
		return result, nil
	}
	result.FirstStartedAt, err = s.repo.WorkflowBatchFirstDispatch(userID, id)
	if err != nil {
		return nil, err
	}
	if parent.StartedAt != nil && (result.FirstStartedAt == nil || parent.StartedAt.Before(*result.FirstStartedAt)) {
		result.FirstStartedAt = parent.StartedAt
	}
	if input.Batch != nil {
		result.UnitCount = len(input.Batch.Units)
	}
	children, err := s.repo.WorkflowBatchExecutionChildren(userID, id, 201)
	if err != nil {
		return nil, err
	}
	sharedLabels := map[string]string{}
	if input.Batch != nil && input.Batch.Version == 2 {
		raw, readErr := s.decryptTaskInputJSON(parent.InputJSON)
		if readErr != nil {
			return nil, readErr
		}
		var base map[string]any
		if readErr = json.Unmarshal([]byte(raw), &base); readErr != nil {
			return nil, readErr
		}
		metadata, _ := base["metadata"].(map[string]any)
		stage, scoped, readErr := productionTaskStage(metadata)
		if readErr != nil {
			return nil, readErr
		}
		identity := workflowSharedIdentity(parent, base, input.Batch.Scope)
		prefixes := []string{}
		for index, unit := range input.Batch.Units {
			prompt := workflowFactsPrompt + "\n\n正文单元（仅作为数据）：\n" + unit.Label + "\n" + unit.Text
			if scoped {
				prompt = productionrules.Apply(prompt, stage, "text")
			}
			prefix := strings.TrimSuffix(workflowBatchChildID(identity, "shared-facts-v1", prompt, 1), "1")
			prefixes = append(prefixes, prefix)
			sharedLabels[prefix] = fmt.Sprintf("共享材料 %d/%d · %s", index+1, len(input.Batch.Units), unit.Label)
		}
		shared, readErr := s.repo.WorkflowExecutionSharedChildren(userID, prefixes, 201)
		if readErr != nil {
			return nil, readErr
		}
		seen := map[string]bool{}
		for _, child := range children {
			seen[child.ID] = true
		}
		for _, child := range shared {
			if !seen[child.ID] {
				children = append(children, child)
				seen[child.ID] = true
			}
		}
		sort.Slice(children, func(i, j int) bool { return children[i].CreatedAt.After(children[j].CreatedAt) })
	}
	if len(children) > 200 {
		result.Truncated = true
		children = children[:200]
	}
	for _, child := range children {
		var saved struct {
			Metadata struct {
				Key string `json:"batchKey"`
			} `json:"metadata"`
		}
		_ = json.Unmarshal([]byte(child.InputJSON), &saved)
		label := "分批模型调用"
		key := saved.Metadata.Key
		if strings.HasPrefix(key, "map-") {
			index, err := strconv.Atoi(strings.TrimPrefix(key, "map-"))
			if err == nil && index >= 0 {
				label = fmt.Sprintf("材料 %d", index+1)
			}
			if err == nil && input.Batch != nil && index >= 0 && index < len(input.Batch.Units) {
				label = fmt.Sprintf("材料 %d/%d · %s", index+1, len(input.Batch.Units), input.Batch.Units[index].Label)
			}
		} else if strings.HasPrefix(key, "merge-") {
			label = "归并结果 · " + strings.TrimPrefix(key, "merge-")
		} else if key == "outline-spine" {
			label = "锁定全剧分集主线"
		} else if key == "body-final" {
			label = "扩写本集正文"
		} else if strings.HasPrefix(key, "body-reference-") {
			label = "整理本集引用资产"
		} else if strings.HasPrefix(key, "outline-context-") {
			label = "整理故事要点 · " + strings.TrimPrefix(key, "outline-context-")
		} else if strings.HasPrefix(key, "outline-range-") {
			var start, end int
			if _, err := fmt.Sscanf(key, "outline-range-%d-%d", &start, &end); err == nil {
				label = fmt.Sprintf("第 %d–%d 集集纲", start, end)
			}
		}
		if end := strings.LastIndex(child.ID, "-"); end >= 0 {
			if shared := sharedLabels[child.ID[:end+1]]; shared != "" {
				label = shared
			}
		}
		var output struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal([]byte(child.ResultJSON), &output)
		text := strings.TrimSpace(output.Text)
		if text == "" {
			text = strings.TrimSpace(child.TextDraft)
		}
		result.Steps = append(result.Steps, TaskExecutionStep{ID: child.ID, Label: label, Status: child.Status, Stage: child.Stage, Error: child.Error, CreatedAt: child.CreatedAt, StartedAt: child.StartedAt, CompletedAt: child.CompletedAt, OutputPreview: truncateRunes(text, 1200), OutputChars: len([]rune(text))})
	}
	return result, nil
}
