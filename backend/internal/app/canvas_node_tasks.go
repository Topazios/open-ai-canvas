package app

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func (s *Service) startCanvasNodeTaskCleanup(ctx context.Context) {
	s.runWorkerLoop(func(ctx context.Context) {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		cursor := ""
		for {
			rows, err := s.repo.CanvasNodeTaskScopes(cursor)
			if err == nil {
				for _, row := range rows {
					if ctx.Err() != nil {
						return
					}
					cursor = row.ID
					if err := s.ReconcileCanvasNodeTasks(ctx, row.UserID, row.ID); err != nil {
						log.Printf("[canvas] task cleanup pending: %v", err)
					}
				}
				if len(rows) < 50 {
					cursor = ""
				}
			} else {
				log.Printf("[canvas] task cleanup scan failed: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
}

func canvasTaskTarget(task model.Task) (string, bool) {
	if task.Operation == cloudAgentOperation {
		var input struct {
			Agent cloudAgentState `json:"cloudAgent"`
		}
		if json.Unmarshal([]byte(task.InputJSON), &input) == nil && input.Agent.Request.Production != nil {
			return input.Agent.Request.Production.TargetNodeID, true
		}
		return "", false
	}
	if task.AgentRunID != "" {
		return "", false
	}
	if client := taskClientContext(task.InputJSON); client != nil {
		if client.NodeID != "" {
			return client.NodeID, false
		}
		return client.StoryNodeID, false
	}
	return "", false
}

// Only the complete persisted canvas is authoritative for absence. A client
// viewport, filtered list, unsaved draft or failed save must never delete jobs.
func (s *Service) ReconcileCanvasNodeTasks(ctx context.Context, userID, canvasID string, deletedNodeIDs ...string) error {
	canvas, err := s.repo.CanvasProjectForUser(userID, canvasID)
	if err != nil {
		return err
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		return err
	}
	deleted := map[string]bool{}
	for _, id := range deletedNodeIDs {
		deleted[id] = true
	}
	if len(deleted) > 0 {
		latestDoc, persistErr := s.persistDeletedCanvasNodes(ctx, userID, canvasID, deleted)
		if persistErr != nil {
			return persistErr
		}
		doc = latestDoc
	}
	tasks, err := s.repo.CanvasNodeTasks(userID, canvasID)
	if err != nil {
		return err
	}
	var failures []error
	for _, task := range tasks {
		if err := ctx.Err(); err != nil {
			return err
		}
		target, agent := canvasTaskTarget(task)
		if target == "" {
			continue
		}
		// 删除回执本身就是取消依据：run 会持续写云端画布，云端文档里的节点可能一直还在，
		// 只看持久化文档会让容器已删除的任务永远取消不了。
		receipt := agent && canvasAgentDeletedByReceipt(doc, target, deleted)
		if !receipt && !canvasTaskNodeAbsent(doc, task.ID, target, agent) {
			if !agent && task.NodeBoundAt == nil {
				if err := s.repo.BindCanvasNodeTasks(userID, []string{task.ID}); err != nil {
					failures = append(failures, err)
					continue
				}
			}
			// 补偿：任务已终态而节点还没写入结果（任务先完成、节点后首次保存，
			// 或上次回写失败）。回写函数自己重读画布，这里的 doc 可能已过期。
			if !agent && canvasTaskStatusTerminal(string(task.Status)) && canvasNodeTaskUnsettled(doc, target) {
				if err := s.writeTaskResultToCanvasID(ctx, task, canvasID); err != nil {
					failures = append(failures, err)
				}
			}
			continue
		}
		// Ordinary generation can be admitted before its new node is first saved.
		// Absence alone is not deletion until a persisted binding or deletion receipt exists.
		if !agent && task.NodeBoundAt == nil {
			if !deleted[target] {
				continue
			}
			if err := s.repo.BindCanvasNodeTasks(userID, []string{task.ID}); err != nil {
				failures = append(failures, err)
				continue
			}
		}
		if !receipt {
			missing, err := s.canvasTaskTargetMissing(userID, canvasID, task.ID, target, agent)
			if err != nil {
				failures = append(failures, err)
				continue
			}
			if !missing {
				continue
			}
		}
		var relatedIDs []string
		err = nil
		if agent {
			err = s.cancelCloudAgentWithSource(ctx, userID, task.ID, "node_deleted", "画布节点已删除，正在取消关联任务")
			if err == nil {
				var run *model.CloudAgentExecution
				run, err = s.repo.CloudAgent(userID, task.ID)
				if err == nil {
					state, decodeErr := cloudAgentDecode(run)
					if decodeErr == nil {
						relatedIDs = state.TaskIDs
					}
					for _, id := range relatedIDs {
						child, readErr := s.repo.TaskForUser(userID, id)
						if readErr != nil {
							err = readErr
							break
						}
						if child.Status == model.TaskStatusQueued || child.Status == model.TaskStatusRunning {
							if _, cancelErr := s.taskLifecycle().cancelTaskWithIntent(ctx, userID, id, model.TaskCancellationIntent{Source: model.TaskCancellationNodeDeleted, ActorID: userID}); cancelErr != nil {
								err = cancelErr
								break
							}
						}
					}
				}
			}
		} else if task.Status == model.TaskStatusQueued || task.Status == model.TaskStatusRunning {
			_, err = s.taskLifecycle().cancelTaskWithIntent(ctx, userID, task.ID, model.TaskCancellationIntent{Source: model.TaskCancellationNodeDeleted, ActorID: userID})
		}
		if err != nil {
			failures = append(failures, err)
			continue
		}
		// Undo or a newer canvas write may win while cancellation was in flight.
		s.storageMu.Lock()
		missing := receipt
		if !receipt {
			missing, err = s.canvasTaskTargetMissing(userID, canvasID, task.ID, target, agent)
		}
		if err == nil && missing {
			err = s.repo.RemoveStoppedCanvasTask(userID, task.ID, relatedIDs...)
		}
		s.storageMu.Unlock()
		if err != nil {
			failures = append(failures, err)
		}
	}
	if len(deleted) > 0 {
		if err := s.reconcileDeletedProductionPlanAssets(ctx, userID, canvasID, doc, deleted); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

// A deletion receipt is an explicit user operation. Persist it against the
// latest server revision so a stale whole-canvas save cannot immediately undo it.
func (s *Service) persistDeletedCanvasNodes(ctx context.Context, userID, canvasID string, deleted map[string]bool) (map[string]any, error) {
	if len(deleted) == 0 {
		return nil, nil
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	for attempt := 0; attempt < 6; attempt++ {
		canvas, err := s.repo.CanvasProjectForUser(userID, canvasID)
		if err != nil {
			return nil, err
		}
		doc, err := creationDocument(canvas.PayloadJSON)
		if err != nil {
			return nil, err
		}
		all := creationMaps(doc["nodes"])
		removed := make(map[string]bool, len(deleted))
		for id := range deleted {
			removed[id] = true
		}
		cascadeParents := make(map[string]bool)
		for id := range removed {
			if canvasNodeIsPlanContainer(productionNode(doc, id)) {
				cascadeParents[id] = true
			}
		}
		for changed := true; changed; {
			changed = false
			for _, node := range all {
				parentID := stringValue(node["parentId"])
				if !cascadeParents[parentID] || removed[stringValue(node["id"])] {
					continue
				}
				id := stringValue(node["id"])
				removed[id] = true
				cascadeParents[id] = true
				changed = true
			}
		}
		for id := range removed {
			deleted[id] = true
		}
		deletedIDs := make([]string, 0, len(removed))
		for id := range removed {
			deletedIDs = append(deletedIDs, id)
		}
		kept := make([]map[string]any, 0, len(all))
		changed := false
		for _, node := range all {
			if removed[stringValue(node["id"])] {
				changed = true
				continue
			}
			if removed[stringValue(node["parentId"])] {
				delete(node, "parentId")
				changed = true
			}
			workflow := productionWorkflow(node)
			if workflow != nil {
				ids := productionIDs(workflow["sourceNodeIds"])
				filtered := make([]string, 0, len(ids))
				for _, id := range ids {
					if !removed[id] {
						filtered = append(filtered, id)
					}
				}
				if len(filtered) != len(ids) {
					workflow["sourceNodeIds"] = filtered
					changed = true
				}
			}
			kept = append(kept, node)
		}
		connections := creationMaps(doc["connections"])
		keptConnections := make([]map[string]any, 0, len(connections))
		for _, edge := range connections {
			if removed[stringValue(edge["fromNodeId"])] || removed[stringValue(edge["toNodeId"])] {
				changed = true
				continue
			}
			keptConnections = append(keptConnections, edge)
		}
		if !changed {
			added, err := s.repo.AddCanvasNodeDeletionReceipts(userID, canvasID, deletedIDs)
			if err != nil {
				return nil, err
			}
			if !added {
				return doc, nil
			}
			if err := saveCloudAgentDocument(s.repo, canvas, doc, policy); err != nil {
				if errors.Is(err, repository.ErrCreationConflict) {
					continue
				}
				return nil, err
			}
			return doc, nil
		}
		doc["nodes"], doc["connections"] = kept, keptConnections
		if _, err := s.repo.AddCanvasNodeDeletionReceipts(userID, canvasID, deletedIDs); err != nil {
			return nil, err
		}
		if err := saveCloudAgentDocument(s.repo, canvas, doc, policy); err != nil {
			if errors.Is(err, repository.ErrCreationConflict) {
				continue
			}
			return nil, err
		}
		return doc, nil
	}
	return nil, repository.ErrCreationConflict
}

func canvasNodeIsPlanContainer(node map[string]any) bool {
	workflow := productionWorkflow(node)
	return workflow != nil && workflow["mediaGroup"] == nil &&
		((workflow["step"] == "story.plan" && workflow["role"] == "collection") || workflow["planGroup"] != nil)
}

// canvasAgentDeletedByReceipt 判断删除回执是否覆盖了 run 的目标节点、其所属容器或计划根容器。
func canvasAgentDeletedByReceipt(doc map[string]any, target string, deleted map[string]bool) bool {
	if len(deleted) == 0 {
		return false
	}
	if deleted[target] {
		return true
	}
	node := productionNode(doc, target)
	seen := map[string]bool{}
	for node != nil {
		id := stringValue(node["id"])
		if seen[id] {
			return false
		}
		seen[id] = true
		if deleted[id] {
			return true
		}
		if data := productionWorkflow(node); data != nil {
			if group, _ := data["planGroup"].(map[string]any); group != nil && deleted[stringValue(group["rootFrameId"])] {
				return true
			}
			if group, _ := data["assetGroup"].(map[string]any); group != nil && deleted[stringValue(group["manifestId"])] {
				return true
			}
		}
		parentID := stringValue(node["parentId"])
		if parentID == "" {
			return false
		}
		if deleted[parentID] {
			return true
		}
		node = productionNode(doc, parentID)
	}
	return false
}

func (s *Service) canvasTaskTargetMissing(userID, canvasID, taskID, target string, agent bool) (bool, error) {
	canvas, err := s.repo.CanvasProjectForUser(userID, canvasID)
	if err != nil {
		return false, err
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		return false, err
	}
	return canvasTaskNodeAbsent(doc, taskID, target, agent), nil
}

func canvasTaskNodeAbsent(doc map[string]any, taskID, target string, agent bool) bool {
	if node := productionNode(doc, target); node != nil {
		return agent && (stringValue(node["parentId"]) == "" || productionNode(doc, stringValue(node["parentId"])) == nil)
	}
	if !agent {
		for _, node := range creationMaps(doc["nodes"]) {
			meta, _ := node["metadata"].(map[string]any)
			if meta["taskId"] == taskID {
				return false
			}
		}
	}
	return true
}
