package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type ProductionAgentProgress struct {
	ExecutionMode         string                       `json:"executionMode,omitempty"`
	EpisodeTaskStatus     string                       `json:"episodeTaskStatus,omitempty"`
	ParallelItems         []ProductionParallelProgress `json:"parallelItems,omitempty"`
	ConcurrentItems       []string                     `json:"concurrentItems,omitempty"`
	ConcurrencyLimit      int                          `json:"concurrencyLimit,omitempty"`
	DocumentCount         int                          `json:"documentCount,omitempty"`
	DocumentTotal         int                          `json:"documentTotal,omitempty"`
	AssetCount            int                          `json:"assetCount,omitempty"`
	AssetTotal            int                          `json:"assetTotal,omitempty"`
	Phase                 string                       `json:"phase,omitempty"`
	PhaseLabel            string                       `json:"phaseLabel,omitempty"`
	CurrentItem           string                       `json:"currentItem,omitempty"`
	InventoryComplete     bool                         `json:"inventoryComplete,omitempty"`
	WorkKind              string                       `json:"workKind,omitempty"`
	MaxSteps              int                          `json:"maxSteps"`
	TargetNodeID          string                       `json:"targetNodeId"`
	Paused                bool                         `json:"paused"`
	WaitingForBoundary    bool                         `json:"waitingForBoundary"`
	ProcessedPages        int                          `json:"processedPages"`
	TotalPages            int                          `json:"totalPages"`
	ArtifactCount         int                          `json:"artifactCount"`
	ShotTotal             int                          `json:"shotTotal,omitempty"`
	Validated             bool                         `json:"validated"`
	WaitingForSharedFacts bool                         `json:"waitingForSharedFacts"`
}

type ProductionParallelProgress struct {
	Key    string `json:"key"`
	Name   string `json:"name"`
	TaskID string `json:"taskId,omitempty"`
	Status string `json:"status"`
}

func (s *Service) productionAgentProgress(userID, runID string, state *cloudAgentRuntime) *ProductionAgentProgress {
	if state.Request.Production == nil {
		return nil
	}
	view := &ProductionAgentProgress{MaxSteps: productionStepLimit(state), TargetNodeID: state.Request.Production.TargetNodeID, Paused: state.ProductionPaused, WaitingForBoundary: state.ProductionPaused && state.ActiveTaskID != ""}
	ids := []string{}
	if state.ActiveTaskID != "" {
		ids = append(ids, state.ActiveTaskID)
	}
	for _, work := range state.ProductionParallel {
		if work.TaskID != "" {
			ids = append(ids, work.TaskID)
		}
	}
	taskStates := map[string]model.TaskStatus{}
	if tasks, err := s.repo.TaskStatesForUser(userID, ids); err == nil {
		for _, task := range tasks {
			taskStates[task.ID] = task.Status
		}
	}
	for _, key := range productionParallelKeys(state.ProductionParallel) {
		work := state.ProductionParallel[key]
		status := "retrying"
		if work.Error != "" {
			status = "error"
		} else if work.TaskID != "" {
			status = string(taskStates[work.TaskID])
			if status == "" {
				status = "unknown"
			}
		}
		view.ParallelItems = append(view.ParallelItems, ProductionParallelProgress{Key: key, Name: work.Name, TaskID: work.TaskID, Status: status})
		if work.Error == "" {
			view.ConcurrentItems = append(view.ConcurrentItems, work.Name)
			view.WaitingForBoundary = view.WaitingForBoundary || (state.ProductionPaused && work.TaskID != "")
		}
	}
	job, err := s.repo.ProductionAgentJob(userID, runID)
	if err != nil {
		return view
	}
	var m productionManifest
	if json.Unmarshal([]byte(job.ManifestJSON), &m) != nil {
		return view
	}
	if m.Storyboard != nil {
		if policy, err := s.runtimeConcurrencySetting(); err == nil {
			view.ConcurrencyLimit = policy.ConcurrencyFor(model.TaskConcurrencyAgent)
		}
		view.WorkKind = "storyboard"
		if m.Storyboard.Version == storyboardEpisodeVersion {
			view.ExecutionMode = "episode"
			view.EpisodeTaskStatus = string(taskStates[state.ActiveTaskID])
			if view.EpisodeTaskStatus == "" {
				view.EpisodeTaskStatus = "preparing"
			}
			view.PhaseLabel = "规划本集场次"
			if len(m.Storyboard.Scenes) > 0 {
				view.PhaseLabel = "规划镜头列表"
				if storyboardHasLayout(m.Storyboard) {
					view.PhaseLabel = "校验本集完整分镜"
					for _, scene := range m.Storyboard.Scenes {
						if scene.Complete {
							continue
						}
						_, plans := storyboardEpisodeBatch(scene)
						view.PhaseLabel = "连续补全镜头"
						view.CurrentItem = scene.Title
						if len(plans) > 0 {
							view.CurrentItem = plans[0].ID + " ~ " + plans[len(plans)-1].ID
						}
						break
					}
				}
			}
		}
		view.TotalPages = len(m.Storyboard.Scenes)
		for _, scene := range m.Storyboard.Scenes {
			if scene.Complete {
				view.ProcessedPages++
			}
			view.ArtifactCount += len(scene.Shots)
			view.ShotTotal += max(len(scene.Layout), len(scene.Shots))
		}
		view.Validated = job.Validated
		view.WaitingForSharedFacts, _ = s.productionSharedPredecessor(userID, runID, state.Request.CanvasID)
		return view
	}
	_, done, total, err := productionFacts(s.repo, userID, m)
	view.Validated = job.Validated
	if err == nil {
		view.ProcessedPages, view.TotalPages = done, total
	}
	if rows, err := s.repo.ProductionAgentArtifacts(userID, runID); err == nil {
		view.ArtifactCount = len(rows)
		if m.Plan != nil {
			view.WorkKind = "plan"
			view.TotalPages = len(m.Plan.Assets) + 1
			if m.Plan.Version >= 2 {
				if policy, err := s.runtimeConcurrencySetting(); err == nil {
					view.ConcurrencyLimit = policy.ConcurrencyFor(model.TaskConcurrencyAgent)
				}
				view.DocumentTotal, view.AssetTotal = len(unifiedPlanSections)+1, len(m.Plan.Assets)
				view.TotalPages = len(m.Plan.Assets) + len(unifiedPlanSections) + 1
			}
			view.ProcessedPages = len(rows)
			if m.Plan.Version >= 2 {
				canvas, e := s.repo.CanvasProjectForUser(userID, job.CanvasID)
				if e == nil {
					if doc, e := creationDocument(canvas.PayloadJSON); e == nil {
						next := productionPlanNextAction(m, doc, rows)
						view.Phase, view.PhaseLabel, view.CurrentItem = stringValue(next["phase"]), stringValue(next["phaseLabel"]), stringValue(next["name"])
						view.InventoryComplete = productionPlanArtifactValid(m, doc, rows, "inventory")
						report := productionOrderedPlanCoverage(m, doc, rows)
						view.ProcessedPages = report["validArtifactCount"].(int)
						view.Validated = job.Validated && report["valid"] == true
						for _, artifact := range rows {
							if !productionPlanArtifactValid(m, doc, rows, artifact.Key) {
								continue
							}
							if _, section := planSection(artifact.Key); section {
								view.DocumentCount++
							} else {
								view.AssetCount++
							}
						}
					}
				}
			}
		}
	}
	view.WaitingForSharedFacts, _ = s.productionSharedPredecessor(userID, runID, state.Request.CanvasID)
	return view
}

// Pausing stops dispatch at the next model boundary. It never aborts a billed
// upstream response or marks a cancelled call as a resumable pause.
func (s *Service) waitProductionAgentBoundary(ctx context.Context, userID, runID string) error {
	for {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		state, err := cloudAgentDecode(run)
		if err != nil {
			return err
		}
		if cloudAgentRunTerminal(run.Status) {
			return context.Canceled
		}
		if state.Request.Production == nil {
			return nil
		}
		waiting, err := s.productionSharedPredecessor(userID, runID, state.Request.CanvasID)
		if err != nil {
			return err
		}
		if !state.ProductionPaused && !waiting {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
}

func (s *Service) productionSharedPredecessor(userID, runID, canvasID string) (bool, error) {
	job, err := s.repo.ProductionAgentJob(userID, runID)
	if err != nil {
		return false, err
	}
	var current productionManifest
	if err = json.Unmarshal([]byte(job.ManifestJSON), &current); err != nil {
		return false, err
	}
	needed := map[string]bool{}
	if current.Storyboard != nil {
		page, err := s.repo.ProductionAgentPage(userID, current.Storyboard.BriefPageID)
		if err != nil {
			return false, err
		}
		if page.Processed {
			return false, nil
		}
		needed[page.ID] = true
	}
	for _, source := range current.Sources {
		if current.Storyboard == nil && source.Step == "story.body" {
			for _, id := range source.Pages {
				page, err := s.repo.ProductionAgentPage(userID, id)
				if err != nil {
					return false, err
				}
				if !page.Processed {
					needed[id] = true
				}
			}
		}
	}
	if len(needed) == 0 {
		return false, nil
	}
	jobs, err := s.repo.ActiveProductionAgentJobs(userID, canvasID)
	if err != nil {
		return false, err
	}
	for _, earlier := range jobs {
		if earlier.RunID == runID {
			break
		}
		if earlier.CreatedAt.After(job.CreatedAt) {
			break
		}
		execution, err := s.repo.CloudAgent(userID, earlier.RunID)
		if err != nil {
			return false, err
		}
		state, err := cloudAgentDecode(execution)
		if err != nil {
			continue
		}
		if state.ProductionPaused && state.ActiveTaskID == "" {
			continue
		}
		var m productionManifest
		if err = json.Unmarshal([]byte(earlier.ManifestJSON), &m); err != nil {
			return false, err
		}
		if m.Storyboard != nil {
			if needed[m.Storyboard.BriefPageID] {
				return true, nil
			}
			continue
		}
		for _, source := range m.Sources {
			for _, id := range source.Pages {
				if needed[id] {
					return true, nil
				}
			}
		}
	}
	return false, nil
}

func productionStepLimit(state *cloudAgentRuntime) int {
	return cloudAgentStepLimit(state.Request)
}

func (s *Service) ControlProductionAgent(userID, runID, action string, ceilings ...int) error {
	task, err := s.repo.TaskForUser(userID, runID)
	if err != nil {
		return err
	}
	if task.RemovedAt != nil {
		return BadAuthRequest("对应节点已删除，制作任务已移除")
	}
	if action != "pause" && action != "resume" {
		return BadAuthRequest("仅支持 pause 或 resume")
	}
	for attempt := 0; attempt < 4; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		state, err := cloudAgentDecode(run)
		if err != nil {
			return err
		}
		if state.Request.Production == nil {
			return BadAuthRequest("当前不是制作 Agent 作业")
		}
		if cloudAgentRunTerminal(run.Status) && run.Status != "failed" {
			return BadAuthRequest("该作业已结束，请新建版本")
		}
		if action == "pause" && run.Status == "failed" {
			return BadAuthRequest("失败作业已停止")
		}
		if action == "resume" && run.Status == "failed" && state.ActiveTaskID != "" {
			task, err := s.repo.TaskForUser(userID, state.ActiveTaskID)
			if err != nil {
				return err
			}
			if task.Status == model.TaskStatusFailed {
				if task.ProviderCancelStatus == model.ProviderCancelStatusRequested || task.ProviderCancelStatus == model.ProviderCancelStatusUncertain {
					return BadAuthRequest("原调用上游状态待确认，未重新提交")
				}
				if err := s.taskBilling().CheckRetryEligibility(task.BillingOrderID); err != nil {
					return err
				}
				for key, id := range state.ProductionModelReceipts {
					if id == task.ID {
						delete(state.ProductionModelReceipts, key)
					}
				}
				state.ActiveTaskID = ""
			}
		}
		if action == "resume" && run.Status == "failed" {
			for key, work := range state.ProductionParallel {
				if work.TaskID != "" {
					task, err := s.repo.TaskForUser(userID, work.TaskID)
					if err != nil {
						return err
					}
					if !cloudAgentTaskTerminal(task.Status) {
						continue
					}
					if task.ProviderCancelStatus == model.ProviderCancelStatusRequested || task.ProviderCancelStatus == model.ProviderCancelStatusUncertain {
						return BadAuthRequest("并发调用上游状态待确认，未重新提交")
					}
					if task.Status != model.TaskStatusSucceeded {
						if err := s.taskBilling().CheckRetryEligibility(task.BillingOrderID); err != nil {
							return err
						}
					}
					if task.Status == model.TaskStatusSucceeded && work.Error == rejectedStoryboardToolMessage {
						_, manifest, _, err := productionLoad(s.repo, run, &state)
						if err != nil {
							return err
						}
						if manifest.Storyboard != nil {
							continue
						}
					}
					if work.Error == "" && task.Status == model.TaskStatusSucceeded {
						continue
					}
				}
				work.TaskID, work.Error, work.Attempts, work.RetryAt = "", "", 0, 0
				state.ProductionParallel[key] = work
			}
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			if action == "resume" && current.Status == "failed" {
				if _, _, _, err := productionLoad(repo, current, &state); err != nil {
					return err
				}
				if state.ActiveTaskID != "" {
					task, err := repo.TaskForUser(userID, state.ActiveTaskID)
					if err != nil {
						return err
					}
					if task.Status != model.TaskStatusSucceeded {
						return BadAuthRequest("模型调用仍需核对，请先在任务中心确认原调用状态；未重新发起收费请求")
					}
				}
				current.Status = "running"
				current.FailureMessage = ""
				state.LastError = ""
				state.ProductionRepairs = 0
				for name := range state.ToolRepairs {
					if strings.HasPrefix(name, "production_") {
						delete(state.ToolRepairs, name)
					}
				}
				state.ProductionProgressStep = state.Step
				state.PiResumePrompt = "继续当前制作作业。以当前持久检查点的 nextAction 和本任务工具为准，沿用已保存文稿与当前版本材料，完成未完成项及对应覆盖检查。检查点已提供的来源无需重复读取，不能反复查询未变化的进度或重述启动计划。任务按实际产出及覆盖检查判断完成；保留正常计费与余额校验。"
			}
			state.ProductionPaused = action == "pause"
			state.event(runID, "production_control", map[string]any{"action": action, "maxSteps": productionStepLimit(&state), "step": state.Step, "text": map[string]string{"pause": "已请求暂停，将在模型调用边界停止", "resume": "继续制作任务，复用已保存进度"}[action]})
			return cloudAgentSave(current, &state)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		if err == nil && action == "resume" {
			s.projectProductionAgentStatus(userID, runID)
			if run.Status == "failed" {
				s.resumeCloudAgentPi(userID, runID)
			} else {
				s.startCloudAgentPi(userID, runID)
			}
		}
		return err
	}
	return repository.ErrCreationConflict
}

// Run status is authoritative. Projection failures never undo cancellation or
// failure recording; a later control operation may repair the display.
func (s *Service) projectProductionAgentStatus(userID, runID string) {
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return
	}
	state, err := cloudAgentDecode(run)
	if err != nil || state.Request.Production == nil || run.Status == "completed" {
		return
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	_ = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		canvas, err := repo.CanvasProjectForUser(userID, state.Request.CanvasID)
		if err != nil {
			return err
		}
		doc, err := creationDocument(canvas.PayloadJSON)
		if err != nil {
			return err
		}
		node := productionNode(doc, state.Request.Production.TargetNodeID)
		if node == nil || stringValue(node["parentId"]) == "" || productionNode(doc, stringValue(node["parentId"])) == nil {
			return nil
		}
		data := productionWorkflow(node)
		agent, _ := data["productionAgent"].(map[string]any)
		if agent["runId"] != runID {
			return nil
		}
		meta, _ := node["metadata"].(map[string]any)
		meta["status"], meta["taskStage"] = "loading", "制作 Agent 正在执行"
		delete(meta, "error")
		delete(meta, "errorDetails")
		if current.Status == "failed" || current.Status == "cancelled" {
			meta["status"], meta["taskStage"] = "error", "制作 Agent 已停止"
			meta["errorDetails"] = current.FailureMessage
			if current.Status == "cancelled" {
				meta["errorDetails"] = "任务已取消，已保存产物保留"
			}
		}
		before := canvas.PayloadJSON
		if err := saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
			return err
		}
		if err := emitCloudAgentCanvasChange(repo, runID, &state, cloudAgentMutationInput{UserID: userID, CanvasID: canvas.ID, Operation: "production_status", BeforeJSON: before}); err != nil {
			return err
		}
		return cloudAgentSave(current, &state)
	})
}

func (s *Service) productionAgentRepair(userID, runID string) error {
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return err
	}
	return s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		state.ProductionRepairs++
		return cloudAgentSave(current, &state)
	})
}
