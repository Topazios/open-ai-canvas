package app

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type ProductionAgentProgress struct {
	MaxSteps              int    `json:"maxSteps"`
	TargetNodeID          string `json:"targetNodeId"`
	Paused                bool   `json:"paused"`
	WaitingForBoundary    bool   `json:"waitingForBoundary"`
	ProcessedPages        int    `json:"processedPages"`
	TotalPages            int    `json:"totalPages"`
	ArtifactCount         int    `json:"artifactCount"`
	Validated             bool   `json:"validated"`
	WaitingForSharedFacts bool   `json:"waitingForSharedFacts"`
}

func (s *Service) productionAgentProgress(userID, runID string, state *cloudAgentRuntime) *ProductionAgentProgress {
	if state.Request.Production == nil {
		return nil
	}
	view := &ProductionAgentProgress{MaxSteps: productionStepLimit(state), TargetNodeID: state.Request.Production.TargetNodeID, Paused: state.ProductionPaused, WaitingForBoundary: state.ProductionPaused && state.ActiveTaskID != ""}
	job, err := s.repo.ProductionAgentJob(userID, runID)
	if err != nil {
		return view
	}
	var m productionManifest
	if json.Unmarshal([]byte(job.ManifestJSON), &m) != nil {
		return view
	}
	_, done, total, err := productionFacts(s.repo, userID, m)
	if err == nil {
		view.ProcessedPages, view.TotalPages = done, total
	}
	if rows, err := s.repo.ProductionAgentArtifacts(userID, runID); err == nil {
		view.ArtifactCount = len(rows)
	}
	view.Validated = job.Validated
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
	for _, source := range current.Sources {
		if source.Step == "story.body" {
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
				state.ProductionProgressStep = state.Step
				state.PiResumePrompt = "继续当前制作作业。先查询 production_status 的持久记录，复用已处理事实和已写入资产，针对遗漏修复并通过 production_check；不要重复已完成工作。任务不再受旧调用次数和任务积分预算限制，以实际产出及覆盖检查判断完成。每批查询事实后先保存或增量修订资产，再按 nextOffset 继续，不能反复查询 offset=0。"
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
