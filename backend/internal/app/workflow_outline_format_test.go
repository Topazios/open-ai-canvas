package app

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestWorkflowOutlineFormattingRepairsWithoutChangingEpisodeBodies(t *testing.T) {
	want := outlineRangeFixture(51, 55)
	for name, text := range map[string]string{
		"canonical":            want,
		"inline-first-heading": "我将按已锁定的第51—55集主线，直接整理为五个连续集纲。" + want,
		"separate-preamble":    "下面是五集集纲：\n\n" + want,
		"title-levels":         strings.ReplaceAll(want, "## 第 ", "### 第 "),
		"indentation":          strings.ReplaceAll(want, "## 第 ", "  ## 第 "),
		"windows-newlines":     strings.ReplaceAll(want, "\n", "\r\n"),
		"code-wrapper":         "```markdown\n" + want + "\n```",
		"bom":                  "\uFEFF" + want,
	} {
		t.Run(name, func(t *testing.T) {
			got, err := normalizeOutlineRange(text, 51, 55)
			if err != nil || got != want {
				t.Fatalf("format-only change was not repaired: %v\n%s", err, got)
			}
			if validateOutlineRange(text, 51, 55) != nil {
				t.Fatal("batch validation and final document normalization diverged")
			}
			if again, err := normalizeOutlineRange(got, 51, 55); err != nil || again != got {
				t.Fatal("normalization is not idempotent")
			}
		})
	}
}

func TestWorkflowOutlineFormattingKeepsContentCoverageGuards(t *testing.T) {
	for name, sample := range map[string]struct{ text, reason string }{
		"missing":               {outlineRangeFixture(52, 55), "缺少第 51 集"},
		"duplicate":             {outlineRangeFixture(51, 55) + "\n\n" + outlineRangeFixture(53, 53), "第 53 集重复"},
		"outside-range":         {outlineRangeFixture(51, 56), "第 56 集超出本批范围"},
		"local-numbering":       {outlineRangeFixture(1, 5), "缺少第 51 集"},
		"reordered":             {outlineRangeFixture(52, 52) + "\n\n" + outlineRangeFixture(51, 51) + "\n\n" + outlineRangeFixture(53, 55), "集号乱序"},
		"empty":                 {"## 第51集\n简略", "只有标题或内容不完整"},
		"example-not-episode":   {outlineRangeFixture(51, 54) + "\n\n示例：\n```md\n" + outlineRangeFixture(55, 55) + "\n```", "缺少第 55 集"},
		"unclosed-fence":        {outlineRangeFixture(51, 55) + "\n```md\n示例", "围栏未闭合"},
		"heading-crosses-lines": {strings.Replace(outlineRangeFixture(51, 55), "## 第 51 集", "##\n第 51 集", 1), "缺少第 51 集"},
	} {
		t.Run(name, func(t *testing.T) {
			start, end := 51, 55
			if name == "empty" {
				end = 51
			}
			_, err := normalizeOutlineRange(sample.text, start, end)
			if err == nil || !strings.Contains(err.Error(), sample.reason) {
				t.Fatalf("expected %s, got %v", sample.reason, err)
			}
		})
	}
}

func TestWorkflowOutlineFormattingIgnoresFencedExamplesButKeepsRealBody(t *testing.T) {
	first := outlineRangeFixture(51, 51) + "\n\n```text\n## 第 52 集｜对白里展示的格式示例\n不是真实分集。\n```"
	want := first + "\n\n" + outlineRangeFixture(52, 55)
	got, err := normalizeOutlineRange(want, 51, 55)
	if err != nil || got != want {
		t.Fatalf("example changed episode coverage or text: %v", err)
	}
}

func TestWorkflowOutlineFormattingResumeReusesAll24SavedCalls(t *testing.T) {
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
		text := outlineStructuredFixture(start, start+4)
		if start == 51 {
			text = "我会按锁定的集数返回单个JSON对象。\n```json\n" + text + "\n```"
		} else if start == 11 {
			text = strings.TrimSuffix(text, "]}") + "}]}"
		}
		f.finish(children[keys[(start-1)/outlineEpisodesPerCall]], text)
	}
	// Resume after all provider calls succeeded, including a fenced JSON reply.
	parent := claimBatchTestTask(t, f.s, f.db, f.parent.ID)
	if _, err := f.s.repo.UpdateTaskTerminalState(parent.ID, parent.LeaseOwner, model.TaskStatusRunning, model.TaskStatusFailed, "分批任务待恢复", "第 51–55 集结果不完整", time.Now()); err != nil {
		t.Fatal(err)
	}
	resumed, err := f.s.RetryTask(parent.UserID, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	f.parent = resumed
	f.s = &Service{repo: f.s.repo, dataDir: f.s.dataDir}
	f.visit()
	f.succeeded("# 全剧集纲\n\n" + outlineRenderedFixture(1, 120))
	f.children(keys...)
	raw, err := f.s.repo.Task(children["outline-range-51-55"].ID)
	if err != nil || !strings.Contains(raw.ResultJSON, "```json") {
		t.Fatal("normalization overwrote the original provider receipt")
	}
	raw, err = f.s.repo.Task(children["outline-range-11-15"].ID)
	if err != nil || !strings.Contains(raw.ResultJSON, "}}]}") {
		t.Fatal("punctuation repair overwrote the original provider receipt")
	}
}
