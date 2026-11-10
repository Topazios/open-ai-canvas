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

func outlineStructuredFixture(start, end int) string {
	episodes := []outlineEpisodeDocument{}
	for i := start; i <= end; i++ {
		episodes = append(episodes, outlineEpisodeDocument{
			Episode: i, Title: "选择", Opening: "主角承接前集证据，调查相机并追问来源。",
			Conflict: "知情人因利益拒绝说明，主角出示收据核验时间。", Change: "知情人承认证据，主角从怀疑转为谨慎信任。",
			Clues: "收据上的日期与既定时间线呼应。", Ending: "双方约定次日查证，留下来源疑问。",
			Continuity: "人物 CHR_001；场景 SCN_001；道具 PRP_001 收据由主角保管。",
		})
	}
	encoded, _ := json.Marshal(map[string]any{"episodes": episodes})
	return string(encoded)
}

func outlineRenderedFixture(start, end int) string {
	var parts []string
	for i := start; i <= end; i++ {
		parts = append(parts, fmt.Sprintf("## 第 %d 集｜选择\n\n**开场承接与目标：** 主角承接前集证据，调查相机并追问来源。\n\n**冲突与关键行动：** 知情人因利益拒绝说明，主角出示收据核验时间。\n\n**结果与情绪变化：** 知情人承认证据，主角从怀疑转为谨慎信任。\n\n**伏笔与回收：** 收据上的日期与既定时间线呼应。\n\n**集尾与下集承接：** 双方约定次日查证，留下来源疑问。\n\n**资产与连续性：** 人物 CHR_001；场景 SCN_001；道具 PRP_001 收据由主角保管。", i))
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
		f.finish(child, outlineStructuredFixture(part.start, part.end))
	}
	f.visit()
	f.succeeded("# 全剧集纲\n\n" + outlineRenderedFixture(1, 12))
	f.children("outline-spine", "outline-range-1-5", "outline-range-6-10", "outline-range-11-12")
}

func TestWorkflowOutlineSmallSeriesAndCoverageValidation(t *testing.T) {
	f := outlineFixture(t, 3)
	f.visit()
	children := f.children("outline-range-1-3")
	f.startQueued(children)
	f.finish(children["outline-range-1-3"], outlineStructuredFixture(1, 2))
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
		if _, err := outlineBeats(text, 1, 3); err == nil {
			t.Fatal("broken spine accepted")
		}
	}
	request := batchTestRequest()
	request.Input["workflowBatch"] = workflowTextBatch{Version: 3, EpisodeCount: 201, Units: []workflowTextUnit{{Label: "总纲", Text: "故事"}}}
	if _, err := validateWorkflowTextBatch(request.Type, request.Prompt, request.Input); err == nil {
		t.Fatal("invalid outline contract accepted")
	}
}

func outlineSourceFixture(count int) []workflowTextUnit {
	parts := []string{"## 主线与结局\n主角查清真相，最终按已定结局收束。\n## 背景与规则边界\n规则不可更改，物品交接须有依据。\n## 跨单元线索\n第1集埋设的线索在最后一集揭晓。\n## 每集叙事要点\n| 集号 | 剧情推进 | 结果变化 | 伏笔衔接 | 关联资产 |\n| --- | --- | --- | --- | --- |"}
	for episode := 1; episode <= count; episode++ {
		parts = append(parts, fmt.Sprintf("| EP-%03d | 第%d集调查，与前集结果承接，主角核验依据后采取行动%s | 第%d集结束状态 | 与第%d集衔接；伏笔遵循全剧约定 | 角色甲（plan-character-a）；本集专用道具（plan-prop-ep-%d） |", episode, episode, strings.Repeat("保留本集因果；", 24), episode, episode+1, episode))
	}
	parts = append(parts, "## 计划资产概览", strings.Repeat("完整资产美术档案不应重复携带\n", 5000), "## 叙事视角与信息揭示规则\n观众知情范围遵循主角视角。")
	// Same transport shape as workflowSourceUnits: complete lines split across
	// multiple immutable units, without assuming a whole table fits one unit.
	var units []workflowTextUnit
	remaining := []rune(strings.Join(parts, "\n"))
	for len(remaining) > 0 {
		end := min(20000, len(remaining))
		if end < len(remaining) {
			for i := end - 1; i >= end/2; i-- {
				if remaining[i] == '\n' {
					end = i + 1
					break
				}
			}
		}
		units = append(units, workflowTextUnit{Label: "故事来源", Text: string(remaining[:end])})
		remaining = remaining[end:]
	}
	return units
}

func TestWorkflowOutlineReuses120SourceCardsWithoutReplanning(t *testing.T) {
	f := outlineFixture(t, 120, outlineSourceFixture(120)...)
	f.policy(100, 30)
	f.visit()
	var keys []string
	for start := 1; start <= 120; start += outlineEpisodesPerCall {
		keys = append(keys, fmt.Sprintf("outline-range-%d-%d", start, start+4))
	}
	children := f.children(keys...)
	f.startQueued(children)
	for start := 1; start <= 120; start += outlineEpisodesPerCall {
		child := children[fmt.Sprintf("outline-range-%d-%d", start, start+4)]
		if strings.Contains(child.Prompt, "完整资产美术档案") || !strings.Contains(child.Prompt, fmt.Sprintf("plan-prop-ep-%d）", start)) || !strings.Contains(child.Prompt, "观众知情范围遵循主角视角") || !strings.Contains(child.Prompt, "第1集埋设的线索在最后一集揭晓") {
			t.Fatal("source context lost narrative/identity or repeated the full inventory")
		}
		if len([]rune(child.Prompt)) > 10000 || (start > 10 && strings.Contains(child.Prompt, "plan-prop-ep-1）")) {
			t.Fatal("range received unrelated episode rows or unbounded story input")
		}
		f.finish(child, outlineStructuredFixture(start, start+4))
	}
	// Reconstruct exclusively from persisted tasks after a service restart.
	f.s = &Service{repo: f.s.repo, dataDir: f.s.dataDir}
	f.visit()
	f.succeeded("# 全剧集纲\n\n" + outlineRenderedFixture(1, 120))
	f.children(keys...)
}

func TestWorkflowOutlineSourceCardsRejectMissingDuplicateAndBrokenRows(t *testing.T) {
	for name, body := range map[string]string{
		"missing":      "| EP-001 | 行动 | 结果 | 线索 | 编码 |",
		"duplicate":    "| EP-001 | 行动 | 结果 | 线索 | 编码 |\n| EP-001 | 行动 | 结果 | 线索 | 编码 |",
		"out-of-range": "| EP-004 | 行动 | 结果 | 线索 | 编码 |",
		"columns":      "| EP-001 | 行动 | 结果 |",
		"empty":        "| EP-001 | | 结果 | 线索 | 编码 |",
	} {
		t.Run(name, func(t *testing.T) {
			f := outlineFixture(t, 3, workflowTextUnit{Label: "总纲", Text: "## 每集叙事要点\n| 集号 | 剧情推进 | 结果变化 | 伏笔衔接 | 关联资产 |\n" + body})
			f.visit()
			f.children()
			if f.parent.Status != model.TaskStatusFailed || !strings.Contains(f.parent.Error, "总纲逐集骨架") {
				t.Fatal("malformed adopted source was silently regenerated or accepted")
			}
		})
	}
	_, rows, err := outlineSourceContext([]workflowTextUnit{{Text: "```md\n## 每集叙事要点\n| EP-001 | 示例 |\n```\n## 主线与结局\n真实故事"}}, 3)
	if err != nil || rows != nil {
		t.Fatal("a fenced example became an adopted spine")
	}
}

func TestWorkflowOutlineUnsourcedLongSpineUsesBoundedSequentialSegments(t *testing.T) {
	f := outlineFixture(t, 41)
	var keys []string
	for start := 1; start <= 41; start += outlineSpineEpisodesPerCall {
		end := min(start+outlineSpineEpisodesPerCall-1, 41)
		key := fmt.Sprintf("outline-spine-%d-%d", start, end)
		keys = append(keys, key)
		f.visit()
		children := f.children(keys...)
		child := children[key]
		if start > 1 && !strings.Contains(child.Prompt, fmt.Sprintf(`"episode":%d`, start-1)) {
			t.Fatal("later spine segment lost its accepted predecessor boundary")
		}
		if start == 1 && strings.Contains(child.Prompt, "覆盖第1至41集") {
			t.Fatal("long outline still uses a one-shot full-season spine")
		}
		f.startQueued(children)
		var fixture struct {
			Episodes []outlineBeat `json:"episodes"`
		}
		_ = json.Unmarshal([]byte(outlineSpineFixture(41)), &fixture)
		encoded, _ := json.Marshal(map[string]any{"episodes": fixture.Episodes[start-1 : end]})
		if _, err := outlineBeats(string(encoded), start, end); err != nil {
			t.Fatal(err)
		}
		if start > 1 {
			if _, err := outlineBeats(outlineSpineFixture(end-start+1), start, end); err == nil {
				t.Fatal("local renumbering of a later segment was accepted")
			}
		}
		f.finish(children[key], string(encoded))
	}
	f.visit()
	keys = append(keys, "outline-range-1-5", "outline-range-6-10", "outline-range-11-15")
	f.children(keys...)
}

func TestWorkflowOutlineSourceRetryOnlyRepeatsFailedRange(t *testing.T) {
	f := outlineFixture(t, 7, outlineSourceFixture(7)...)
	f.visit()
	children := f.children("outline-range-1-5", "outline-range-6-7")
	f.startQueued(children)
	f.finish(children["outline-range-1-5"], outlineStructuredFixture(1, 5))
	failed := children["outline-range-6-7"]
	if _, err := f.s.repo.UpdateTaskTerminalState(failed.ID, failed.LeaseOwner, model.TaskStatusRunning, model.TaskStatusFailed, "模拟失败", "模拟格式失败", time.Now()); err != nil {
		t.Fatal(err)
	}
	f.visit()
	resumed, err := f.s.RetryTask(f.parent.UserID, f.parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	f.parent = resumed
	f.s = &Service{repo: f.s.repo, dataDir: f.s.dataDir}
	f.visit()
	all, err := f.s.repo.WorkflowBatchExecutionChildren(f.parent.UserID, f.parent.ID, 100)
	if err != nil || len(all) != 3 {
		t.Fatalf("source retry repeated accepted ranges or replanned the spine: calls=%d err=%v", len(all), err)
	}
	for i := range all {
		if all[i].Status == model.TaskStatusQueued {
			pending := map[string]*model.Task{"retry": &all[i]}
			f.startQueued(pending)
			f.finish(pending["retry"], outlineStructuredFixture(6, 7))
		}
	}
	f.visit()
	f.succeeded("# 全剧集纲\n\n" + outlineRenderedFixture(1, 7))
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
	f.finish(children["outline-range-1-5"], outlineStructuredFixture(1, 5))
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
			f.finish(pending["retry"], outlineStructuredFixture(6, 7))
		}
	}
	f.visit()
	f.succeeded("# 全剧集纲\n\n" + outlineRenderedFixture(1, 7))
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
