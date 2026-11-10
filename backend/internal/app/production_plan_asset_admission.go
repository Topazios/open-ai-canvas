package app

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Admission commits containers, known content targets and execution intent
// together. Unknown inventories are extracted before their targets are created.
func (s *Service) admitProductionAssetKinds(userID, runID string, kinds []string, selection ProductionAssetModelSelection) error {
	selectedKinds := map[string]bool{}
	for _, kind := range kinds {
		if !slices.Contains(productionPlanGroupKinds, kind) {
			return BadAuthRequest("未知资产类别：" + kind)
		}
		selectedKinds[kind] = true
	}
	if len(selectedKinds) == 0 {
		return BadAuthRequest("请选择要生成的资产类别")
	}
	if len([]rune(strings.TrimSpace(selection.Instruction))) > 2000 || (selection.ReasoningEffort != "" && !selection.ReasoningEffort.valid()) {
		return BadAuthRequest("资产补充要求不能超过 2000 个字符，推理强度必须是 low、medium 或 high")
	}
	task, err := optionalTaskForUser(s.repo, userID, runID)
	if err != nil {
		return err
	}
	if err := s.ensureProductionRunActive(userID, task, "对应节点已删除，制作任务已移除"); err != nil {
		return err
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	// Resolve model routing outside the canvas transaction and storage lock.
	probe, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return err
	}
	validated, err := cloudAgentDecode(probe)
	if err != nil {
		return err
	}
	if productionAssetModelSelectionProvided(selection) {
		if err := s.applyProductionAssetModelSelection(s.repo, &validated, selection); err != nil {
			return err
		}
	}
	for attempt := 0; attempt < 6; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 40 * time.Millisecond)
		}
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		resume, admitted := false, false
		s.storageMu.Lock()
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			state, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			if current.CleanupPending || state.Request.Production == nil {
				return BadAuthRequest("任务已移除或不是制作任务")
			}
			_, m, doc, err := productionLoad(repo, current, &state, productionLoadForAssetGeneration)
			if err != nil {
				return err
			}
			if m.Plan == nil || m.Plan.Version < 2 {
				return BadAuthRequest("当前任务不是可分阶段执行的制作方案")
			}
			if seen, err := productionAssetRequestSeen(m.Plan, selection, kinds, true); seen || err != nil {
				return err
			}
			rows, err := repo.ProductionAgentArtifacts(userID, runID)
			if err != nil {
				return err
			}
			if !productionPlanStoryPresent(m, doc, rows) {
				return BadAuthRequest("请先完成故事总纲，再创建资产")
			}
			tasks, err := repo.TaskStatesForUser(userID, productionPlanTaskIDs(&state))
			if err != nil {
				return err
			}
			taskStates := map[string]model.TaskStatus{}
			live := false
			for _, task := range tasks {
				taskStates[task.ID] = task.Status
				live = live || !cloudAgentTaskTerminal(task.Status)
			}
			active := (current.Status == "running" || current.Status == "queued") && !state.ProductionPaused &&
				(s.productionPlanPiRunnerActive(runID) || live)
			if active && selection.Regenerate {
				return productionPlanConflict("当前资产任务仍在执行，请结束后再主动生成新版")
			}
			if live && !active {
				return productionPlanConflict("原调用仍在执行，请等待完成收尾后再创建资产")
			}
			resume = !active
			registered := map[string]bool{}
			for _, item := range m.Plan.Assets {
				registered[productionPlanGroupKind(item)] = true
			}
			missing := false
			for kind := range selectedKinds {
				missing = missing || !registered[kind]
			}
			if active && (!m.Plan.AssetsStarted || missing) {
				// A repeated click during extraction is an acknowledgement, not a
				// second inventory call or a replacement of the running model.
				if len(m.Plan.SelectedAssetKinds) > 0 {
					contained := true
					for kind := range selectedKinds {
						contained = contained && slices.Contains(m.Plan.SelectedAssetKinds, kind)
					}
					if contained {
						return nil
					}
				}
				return productionPlanConflict("当前制作任务仍在运行，请等待清单拆分完成后再追加资产")
			}
			if missing && m.Plan.Version < 5 {
				return BadAuthRequest("当前制作方案版本过旧，无法分阶段提取资产，请更新制作方案")
			}
			if _, err := productionRepairPlanSummaryCheckpoint(repo, current, &state, m, doc, policy); err != nil {
				return err
			}
			if !active && productionAssetModelSelectionProvided(selection) {
				state.Request.Model, state.Request.LogicalModelID = validated.Request.Model, validated.Request.LogicalModelID
				state.Request.ChannelID, state.Request.ChannelModelKey = validated.Request.ChannelID, validated.Request.ChannelModelKey
			}
			if !active && selection.ReasoningEffort != "" {
				state.Request.ReasoningEffort = selection.ReasoningEffort
			}
			// Missing pointer cleanup is authorized by this explicit request only.
			rows, err = productionResetMissingPlanAssets(repo, current, &state, m, doc, rows, policy)
			if err != nil {
				return err
			}
			if missing {
				m.Plan.AssetsStarted, m.Plan.PlansStarted = false, true
				m.Plan.SelectedAssetKeys = nil
				m.Plan.SelectedPlanKeys = []string{"inventory"}
				m.Plan.SelectedAssetKinds = nil
				for _, kind := range productionPlanGroupKinds {
					if selectedKinds[kind] {
						m.Plan.SelectedAssetKinds = append(m.Plan.SelectedAssetKinds, kind)
					}
				}
				state.ProductionAssetExtractionSelection = &selection
				delete(state.ProductionParallel, "inventory")
				if state.ProductionParallel == nil {
					state.ProductionParallel = map[string]productionParallelWork{}
				}
				state.ProductionParallel["inventory"] = productionParallelWork{
					Key: "inventory", Name: "所选类别资产清单",
					Dependencies:          productionParallelDependencyHash(m, rows, "inventory"),
					GenerationInstruction: selection.Instruction, GenerationReasoningEffort: selection.ReasoningEffort,
					GenerationModel: selection.Model, GenerationLogicalModelID: selection.LogicalModelID,
					GenerationChannelID: selection.ChannelID, GenerationChannelModelKey: selection.ChannelModelKey,
				}
				state.PiResumePrompt = "先根据已保存总纲拆分所选类别的完整资产清单。清单保存后系统创建对应节点，再生成各项资产内容；不要重写总纲或其他制作规范。"
			} else {
				m.Plan.SelectedAssetKinds = nil
				state.ProductionAssetExtractionSelection = nil
				m.Plan.AssetsStarted = true
				// Validate only the requested categories; unrelated assets and
				// their dependency graphs must not delay admission.
				progress := productionPlanAssetProgress(m, doc, rows, &state, taskStates, active, selectedKinds)
				keys := productionPlanAssetKeysForKinds(progress, selectedKinds)
				if selection.Regenerate {
					for _, item := range progress {
						if item.Status == "complete" {
							keys = append(keys, item.Key)
						}
					}
				}
				if len(keys) == 0 {
					return nil
				}
				if !active {
					m.Plan.SelectedAssetKeys = []string{}
				} else if m.Plan.SelectedAssetKeys == nil {
					for _, item := range m.Plan.Assets {
						m.Plan.SelectedAssetKeys = append(m.Plan.SelectedAssetKeys, item.Key)
					}
				}
				for _, key := range keys {
					if !slices.Contains(m.Plan.SelectedAssetKeys, key) {
						m.Plan.SelectedAssetKeys = append(m.Plan.SelectedAssetKeys, key)
					}
					delete(state.ProductionParallel, key)
					for _, row := range rows {
						if row.Key == key && !slices.Contains(m.Plan.NewVersionAssetKeys, key) {
							m.Plan.NewVersionAssetKeys = append(m.Plan.NewVersionAssetKeys, key)
						}
					}
				}
				if err := applyProductionAssetGenerationSettings(&state, m, rows, keys, &selection); err != nil {
					return err
				}
				state.PiResumePrompt = "按所选资产清单创建对应内容节点，再并发生成未完成的资产内容；复用已保存成果，不扩展到未选类别。"
			}
			if !active {
				if state.ActiveTaskID != "" {
					if task, err := optionalTaskForUser(repo, userID, state.ActiveTaskID); err != nil {
						return err
					} else if task != nil && !cloudAgentTaskTerminal(task.Status) {
						return productionPlanConflict("原调用仍在执行，请等待完成后重试")
					}
					for key, id := range state.ProductionModelReceipts {
						if id == state.ActiveTaskID {
							delete(state.ProductionModelReceipts, key)
						}
					}
					state.ActiveTaskID = ""
				}
				current.Status, current.FailureMessage = "running", ""
				state.ProductionPaused, state.LastError, state.ProductionRepairs = false, "", 0
				state.ProductionProgressStep = state.Step
				for name := range state.ToolRepairs {
					if strings.HasPrefix(name, "production_") {
						delete(state.ToolRepairs, name)
					}
				}
			}
			canvas, err := repo.CanvasProjectForUser(userID, state.Request.CanvasID)
			if err != nil {
				return err
			}
			before := canvas.PayloadJSON
			productionRecordAssetRequest(m.Plan, selection, kinds, true)
			productionAdmitAssetTargets(m, doc, rows, runID, state.Request.Production.TargetNodeID, selectedKinds)
			encoded, err := json.Marshal(m)
			if err != nil {
				return err
			}
			if err := repo.UpdateProductionAgentManifest(userID, runID, string(encoded)); err != nil {
				return err
			}
			if err := repo.ValidateProductionAgentJob(userID, runID, false); err != nil {
				return err
			}
			if err := saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
				return err
			}
			if err := emitCloudAgentCanvasChange(repo, runID, &state, cloudAgentMutationInput{UserID: userID, CanvasID: canvas.ID, Operation: "production_asset_containers", BeforeJSON: before}); err != nil {
				return err
			}
			state.event(runID, "production_control", map[string]any{"action": "generate_assets", "assetKinds": kinds, "text": "资产容器已创建，后台将整理清单、创建内容节点并生成资产"})
			admitted = true
			return cloudAgentSave(current, &state)
		})
		s.storageMu.Unlock()
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		if err == nil && admitted {
			if resume {
				s.resumeCloudAgentPi(userID, runID)
			} else {
				s.startCloudAgentPi(userID, runID)
			}
		}
		return err
	}
	return productionPlanConflict("资产任务数据刚被更新，请稍后重试")
}
