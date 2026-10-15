package app

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"infinite-canvas/backend/internal/model"
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
		if !canvasTaskNodeAbsent(doc, task.ID, target, agent) {
			if !agent && task.NodeBoundAt == nil {
				if err := s.repo.BindCanvasNodeTasks(userID, []string{task.ID}); err != nil {
					return err
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
				return err
			}
		}
		missing, err := s.canvasTaskTargetMissing(userID, canvasID, task.ID, target, agent)
		if err != nil {
			return err
		}
		if !missing {
			continue
		}
		var relatedIDs []string
		if agent {
			err = s.CancelCloudAgent(ctx, userID, task.ID)
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
		missing, err = s.canvasTaskTargetMissing(userID, canvasID, task.ID, target, agent)
		if err == nil && missing {
			err = s.repo.RemoveStoppedCanvasTask(userID, task.ID, relatedIDs...)
		}
		s.storageMu.Unlock()
		if err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
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
