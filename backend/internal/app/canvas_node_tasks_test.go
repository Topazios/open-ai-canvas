package app

import (
	"context"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
	"testing"
	"time"
)

func TestCanvasNodeTasksCancelBeforeRemoval(t *testing.T) {
	s, db, run := productionFixture(t)
	if err := s.initializeProductionAgent("user", run.ID); err != nil {
		t.Fatal(err)
	}
	child := model.Task{ID: "model-child", UserID: "user", ProjectID: "agent-canvas", Status: model.TaskStatusQueued, Operation: "cloud_agent_step"}
	if err := db.Create(&child).Error; err != nil {
		t.Fatal(err)
	}
	exec, _ := s.repo.CloudAgent("user", run.ID)
	if err := s.repo.MutateCloudAgent("user", run.ID, exec.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		state.ActiveTaskID = child.ID
		state.TaskIDs = append(state.TaskIDs, child.ID)
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ReconcileCanvasNodeTasks(context.Background(), "user", "agent-canvas"); err != nil {
		t.Fatal(err)
	}
	root, _ := s.repo.TaskForUser("user", run.ID)
	if root.RemovedAt != nil {
		t.Fatal("existing node's task removed")
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		var kept []map[string]any
		for _, n := range creationMaps(doc["nodes"]) {
			if n["id"] != "target" {
				kept = append(kept, n)
			}
		}
		doc["nodes"] = kept
	})
	for i := 0; i < 2; i++ {
		if err := s.ReconcileCanvasNodeTasks(context.Background(), "user", "agent-canvas"); err != nil {
			t.Fatal(err)
		}
	}
	root, _ = s.repo.TaskForUser("user", run.ID)
	execution, err := s.repo.CloudAgent("user", run.ID)
	if err != nil || root.RemovedAt == nil || execution.Status != "cancelled" || execution.CleanupPending {
		t.Fatalf("not stopped then removed: root=%v status=%s cleanup=%v err=%v", root.RemovedAt, execution.Status, execution.CleanupPending, err)
	}
	stoppedChild, _ := s.repo.TaskForUser("user", child.ID)
	if stoppedChild.Status != model.TaskStatusCancelled || stoppedChild.RemovedAt == nil {
		t.Fatal("child model request not cancelled and removed")
	}
	visible, err := s.repo.Tasks("user", 100, "agent-canvas", false)
	if err != nil || len(visible) != 0 {
		t.Fatalf("removed task still listed: %d %v", len(visible), err)
	}
	if err := s.ControlProductionAgent("user", run.ID, "resume"); err == nil {
		t.Fatal("removed job resumed")
	}
	if err := s.ReconcileCanvasNodeTasks(context.Background(), "other-user", "agent-canvas"); err == nil {
		t.Fatal("cross-user reconciliation allowed")
	}
	if _, _, _, err := productionLoad(s.repo, execution, &cloudAgentRuntime{Request: CloudAgentRequest{CanvasID: "agent-canvas", Production: &ProductionAgentRequest{TargetNodeID: "target"}}}); err == nil {
		t.Fatal("deleted target accepted for output")
	}
}

func TestCanvasNodeTasksOrdinaryAndSharedOutput(t *testing.T) {
	s, db, _ := productionFixture(t)
	boundAt := time.Now()
	for _, task := range []model.Task{
		{ID: "orphan", UserID: "user", ProjectID: "agent-canvas", Status: model.TaskStatusQueued, NodeBoundAt: &boundAt, InputJSON: `{"metadata":{"nodeId":"missing"}}`},
		{ID: "not-saved-yet", UserID: "user", ProjectID: "agent-canvas", Status: model.TaskStatusQueued, InputJSON: `{"metadata":{"nodeId":"new-node"}}`},
		{ID: "submitted-orphan", UserID: "user", ProjectID: "agent-canvas", Status: model.TaskStatusRunning, Stage: "正在请求上游", NodeBoundAt: &boundAt, InputJSON: `{"metadata":{"nodeId":"missing"}}`},
		{ID: "retained", UserID: "user", ProjectID: "agent-canvas", Status: model.TaskStatusSucceeded, InputJSON: `{"metadata":{"nodeId":"body"}}`},
		{ID: "shared", UserID: "user", ProjectID: "agent-canvas", Status: model.TaskStatusSucceeded, InputJSON: `{"metadata":{"nodeId":"missing"}}`},
		{ID: "unbound", UserID: "user", ProjectID: "agent-canvas", Status: model.TaskStatusSucceeded, InputJSON: `{}`},
	} {
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionNode(doc, "body")["metadata"].(map[string]any)["taskId"] = "shared"
	})
	if err := s.repo.RemoveStoppedCanvasTask("user", "orphan"); err == nil {
		t.Fatal("active task removed before cancellation")
	}
	if err := s.ReconcileCanvasNodeTasks(context.Background(), "user", "agent-canvas"); err != nil {
		t.Fatal(err)
	}
	orphan, _ := s.repo.TaskForUser("user", "orphan")
	if orphan.Status != model.TaskStatusCancelled || orphan.RemovedAt == nil {
		t.Fatal("orphan not cancelled and removed")
	}
	submitted, _ := s.repo.TaskForUser("user", "submitted-orphan")
	if submitted.Status != model.TaskStatusCancelled || submitted.RemovedAt == nil || submitted.CancellationSource != model.TaskCancellationNodeDeleted {
		t.Fatal("submitted orphan still running")
	}
	for _, id := range []string{"retained", "shared", "unbound", "not-saved-yet"} {
		task, _ := s.repo.TaskForUser("user", id)
		if task.RemovedAt != nil {
			t.Fatalf("retained task %s removed", id)
		}
	}
	if _, err := s.RetryTask("user", "orphan"); err == nil {
		t.Fatal("removed task retried")
	}
	if err := s.ReconcileCanvasNodeTasks(context.Background(), "user", "agent-canvas", "new-node"); err != nil {
		t.Fatal(err)
	}
	late, _ := s.repo.TaskForUser("user", "not-saved-yet")
	if late.RemovedAt == nil || late.Status != model.TaskStatusCancelled {
		t.Fatal("explicit late submission deletion ignored")
	}
}

func TestCanvasNodeTasksDeletedContainerKeepsDocuments(t *testing.T) {
	s, db, run := productionFixture(t)
	if err := s.initializeProductionAgent("user", run.ID); err != nil {
		t.Fatal(err)
	}
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		var kept []map[string]any
		for _, node := range creationMaps(doc["nodes"]) {
			if node["id"] == "group" {
				continue
			}
			if node["parentId"] == "group" {
				delete(node, "parentId")
			}
			kept = append(kept, node)
		}
		doc["nodes"] = kept
	})
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.ReconcileCanvasNodeTasks(cancelled, "user", "agent-canvas"); err == nil {
		t.Fatal("cancelled cleanup succeeded")
	}
	root, _ := s.repo.TaskForUser("user", run.ID)
	if root.RemovedAt != nil {
		t.Fatal("failed cancellation removed record")
	}
	before, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if err := s.ReconcileCanvasNodeTasks(context.Background(), "user", "agent-canvas"); err != nil {
		t.Fatal(err)
	}
	root, _ = s.repo.TaskForUser("user", run.ID)
	if root.RemovedAt == nil {
		t.Fatal("deleted container still owns active task")
	}
	canvas, _ := s.repo.CanvasProjectForUser("user", "agent-canvas")
	if canvas.Revision != before.Revision {
		t.Fatal("cleanup rewrote the saved deletion and invalidated its revision")
	}
	doc, _ := creationDocument(canvas.PayloadJSON)
	if productionNode(doc, "target") == nil {
		t.Fatal("unframed document destroyed")
	}
}
