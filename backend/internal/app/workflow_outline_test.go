package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func outlineFixture(t *testing.T, count int, units ...workflowTextUnit) *parallelBatchFixture {
	t.Helper()
	if len(units) == 0 {
		units = []workflowTextUnit{{Label: "故事总纲", Text: "主人公发现相机秘密，调查后作出选择。"}}
	}
	return newParallelBatchFixture(t, 1, 16, func(request *CreateTaskRequest) {
		request.Prompt = "生成完整分集集纲"
		request.Input["metadata"] = map[string]any{"workflowStage": "story", "workflowStep": "story.episodes"}
		request.Input["workflowBatch"] = workflowTextBatch{Version: 3, EpisodeCount: count, Units: units}
	})
}

func outlineSpineFixture(count int) string {
	beats := []outlineBeat{}
	for i := 1; i <= count; i++ {
		beats = append(beats, outlineBeat{i, "目标", "转折", fmt.Sprintf("状态%d", i-1), fmt.Sprintf("状态%d", i), "钩子"})
	}
	encoded, _ := json.Marshal(map[string]any{"episodes": beats})
	return string(encoded)
}

func outlineRangeFixture(start, end int) string {
	parts := []string{}
	for i := start; i <= end; i++ {
		parts = append(parts, fmt.Sprintf("## 第 %d 集｜选择\n本集目标：调查相机。核心冲突：真相与利益。关键事件：主角发现证据并决定追问，知情范围由不知到知晓。结尾钩子：线索指向下一地点，保持已锁定因果。", i))
	}
	return strings.Join(parts, "\n\n")
}

func TestWorkflowOutlineSpineBarrierParallelRangesAndOneResult(t *testing.T) {
	f := outlineFixture(t, 12)
	f.visit()
	children := f.children("outline-spine")
	f.startQueued(children)
	f.finish(children["outline-spine"], outlineSpineFixture(12))
	f.visit()
	children = f.children("outline-spine", "outline-range-1-5", "outline-range-6-10", "outline-range-11-12")
	f.startQueued(children)
	for _, part := range []struct{ start, end int }{{11, 12}, {1, 5}, {6, 10}} {
		key := fmt.Sprintf("outline-range-%d-%d", part.start, part.end)
		child := children[key]
		if !strings.Contains(child.Prompt, "已锁定本集段主线") || strings.Contains(child.Prompt, "原文依据和冲突") {
			t.Fatal("wrong range context")
		}
		f.finish(child, outlineRangeFixture(part.start, part.end))
	}
	f.visit()
	f.succeeded("# 全剧集纲\n\n" + outlineRangeFixture(1, 5) + "\n\n" + outlineRangeFixture(6, 10) + "\n\n" + outlineRangeFixture(11, 12))
	f.children("outline-spine", "outline-range-1-5", "outline-range-6-10", "outline-range-11-12")
}

func TestWorkflowOutlineSmallSeriesAndCoverageValidation(t *testing.T) {
	f := outlineFixture(t, 3)
	f.visit()
	children := f.children("outline-range-1-3")
	f.startQueued(children)
	f.finish(children["outline-range-1-3"], outlineRangeFixture(1, 2))
	f.visit()
	if f.parent.Status != model.TaskStatusFailed || !strings.Contains(f.parent.Error, "结果不完整") {
		t.Fatalf("incomplete outline accepted: %+v", f.parent)
	}
	for _, content := range []string{outlineRangeFixture(2, 4), outlineRangeFixture(1, 2) + "\n" + outlineRangeFixture(2, 2), "## 第 1 集\n空\n## 第 2 集\n空"} {
		if validateOutlineRange(content, 1, 3) == nil {
			t.Fatal("invalid range accepted")
		}
	}
}

func TestWorkflowOutlineUsesGlobalWindowAndRejectsBrokenSpine(t *testing.T) {
	f := outlineFixture(t, 17)
	f.policy(16, 2)
	f.visit()
	children := f.children("outline-spine")
	f.startQueued(children)
	f.finish(children["outline-spine"], outlineSpineFixture(17))
	f.visit()
	f.children("outline-spine", "outline-range-1-5", "outline-range-6-10")
	if !strings.Contains(f.parent.Stage, "待调度 2") {
		t.Fatal("outline ignored global text concurrency")
	}
	for _, text := range []string{outlineSpineFixture(2), `{"episodes":[{"episode":1}]}`, `{"episodes":`} {
		if _, err := outlineBeats(text, 3); err == nil {
			t.Fatal("broken spine accepted")
		}
	}
	request := batchTestRequest()
	request.Input["workflowBatch"] = workflowTextBatch{Version: 3, EpisodeCount: 201, Units: []workflowTextUnit{{Label: "总纲", Text: "故事"}}}
	if _, err := validateWorkflowTextBatch(request.Type, request.Prompt, request.Input); err == nil {
		t.Fatal("invalid outline contract accepted")
	}
}

func TestWorkflowOutlineResumeKeepsCompletedRangesAndFirstStart(t *testing.T) {
	f := outlineFixture(t, 7)
	f.visit()
	children := f.children("outline-spine")
	f.startQueued(children)
	f.finish(children["outline-spine"], outlineSpineFixture(7))
	f.visit()
	children = f.children("outline-spine", "outline-range-1-5", "outline-range-6-7")
	f.startQueued(children)
	f.finish(children["outline-range-1-5"], outlineRangeFixture(1, 5))
	failed := children["outline-range-6-7"]
	_, err := f.s.repo.UpdateTaskTerminalState(failed.ID, failed.LeaseOwner, model.TaskStatusRunning, model.TaskStatusFailed, "模拟失败", "格式失败", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	f.visit()
	first := f.parent.StartedAt
	resumed, err := f.s.RetryTask(f.parent.UserID, f.parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	f.parent = resumed
	if first == nil || f.parent.StartedAt == nil || !first.Equal(*f.parent.StartedAt) {
		t.Fatal("retry reset workflow start")
	}
	f.visit()
	all, err := f.s.repo.WorkflowBatchExecutionChildren(f.parent.UserID, f.parent.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 4 {
		t.Fatalf("successful ranges repeated: got %d calls", len(all))
	}
	for i := range all {
		if all[i].Status == model.TaskStatusQueued {
			pending := map[string]*model.Task{"retry": &all[i]}
			f.startQueued(pending)
			f.finish(pending["retry"], outlineRangeFixture(6, 7))
		}
	}
	f.visit()
	f.succeeded("# 全剧集纲\n\n" + outlineRangeFixture(1, 5) + "\n\n" + outlineRangeFixture(6, 7))
}

func TestWorkflowOutlineCondensesLongCoreBeforeGeneration(t *testing.T) {
	f := outlineFixture(t, 3, workflowTextUnit{Label: "总纲上", Text: strings.Repeat("因果", 7000)}, workflowTextUnit{Label: "总纲下", Text: strings.Repeat("伏笔", 7000)})
	f.visit()
	children := f.children("outline-context-0-0", "outline-context-0-1")
	f.startQueued(children)
	for _, child := range children {
		f.finish(child, "世界规则、故事因果与结局的精简要点")
	}
	f.visit()
	f.children("outline-context-0-0", "outline-context-0-1", "outline-range-1-3")
}

func TestWorkflowOutlineRejectsExpandingContextAndLegacyRetry(t *testing.T) {
	f := outlineFixture(t, 3, workflowTextUnit{Label: "上", Text: strings.Repeat("甲", 15000)}, workflowTextUnit{Label: "下", Text: strings.Repeat("乙", 15000)})
	f.visit()
	children := f.children("outline-context-0-0", "outline-context-0-1")
	f.startQueued(children)
	for _, child := range children {
		f.finish(child, strings.Repeat("扩写", 5000))
	}
	f.visit()
	if f.parent.Status != model.TaskStatusFailed {
		t.Fatal("expanding output should stop before further calls")
	}

	old := newParallelBatchFixture(t, 1, 16, func(request *CreateTaskRequest) {
		request.Input["metadata"] = map[string]any{"workflowStage": "story", "workflowStep": "story.episodes"}
	})
	old.visit()
	old.children()
	if old.parent.Status != model.TaskStatusFailed || !strings.Contains(old.parent.Error, "旧版全资产") {
		t.Fatal("old outline still executes asset extraction")
	}
	if _, err := old.s.RetryTask(old.parent.UserID, old.parent.ID); err == nil || !strings.Contains(err.Error(), "重新生成集纲") {
		t.Fatal("legacy retry should give actionable recovery")
	}
}
