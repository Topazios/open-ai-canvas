package app

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func bodyFixture(t *testing.T, references []workflowTextUnit) *parallelBatchFixture {
	return newParallelBatchFixture(t, 1, 16, func(request *CreateTaskRequest) {
		request.Prompt = "按集纲扩写第1集正文"
		request.Input["metadata"] = map[string]any{"workflowStage": "story", "workflowStep": "story.body", "episodeNumber": 1}
		request.Input["workflowBatch"] = workflowTextBatch{Version: 4, Units: references, Context: []workflowTextUnit{{Label: "第1集集纲", Text: "本集完整集纲，不得改写为资料摘要"}}}
	})
}

func TestWorkflowBodyWritesOnceWithoutAssetExtraction(t *testing.T) {
	f := bodyFixture(t, []workflowTextUnit{{Label: "CHR-0001", Text: "本集角色设定"}})
	f.visit()
	children := f.children("body-final")
	if !strings.Contains(children["body-final"].Prompt, "本集完整集纲") || strings.Contains(children["body-final"].Prompt, "跨单元归并中间阶段") {
		t.Fatal("body did not use episode writing contract")
	}
	f.startQueued(children)
	f.finish(children["body-final"], "完整正文")
	f.visit()
	f.children("body-final")
	if f.parent.Status != model.TaskStatusSucceeded {
		t.Fatalf("body did not complete: %s", f.parent.Error)
	}
}

func TestWorkflowBodyCondensesOnlyReferencesAndPreservesOutline(t *testing.T) {
	f := bodyFixture(t, []workflowTextUnit{{Label: "CHR-0001", Text: strings.Repeat("人物", 11000)}, {Label: "SCN-0001", Text: strings.Repeat("场景", 11000)}, {Label: "PRP-0001", Text: strings.Repeat("道具", 5000)}})
	f.visit()
	children := f.children("body-reference-0-0", "body-reference-0-1", "body-reference-0-2")
	f.startQueued(children)
	for _, child := range children {
		if strings.Contains(child.Prompt, "本集完整集纲") || strings.Contains(child.Prompt, "按集纲扩写第1集正文") {
			t.Fatal("reference condensation received writing instructions or outline")
		}
		f.finish(child, "引用资产要点与连续性约束")
	}
	f.visit()
	children = f.children("body-reference-0-0", "body-reference-0-1", "body-reference-0-2", "body-final")
	if !strings.Contains(children["body-final"].Prompt, "本集完整集纲，不得改写为资料摘要") {
		t.Fatal("outline was lost")
	}
}

func TestWorkflowBodyLegacyPlanStopsBeforeFurtherModelCalls(t *testing.T) {
	f := newParallelBatchFixture(t, 2, 16, func(request *CreateTaskRequest) {
		request.Input["metadata"] = map[string]any{"workflowStage": "story", "workflowStep": "story.body"}
	})
	f.visit()
	f.children()
	if f.parent.Status != model.TaskStatusFailed || !strings.Contains(f.parent.Error, "本集集纲") {
		t.Fatal("legacy body extraction still executes")
	}
}

func TestWorkflowBodyContractRejectsWrongStep(t *testing.T) {
	r := batchTestRequest()
	r.Input["workflowBatch"] = workflowTextBatch{Version: 4, Context: []workflowTextUnit{{Label: "集纲", Text: "剧情"}}}
	if _, err := validateWorkflowTextBatch(r.Type, r.Prompt, r.Input); err == nil {
		t.Fatal("body contract accepted without body scope")
	}
	r.Input["metadata"] = map[string]any{"workflowStep": "story.body"}
	if _, err := validateWorkflowTextBatch(r.Type, r.Prompt, r.Input); err != nil {
		t.Fatal(err)
	}
}
