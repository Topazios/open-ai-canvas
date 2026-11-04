package app

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// A deleted asset node revokes its artifact receipt and its scheduler entry.
// Provider cancellation uncertainty is retained on the work item so a later
// explicit retry cannot submit a duplicate upstream request.
func (s *Service) reconcileDeletedProductionPlanAssets(ctx context.Context, userID, canvasID string, doc map[string]any, deleted map[string]bool) error {
	jobs, err := s.repo.ProductionAgentJobsForCanvas(userID, canvasID)
	if err != nil {
		return err
	}
	for _, job := range jobs {
		if err := ctx.Err(); err != nil {
			return err
		}
		rows, err := s.repo.ProductionAgentArtifacts(userID, job.RunID)
		if err != nil {
			return err
		}
		var manifest productionManifest
		if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
			return err
		}
		if manifest.Plan == nil {
			continue
		}
		for _, row := range rows {
			if !deleted[row.NodeID] || productionNode(doc, row.NodeID) != nil || productionPlanItem(manifest, row.Key) == nil {
				continue
			}
			run, err := s.repo.CloudAgent(userID, job.RunID)
			if err != nil {
				return err
			}
			state, err := cloudAgentDecode(run)
			if err != nil {
				return err
			}
			work := state.ProductionParallel[row.Key]
			taskID := work.TaskID
			clearWork := true
			if taskID != "" {
				task, err := s.repo.TaskForUser(userID, taskID)
				if err != nil {
					return err
				}
				if task.Status == model.TaskStatusQueued || task.Status == model.TaskStatusRunning {
					if _, err := s.taskLifecycle().cancelTaskWithIntent(ctx, userID, taskID, model.TaskCancellationIntent{Source: model.TaskCancellationNodeDeleted, ActorID: userID}); err != nil {
						return err
					}
					task, err = s.repo.TaskForUser(userID, taskID)
					if err != nil {
						return err
					}
				}
				clearWork = task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning &&
					task.ProviderCancelStatus != model.ProviderCancelStatusRequested && task.ProviderCancelStatus != model.ProviderCancelStatusUncertain
				if task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning {
					if err := s.repo.RemoveStoppedCanvasTask(userID, taskID); err != nil && !errors.Is(err, repository.ErrCreationConflict) {
						return err
					}
				}
			}
			for attempt := 0; attempt < 4; attempt++ {
				run, err = s.repo.CloudAgent(userID, job.RunID)
				if err != nil {
					return err
				}
				err = s.repo.MutateCloudAgent(userID, job.RunID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
					currentState, err := cloudAgentDecode(current)
					if err != nil {
						return err
					}
					currentJob, err := repo.ProductionAgentJob(userID, job.RunID)
					if err != nil {
						return err
					}
					var currentManifest productionManifest
					if err := json.Unmarshal([]byte(currentJob.ManifestJSON), &currentManifest); err != nil {
						return err
					}
					if currentManifest.Plan == nil || productionPlanItem(currentManifest, row.Key) == nil {
						return nil
					}
					artifacts, err := repo.ProductionAgentArtifacts(userID, job.RunID)
					if err != nil {
						return err
					}
					for _, currentRow := range artifacts {
						if currentRow.Key == row.Key && currentRow.NodeID == row.NodeID {
							if err := repo.DeleteProductionAgentArtifact(userID, job.RunID, row.Key, row.NodeID); err != nil {
								return err
							}
							break
						}
					}
					currentManifest.Plan.SelectedAssetKeys = slices.DeleteFunc(currentManifest.Plan.SelectedAssetKeys, func(key string) bool { return key == row.Key })
					delete(currentManifest.Plan.AssetPlaceholderNodeIDs, row.Key)
					encoded, err := json.Marshal(currentManifest)
					if err != nil {
						return err
					}
					if err := repo.UpdateProductionAgentManifest(userID, job.RunID, string(encoded)); err != nil {
						return err
					}
					if currentWork, exists := currentState.ProductionParallel[row.Key]; exists && (taskID == "" || currentWork.TaskID == taskID) {
						if clearWork {
							delete(currentState.ProductionParallel, row.Key)
							for key, id := range currentState.ProductionModelReceipts {
								if id == taskID {
									delete(currentState.ProductionModelReceipts, key)
								}
							}
						} else {
							currentWork.Error = "资产已删除；原调用的上游状态仍在核对，确认后才能重新生成"
							currentState.ProductionParallel[row.Key] = currentWork
						}
					}
					currentState.event(job.RunID, "production_asset_deleted", map[string]any{"assetKey": row.Key, "nodeId": row.NodeID, "taskId": taskID, "text": "已清理删除资产的生成回执和对应排队任务"})
					return cloudAgentSave(current, &currentState)
				})
				if errors.Is(err, repository.ErrCreationConflict) {
					continue
				}
				if err != nil {
					return err
				}
				break
			}
		}
		if err := s.dropDeletedProductionPlanPlaceholders(userID, job.RunID, doc, deleted); err != nil {
			return err
		}
	}
	return nil
}

// A queued placeholder has no receipt, so deleting it must still be remembered:
// otherwise the scheduler sees a selected asset without a node and rebuilds it.
func (s *Service) dropDeletedProductionPlanPlaceholders(userID, runID string, doc map[string]any, deleted map[string]bool) error {
	for attempt := 0; attempt < 4; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			job, err := repo.ProductionAgentJob(userID, runID)
			if err != nil {
				return err
			}
			var manifest productionManifest
			if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
				return err
			}
			if manifest.Plan == nil {
				return nil
			}
			artifacts, err := repo.ProductionAgentArtifacts(userID, runID)
			if err != nil {
				return err
			}
			saved := productionSavedKeys(artifacts)
			var dropped []string
			for _, item := range manifest.Plan.Assets {
				id := manifest.Plan.AssetPlaceholderNodeIDs[item.Key]
				if id == "" {
					id = "pap-" + productionHash([]string{runID, item.Key})[:32]
				}
				if !deleted[id] || productionNode(doc, id) != nil || saved[item.Key] || !productionPlanAssetSelected(manifest, item.Key) {
					continue
				}
				dropped = append(dropped, item.Key)
			}
			if len(dropped) == 0 {
				return nil
			}
			if manifest.Plan.SelectedAssetKeys == nil {
				for _, item := range manifest.Plan.Assets {
					manifest.Plan.SelectedAssetKeys = append(manifest.Plan.SelectedAssetKeys, item.Key)
				}
			}
			manifest.Plan.SelectedAssetKeys = slices.DeleteFunc(manifest.Plan.SelectedAssetKeys, func(key string) bool { return slices.Contains(dropped, key) })
			for _, key := range dropped {
				delete(manifest.Plan.AssetPlaceholderNodeIDs, key)
			}
			encoded, err := json.Marshal(manifest)
			if err != nil {
				return err
			}
			if err := repo.UpdateProductionAgentManifest(userID, runID, string(encoded)); err != nil {
				return err
			}
			state, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			state.event(runID, "production_asset_deleted", map[string]any{"assetKeys": dropped, "text": "已清理删除的待生成资产占位"})
			return cloudAgentSave(current, &state)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		return err
	}
	return nil
}
