package app

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func shortBodySpec() *bodyWritingSpec {
	return &bodyWritingSpec{Version: 1, MinSeconds: 60, MaxSeconds: 120, TargetSeconds: 90, Language: "zh-CN"}
}

func developedBody() string {
	return "# 第1集\n### 场次1｜内景\n" + strings.Repeat("【节拍时长：15秒】\n【画面与动作】她递出证据，他试图拿回，她退后挡住出口。\n人物甲："+strings.Repeat("先把原因说清楚，再决定是否一起离开。", 8)+"\n", 6)
}

func TestBodyWritingChecksActualDramaNotAppendixOrDeclaredDuration(t *testing.T) {
	good := developedBody()
	if issues := bodyWritingIssues(good, shortBodySpec()); len(issues) != 0 {
		t.Fatalf("developed script rejected: %v", issues)
	}
	short := "预计时长90秒\n【节拍时长：90秒】\n她看着他。\n## 本集资产应用与状态衔接\n" + strings.Repeat("详细资产设定与制作说明", 500)
	issues := strings.Join(bodyWritingIssues(short, shortBodySpec()), "\n")
	if !strings.Contains(issues, "展开不足") || !strings.Contains(issues, "节拍仅 1 段") || !strings.Contains(issues, "缺少实质行动") {
		t.Fatal(issues)
	}
	if issues := strings.Join(bodyWritingIssues(strings.ReplaceAll(good, "15秒", "5秒"), shortBodySpec()), "\n"); !strings.Contains(issues, "合计 30 秒") {
		t.Fatal(issues)
	}
	if issues := strings.Join(bodyWritingIssues(strings.ReplaceAll(good, "15秒", "25秒"), shortBodySpec()), "\n"); !strings.Contains(issues, "合计 150 秒") {
		t.Fatal(issues)
	}
	if len(bodyWritingIssues("旧版文稿保持不变", nil)) != 0 {
		t.Fatal("legacy task was retroactively validated")
	}
}

func TestBodyWritingLanguageAndContractValidation(t *testing.T) {
	spec := *shortBodySpec()
	spec.Language = "en"
	text := strings.Repeat("【节拍时长：15秒】\nAlice: "+strings.Repeat("She asks for the missing proof and waits for his answer. ", 5)+"\n", 6)
	if issues := bodyWritingIssues(text, &spec); len(issues) > 0 {
		t.Fatal(issues)
	}
	for _, change := range []func(*bodyWritingSpec){
		func(s *bodyWritingSpec) { s.Version = 3 },
		func(s *bodyWritingSpec) { s.MinSeconds = -1 },
		func(s *bodyWritingSpec) { s.MaxSeconds = 4000 },
		func(s *bodyWritingSpec) { s.TargetSeconds = 200 },
		func(s *bodyWritingSpec) { s.Language = "" },
	} {
		bad := *shortBodySpec()
		change(&bad)
		if bad.valid() {
			t.Fatalf("accepted invalid contract: %+v", bad)
		}
	}
	r := batchTestRequest()
	r.Input["metadata"] = map[string]any{"workflowStep": "story.body"}
	r.Input["workflowBatch"] = workflowTextBatch{Version: 4, Context: []workflowTextUnit{{Label: "本集集纲", Text: "剧情"}}, BodyWriting: shortBodySpec()}
	if _, err := validateWorkflowTextBatch(r.Type, r.Prompt, r.Input); err != nil {
		t.Fatal(err)
	}
	r.Input["workflowBatch"] = workflowTextBatch{Version: 1, Units: []workflowTextUnit{{Label: "材料", Text: "剧情"}}, BodyWriting: shortBodySpec()}
	if _, err := validateWorkflowTextBatch(r.Type, r.Prompt, r.Input); err == nil {
		t.Fatal("body validation attached to another step")
	}
}

func qualityBodyFixture(t *testing.T, specs ...*bodyWritingSpec) *parallelBatchFixture {
	spec := shortBodySpec()
	if len(specs) > 0 {
		spec = specs[0]
	}
	return newParallelBatchFixture(t, 1, 16, func(r *CreateTaskRequest) {
		r.Prompt = "按本集集纲和90秒节奏展开，不改变集纲边界"
		r.Input["metadata"] = map[string]any{"workflowStage": "story", "workflowStep": "story.body", "episodeNumber": 1}
		r.Input["workflowBatch"] = workflowTextBatch{Version: 4, Context: []workflowTextUnit{{Label: "本集集纲", Text: "本集唯一剧情，不能写到下一集"}}, BodyWriting: spec}
	})
}

func TestBodyWritingGoodDraftCompletesWithOneModelCall(t *testing.T) {
	f := qualityBodyFixture(t)
	f.visit()
	children := f.children("body-final")
	f.startQueued(children)
	f.finish(children["body-final"], developedBody())
	f.visit()
	f.children("body-final")
	if f.parent.Status != model.TaskStatusSucceeded || strings.Contains(f.parent.ResultJSON, "qualityWarnings") {
		t.Fatalf("good draft not completed: %s", f.parent.ResultJSON)
	}
}

func TestBodyWritingExpandsOnlyOnceAndSurvivesCoordinatorReentry(t *testing.T) {
	for _, repaired := range []bool{true, false} {
		t.Run(map[bool]string{true: "improved", false: "still-short"}[repaired], func(t *testing.T) {
			f := qualityBodyFixture(t)
			f.visit()
			children := f.children("body-final")
			f.startQueued(children)
			f.finish(children["body-final"], "【节拍时长：90秒】\n人物：你好。")
			f.visit()
			children = f.children("body-final", "body-expand")
			if !strings.Contains(children["body-expand"].Prompt, "本集唯一剧情") || !strings.Contains(children["body-expand"].Prompt, "原草稿") {
				t.Fatal("repair lost episode scope or draft")
			}
			f.visit() // Polling must reuse the queued revision, not pay for another.
			children = f.children("body-final", "body-expand")
			f.startQueued(children)
			text := "扩写仍然很短"
			if repaired {
				text = developedBody()
			}
			f.finish(children["body-expand"], text)
			f.visit()
			f.children("body-final", "body-expand")
			if f.parent.Status != model.TaskStatusSucceeded {
				t.Fatal("coordinator kept looping")
			}
			var result struct {
				Text     string   `json:"text"`
				Warnings []string `json:"qualityWarnings"`
			}
			if err := json.Unmarshal([]byte(f.parent.ResultJSON), &result); err != nil {
				t.Fatal(err)
			}
			if repaired && (result.Text != text || len(result.Warnings) != 0) {
				t.Fatal("improved draft not delivered")
			}
			if !repaired && (len(result.Warnings) == 0 || !strings.Contains(result.Text, "你好")) {
				t.Fatal("review warning or original draft lost")
			}
			detail, err := f.s.TaskExecutionDetails(f.parent.UserID, f.parent.ID)
			if err != nil || len(detail.QualityWarnings) != len(result.Warnings) {
				t.Fatalf("quality warning not available in details: %v", err)
			}
		})
	}
}

func TestBodyWritingFailedExpansionPreservesFirstDraft(t *testing.T) {
	f := qualityBodyFixture(t)
	f.visit()
	children := f.children("body-final")
	f.startQueued(children)
	f.finish(children["body-final"], "首次完整草稿需要扩写")
	f.visit()
	children = f.children("body-final", "body-expand")
	if err := f.db.Model(&model.Task{}).Where("id = ?", children["body-expand"].ID).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "上游失败"}).Error; err != nil {
		t.Fatal(err)
	}
	f.visit()
	if f.parent.Status != model.TaskStatusSucceeded || !strings.Contains(f.parent.ResultJSON, "首次完整草稿需要扩写") || !strings.Contains(f.parent.ResultJSON, "qualityWarnings") {
		t.Fatal("draft lost after expansion failed")
	}
	f.children("body-final", "body-expand")
}

func pacedBody() string {
	return strings.Repeat("【节拍时长：15秒】\n【画面与动作】她递出证据，对方伸手去拿，她将文件转向灯光，指着其中一行等待解释。对方想绕过桌子，她退后挡住出口，要求先说清原委再走。对方停住脚步，将另一份材料放在桌上，指出记录中遗漏的签名。她重新拿起文件，对照两份记录，发现双方说的并不是同一次交接。\n人物甲：如果这份记录没有问题，为什么另一份少了签名？先把当时交接的过程说清楚，我们再决定下一步怎么办。\n", 6)
}

func TestBodyBeatPacingScreening(t *testing.T) {
	cases := []struct {
		name, text, problem string
		characterBased      bool
	}{
		{"too-much-speech", "【节拍时长：2秒】\n林晚：" + strings.Repeat("这段台词要按自然语速说完。", 8), "口播", true},
		{"long-sparse-hold", "【节拍时长：11秒】\n林晚：好。\n两人长久沉默。", "可疑留白", true},
		{"seven-seconds-is-not-inherently-wrong", "【节拍时长：7秒】\n林晚双手举起PRP-0001，站在米白背景前。\n林晚：你们先靠近一点。\n程野替方晴整理头纱的手停在半空。方晴没有移动。快门没有按下。两人同时沉默。", "", true},
		{"short-reaction", "【节拍时长：2秒】\n方晴：别动。", "", true},
		{"simultaneous-action", "【节拍时长：8秒】\n林晚一边拨正相机的旋钮，一边看向两人，说话时抬起手示意站位，接着从取景器里确认画面。\n林晚：先站在这里，别挡住那边的光，我看看这个位置行不行。", "", true},
		{"sequential-speakers", "【节拍时长：3秒】\n林晚：" + strings.Repeat("先说清楚事情经过。", 3) + "\n方晴：" + strings.Repeat("我把文件重新核对了。", 3), "口播", true},
		{"narration-label", "【节拍时长：2秒】\n【旁白】" + strings.Repeat("一切都必须从最初的那个决定说起。", 6), "口播", true},
		{"narration-block", "【节拍时长：2秒】\n【旁白】\n\n" + strings.Repeat("一切都必须从最初的那个决定说起。", 6), "口播", true},
		{"music-is-not-dialogue", "【节拍时长：7秒】\n【音乐】" + strings.Repeat("音乐配器说明", 100) + "\n林晚：来。\n她举起相机，对着两人，等他们各自站好，确认灯光位置后才开始取景。", "", true},
		{"english-speech", "【节拍时长：2秒】\nAlice: " + strings.Repeat("Tell me what happened before you left the room. ", 8), "口播", false},
		{"zero-time", "【节拍时长：0秒】\n她推门进屋。", "正数", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			issues := bodyBeatPacingIssues(tc.text, tc.characterBased)
			if tc.problem == "" && len(issues) != 0 {
				t.Fatal(issues)
			}
			if tc.problem != "" && !strings.Contains(strings.Join(issues, "\n"), tc.problem) {
				t.Fatal(issues)
			}
		})
	}
}

func TestBodyWritingV2DoesNotEnforceMinimumBeatDurationOrRetrofitV1(t *testing.T) {
	spec := shortBodySpec()
	spec.Version = 2
	text := "【节拍时长：2秒】\n林晚：别动。\n" + pacedBody()
	if issues := bodyWritingIssues(text, spec); len(issues) != 0 {
		t.Fatal(issues)
	}
	spec.Version = 1
	if issues := bodyWritingIssues(developedBody(), spec); len(issues) != 0 {
		t.Fatalf("old request was retroactively given pacing checks: %v", issues)
	}
}

func TestBodyWritingV2RepairsLocalPacingWithOneCall(t *testing.T) {
	spec := shortBodySpec()
	spec.Version = 2
	f := qualityBodyFixture(t, spec)
	f.visit()
	children := f.children("body-final")
	f.startQueued(children)
	bad := strings.Replace(pacedBody(), "15秒", "2秒", 1)
	if issues := bodyWritingGlobalIssues(bad, spec); len(issues) != 0 {
		t.Fatalf("fixture must pass overall duration and volume: %v", issues)
	}
	f.finish(children["body-final"], bad)
	f.visit()
	children = f.children("body-final", "body-expand")
	if !strings.Contains(children["body-expand"].Prompt, "第 1 节拍口播") || !strings.Contains(children["body-expand"].Prompt, "本集唯一剧情") || !strings.Contains(children["body-expand"].Prompt, "不盲目凑字数") {
		t.Fatal("pacing repair lost issue, episode scope or meaning")
	}
	f.visit()
	children = f.children("body-final", "body-expand")
	f.startQueued(children)
	f.finish(children["body-expand"], pacedBody())
	f.visit()
	if f.parent.Status != model.TaskStatusSucceeded || strings.Contains(f.parent.ResultJSON, "qualityWarnings") {
		t.Fatal("pacing repair did not complete")
	}
	detail, err := f.s.TaskExecutionDetails(f.parent.UserID, f.parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	labels := ""
	for _, step := range detail.Steps {
		labels += step.Label
	}
	if !strings.Contains(labels, "修订正文节奏与展开") {
		t.Fatal(labels)
	}
	f.children("body-final", "body-expand")
}
