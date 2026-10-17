package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
)

func TestTaskSummaryPresentationParentOutsidePage(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	now := time.Now()
	for _, task := range []model.Task{
		{ID: "parent", UserID: "user", ProjectID: "p", Status: model.TaskStatusSucceeded, CreatedAt: now.Add(-time.Hour), InputJSON: `{"metadata":{"source":"canvas-short-drama-workflow","nodeId":"outline","workflowStep":"story.episodes"},"workflowBatch":{"units":[{"label":"第 1 集"}]}}`},
		{ID: "child", UserID: "user", ProjectID: "p", Status: model.TaskStatusRunning, CreatedAt: now, InputJSON: `{"metadata":{"source":"canvas-workflow-batch-child","parentTaskId":"parent","batchKey":"map-0"}}`},
	} {
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.TasksWithOptions("user", TaskListOptions{Limit: 1, ProjectID: "p", ActiveOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "child" || got[0].ClientContext == nil || got[0].ClientContext.ParentNodeID != "outline" || got[0].ClientContext.SourceLabel != "第 1 集" {
		t.Fatalf("missing paginated parent: %+v", got)
	}
	all, err := s.TasksWithOptions("user", TaskListOptions{Limit: 30, ProjectID: "p"})
	if err != nil || len(all) != 2 || all[0].ClientContext.ParentNodeID != "outline" {
		t.Fatalf("missing same-page parent: %+v %v", all, err)
	}
	parents, err := s.repo.TaskPresentationParents("other", []string{"parent"})
	if err != nil || len(parents) != 0 {
		t.Fatalf("foreign parent returned: %+v %v", parents, err)
	}
}

func TestTaskSummaryBatchPresentation(t *testing.T) {
	parent := model.Task{ID: "parent", UserID: "user", ProjectID: "project", InputJSON: `{"metadata":{"source":"canvas-short-drama-workflow","nodeId":"outline-node","workflowStep":"story.episodes"},"workflowBatch":{"units":[{"label":"第 1 集","text":"private-source-text"}]},"config":{"apiKey":"secret-key"}}`}
	child := model.Task{ID: "child", UserID: "user", ProjectID: "project", InputJSON: `{"metadata":{"source":"canvas-workflow-batch-child","parentTaskId":"parent","batchKey":"map-0","nodeId":"must-not-bind"}}`}
	summaries := taskSummariesForOutput([]model.Task{child, parent})
	c := summaries[0].ClientContext
	if c == nil || c.ParentTaskID != "parent" || c.ParentNodeID != "outline-node" || c.NodeID != "" || c.WorkflowStepID != "story.episodes" || c.SourceLabel != "第 1 集" || c.BatchKey != "map-0" {
		t.Fatalf("incorrect batch presentation: %+v", c)
	}
	raw, _ := json.Marshal(summaries)
	for _, forbidden := range []string{"private-source-text", "secret-key", "must-not-bind", "workflowBatch"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("leaked %s", forbidden)
		}
	}
	if summaries[1].ClientContext.WorkflowStepID != "story.episodes" {
		t.Fatal("parent lost workflow step")
	}
}

func TestTaskSummaryBatchPresentationScopeAndMissingParent(t *testing.T) {
	child := model.Task{ID: "child", UserID: "user", ProjectID: "project", InputJSON: `{"metadata":{"source":"canvas-workflow-batch-child","parentTaskId":"parent","batchKey":"merge-1-2"}}`}
	for _, parent := range []model.Task{
		{ID: "missing"},
		{ID: "parent", UserID: "other", ProjectID: "project"},
		{ID: "parent", UserID: "user", ProjectID: "other"},
	} {
		parent.InputJSON = `{"metadata":{"nodeId":"wrong-node"}}`
		c := taskSummariesForOutput([]model.Task{child, parent})[0].ClientContext
		if c == nil || c.ParentTaskID != "parent" || c.BatchKey != "merge-1-2" || c.ParentNodeID != "" || c.SourceLabel != "" {
			t.Fatalf("scope failure: %+v", c)
		}
	}
}

func TestTaskBatchSourceLabelBounds(t *testing.T) {
	for _, key := range []string{"map--1", "map-999", "map-no", "merge-0-0", "shared-facts-v1"} {
		if workflowBatchSourceLabel(`{"workflowBatch":{"units":[{"label":"one"}]}}`, key) != "" {
			t.Fatalf("invalid key %s", key)
		}
	}
	if workflowBatchSourceLabel(`invalid-json`, "map-0") != "" {
		t.Fatal("invalid json")
	}
	label := strings.Repeat("字", 500)
	raw, _ := json.Marshal(map[string]any{"workflowBatch": map[string]any{"units": []any{map[string]any{"label": label}}}})
	if len([]rune(workflowBatchSourceLabel(string(raw), "map-0"))) > 163 {
		t.Fatal("unbounded label")
	}
}
