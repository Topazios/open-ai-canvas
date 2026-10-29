package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// productionPlanConflict reports a duplicate-submit guard as a readable 409.
// These guards stay because ignoring them would double-bill one batch.
func productionPlanConflict(message string) *AppError {
	return NewAppError(http.StatusConflict, message)
}

// productionAssetStep tags unclassified errors with the step that produced them
// so a conflict can be located from logs. Readable AppErrors pass through untouched.
func productionAssetStep(label string, err error) error {
	if err == nil {
		return nil
	}
	var appErr *AppError
	if errors.As(err, &appErr) {
		return err
	}
	return fmt.Errorf("start assets %s: %w", label, err)
}

// optionalTaskForUser treats a missing historical task as "no previous call".
func optionalTaskForUser(repo *repository.Repository, userID, id string) (*model.Task, error) {
	task, err := repo.TaskForUser(userID, id)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return task, err
}

func (s *Service) GenerateProductionPlanSections(userID, runID string, keys []string) error {
	if len(keys) == 0 {
		keys = []string{"inventory", "visual", "direction", "generation"}
	}
	allowed := map[string]bool{"inventory": true, "visual": true, "direction": true, "generation": true}
	selected := []string{}
	for _, key := range keys {
		if !allowed[key] {
			return BadAuthRequest("未知制作方案项：" + key)
		}
		if !slices.Contains(selected, key) {
			selected = append(selected, key)
		}
	}
	slices.Sort(selected)
	for attempt := 0; attempt < 6; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 40 * time.Millisecond)
		}
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
		job, m, doc, err := productionLoad(s.repo, run, &state)
		if err != nil {
			return err
		}
		if m.Plan == nil || m.Plan.Version < 5 {
			return BadAuthRequest("当前制作方案不支持分阶段生成")
		}
		artifacts, err := s.repo.ProductionAgentArtifacts(userID, runID)
		if err != nil {
			return err
		}
		if run.Status != "completed" && run.Status != "failed" && run.Status != "cancelled" && run.Status != "waiting_user" && !state.ProductionPaused {
			return productionPlanConflict("当前任务仍在运行，请等待结束后再生成")
		}
		// A completed story-stage checkpoint can remain after the parallel
		// runner parks at the manual boundary. It is safe to discard only when
		// its receipt is already valid; real active tasks still block startup.
		for key, work := range state.ProductionParallel {
			selectedForRetry := slices.Contains(selected, key)
			artifactValid := productionPlanArtifactValid(m, doc, artifacts, key)
			var task *model.Task
			if work.TaskID != "" {
				loadedTask, taskErr := optionalTaskForUser(s.repo, userID, work.TaskID)
				if taskErr != nil {
					return taskErr
				}
				if loadedTask != nil {
					task = loadedTask
					if !cloudAgentTaskTerminal(loadedTask.Status) {
						return productionPlanConflict("当前调用尚未完成收尾，请稍后再试")
					}
					if !artifactValid && loadedTask.Status == model.TaskStatusSucceeded && work.Error == "" {
						return productionPlanConflict("当前模型响应尚未处理完成，请先继续任务完成收尾")
					}
				}
			}
			if artifactValid {
				delete(state.ProductionParallel, key)
				continue
			}
			if selectedForRetry && (work.Error != "" || work.QuietHold || (task != nil && (task.Status == model.TaskStatusFailed || task.Status == model.TaskStatusCancelled))) {
				if task != nil {
					if task.ProviderCancelStatus == model.ProviderCancelStatusRequested || task.ProviderCancelStatus == model.ProviderCancelStatusUncertain {
						return productionPlanConflict("原调用上游状态待确认，未重新提交")
					}
				}
				delete(state.ProductionParallel, key)
				continue
			}
		}
		if slices.Contains(selected, "inventory") && len(m.Plan.Assets) == 0 && len(m.Plan.SelectedAssetKinds) == 0 {
			// An empty inventory can be structurally valid but leaves no selectable
			// assets. An explicit recovery request reopens only its receipt, keeping
			// the visible node and every other plan document intact.
			for i := len(artifacts) - 1; i >= 0; i-- {
				artifact := artifacts[i]
				if artifact.Key != "inventory" {
					continue
				}
				if err := s.repo.DeleteProductionAgentArtifact(userID, runID, artifact.Key, artifact.NodeID); err != nil {
					return err
				}
				artifacts = append(artifacts[:i], artifacts[i+1:]...)
			}
		}
		if state.ActiveTaskID != "" {
			task, taskErr := optionalTaskForUser(s.repo, userID, state.ActiveTaskID)
			if taskErr != nil {
				return taskErr
			}
			if task != nil && !cloudAgentTaskTerminal(task.Status) {
				return productionPlanConflict("当前调用尚未完成收尾，请稍后再试")
			}
			state.ActiveTaskID = ""
		}
		m.Plan.PlansStarted = true
		m.Plan.SelectedPlanKeys = selected
		encoded, _ := json.Marshal(m)
		if err := s.repo.UpdateProductionAgentManifest(userID, runID, string(encoded)); err != nil {
			return err
		}
		if err := s.repo.ValidateProductionAgentJob(userID, runID, false); err != nil {
			return err
		}
		for _, key := range selected {
			delete(state.ProductionParallel, key)
		}
		state.ProductionPaused, state.LastError = false, ""
		state.PiResumePrompt = "用户已明确启动其他制作方案。每个选定项分别单次生成并保存，按持久任务检查点完成当前选定范围后结束；不得查询、纠正、修复、分析或续写其他方案。"
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
			current.Status, current.FailureMessage = "running", ""
			return cloudAgentSave(current, &state)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			log.Printf("sections conflict: run=%s attempt=%d err=%v", runID, attempt, err)
			continue
		}
		if err != nil {
			return err
		}
		s.projectProductionAgentStatus(userID, runID)
		s.resumeCloudAgentPi(userID, runID)
		_ = job
		return nil
	}
	return productionPlanConflict("资产任务数据刚被更新，请稍后重试")
}

// Only an explicit user control request crosses the plan/asset boundary.
// The manifest makes this authorization durable across retries and restarts.
func productionPlanAssetSelected(m productionManifest, key string) bool {
	return m.Plan != nil && m.Plan.AssetsStarted && (m.Plan.SelectedAssetKeys == nil || slices.Contains(m.Plan.SelectedAssetKeys, key))
}

type ProductionAssetModelSelection struct {
	Model           string          `json:"model"`
	LogicalModelID  string          `json:"logicalModelId,omitempty"`
	ChannelID       string          `json:"channelId,omitempty"`
	ChannelModelKey string          `json:"channelModelKey,omitempty"`
	ReasoningEffort ReasoningEffort `json:"reasoningEffort,omitempty"`
	Instruction     string          `json:"instruction,omitempty"`
	ContinueAppend  bool            `json:"continueAppend,omitempty"`
}

func (s *Service) GenerateProductionPlanAssets(userID, runID string, keys []string, selections ...ProductionAssetModelSelection) error {
	task, err := optionalTaskForUser(s.repo, userID, runID)
	if err != nil {
		return err
	}
	if task != nil && task.RemovedAt != nil {
		return BadAuthRequest("对应节点已删除，制作任务已移除")
	}
	if err := s.prepareProductionPlanAssetGeneration(userID, runID, keys); err != nil {
		return err
	}
	if err := s.settleCompletedProductionPlanAssetCalls(userID, runID, keys); err != nil {
		return err
	}
	if len(selections) == 0 || productionAssetModelSelectionEmpty(selections[0]) {
		return s.startProductionPlanAssets(userID, runID, keys...)
	}
	return s.startProductionPlanAssetsWithModel(userID, runID, &selections[0], keys...)
}

// Explicit asset generation owns the recovery boundary. Reconcile stale group
// bindings before settling successful responses, whose normal commit path must
// continue to reject deleted or repurposed groups.
func (s *Service) prepareProductionPlanAssetGeneration(userID, runID string, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	lastConflict := ""
	for attempt := 0; attempt < 6; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 40 * time.Millisecond)
		}
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		s.storageMu.Lock()
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			state, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			_, manifest, doc, err := productionLoad(repo, current, &state, productionLoadForAssetGeneration)
			if err != nil {
				return err
			}
			if manifest.Plan == nil || manifest.Plan.Version < 2 {
				return BadAuthRequest("当前任务不是可分阶段执行的制作方案")
			}
			for _, key := range keys {
				if productionPlanItem(manifest, key) == nil {
					return BadAuthRequest("资产不属于当前清单：" + key)
				}
			}
			rows, err := repo.ProductionAgentArtifacts(userID, runID)
			if err != nil {
				return err
			}
			checkpointRepaired := productionRepairUnsubmittedPropCheckpoints(&state, manifest, rows, keys)
			before, err := json.Marshal(manifest)
			if err != nil {
				return err
			}
			if _, err := productionResetMissingPlanAssets(repo, current, &state, manifest, doc, rows, policy); err != nil {
				return err
			}
			after, err := json.Marshal(manifest)
			if err != nil {
				return err
			}
			manifestChanged := !bytes.Equal(before, after)
			if manifestChanged {
				if err := repo.UpdateProductionAgentManifest(userID, runID, string(after)); err != nil {
					return err
				}
			}
			if manifestChanged || checkpointRepaired {
				return cloudAgentSave(current, &state)
			}
			return nil
		})
		s.storageMu.Unlock()
		if errors.Is(err, repository.ErrCreationConflict) {
			lastConflict = err.Error()
			log.Printf("prepare assets conflict: run=%s attempt=%d err=%v", runID, attempt, err)
			continue
		}
		return err
	}
	// Preparation only reconciles stale pointers. The start step repeats the
	// same reconciliation inside its own mutation, so a lost race here must
	// not block creating the asset tasks.
	log.Printf("prepare assets conflict exhausted, continuing: run=%s last=%s", runID, lastConflict)
	return nil
}

// GenerateProductionPlanAssetKinds keeps the browser request at category
// scope. The canonical inventory and artifact state determine which members
// still need work; the Agent then receives the complete registered inventory.
func (s *Service) GenerateProductionPlanAssetKinds(userID, runID string, kinds []string, selection ProductionAssetModelSelection) error {
	allowed := map[string]bool{"character": true, "environment": true, "prop": true, "sound": true, "special": true}
	selectedKinds := map[string]bool{}
	for _, kind := range kinds {
		if !allowed[kind] {
			return BadAuthRequest("未知资产类别：" + kind)
		}
		selectedKinds[kind] = true
	}
	if len(selectedKinds) == 0 {
		return BadAuthRequest("请选择要生成的资产类别")
	}
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return err
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		return err
	}
	_, manifest, doc, err := productionLoad(s.repo, run, &state, productionLoadForAssetGeneration)
	if err != nil {
		return err
	}
	if manifest.Plan == nil {
		return BadAuthRequest("当前任务不是制作方案")
	}
	rows, err := s.repo.ProductionAgentArtifacts(userID, runID)
	if err != nil {
		return err
	}
	taskStates := map[string]model.TaskStatus{}
	if tasks, e := s.repo.TaskStatesForUser(userID, productionPlanTaskIDs(&state)); e == nil {
		for _, task := range tasks {
			taskStates[task.ID] = task.Status
		}
	}
	active := run.Status == "running" || run.Status == "queued"
	progress := productionPlanAssetProgress(manifest, doc, rows, &state, taskStates, active)
	keys := productionPlanAssetKeysForKinds(progress, selectedKinds)
	registeredKinds := map[string]bool{}
	for _, asset := range manifest.Plan.Assets {
		registeredKinds[asset.Kind] = true
	}
	missingKinds := []string{}
	for kind := range selectedKinds {
		if !registeredKinds[kind] {
			missingKinds = append(missingKinds, kind)
		}
	}
	if len(missingKinds) > 0 {
		if manifest.Plan.Version < 5 {
			return BadAuthRequest("当前制作方案版本过旧，无法分阶段提取资产，请更新制作方案")
		}
		if active {
			return productionPlanConflict("当前制作任务仍在运行，请等待结束后再生成资产")
		}
		slices.Sort(missingKinds)
		manifest.Plan.SelectedAssetKinds = missingKinds
		encoded, marshalErr := json.Marshal(manifest)
		if marshalErr != nil {
			return marshalErr
		}
		if err := s.repo.UpdateProductionAgentManifest(userID, runID, string(encoded)); err != nil {
			return err
		}
		return s.GenerateProductionPlanSections(userID, runID, []string{"inventory"})
	}
	if len(keys) == 0 {
		// Everything in these categories is either done or already in flight.
		// Done members get a new version; in-flight members are never duplicated.
		for _, item := range progress {
			if selectedKinds[item.Kind] && item.Status == "complete" {
				keys = append(keys, item.Key)
			}
		}
		if len(keys) == 0 {
			return productionPlanConflict("此类资产正在生成，请等待结果")
		}
	}
	return s.GenerateProductionPlanAssets(userID, runID, keys, selection)
}

func productionPlanAssetKeysForKinds(progress []ProductionPlanAssetProgress, kinds map[string]bool) []string {
	keys := []string{}
	for _, item := range progress {
		if !kinds[item.Kind] {
			continue
		}
		switch item.Status {
		case "complete", "queued", "running", "saving", "retrying":
			continue
		default:
			keys = append(keys, item.Key)
		}
	}
	return keys
}

func productionPlanTaskIDs(state *cloudAgentRuntime) []string {
	ids := []string{}
	if state.ActiveTaskID != "" {
		ids = append(ids, state.ActiveTaskID)
	}
	for _, key := range productionParallelKeys(state.ProductionParallel) {
		if id := state.ProductionParallel[key].TaskID; id != "" && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	return ids
}

func (s *Service) settleCompletedProductionPlanAssetCalls(userID, runID string, keys []string) error {
	selected := make(map[string]bool, len(keys))
	for _, key := range keys {
		selected[key] = true
	}
	if len(selected) == 0 {
		return nil
	}

	for attempt := 0; attempt < 8; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 40 * time.Millisecond)
		}
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		state, err := cloudAgentDecode(run)
		if err != nil {
			return err
		}
		settled := false
		for _, key := range productionParallelKeys(state.ProductionParallel) {
			if !selected[key] {
				continue
			}
			work := state.ProductionParallel[key]
			if work.TaskID == "" {
				continue
			}
			completed, err := s.repo.TaskForUser(userID, work.TaskID)
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			if err != nil {
				return err
			}
			if !cloudAgentTaskTerminal(completed.Status) {
				continue
			}
			if err := s.settleProductionParallel(userID, runID, work, completed, true); err != nil && !errors.Is(err, repository.ErrCreationConflict) {
				return err
			} else if err != nil {
				log.Printf("settle assets conflict: run=%s key=%s attempt=%d err=%v", runID, key, attempt, err)
			}
			settled = true
			break
		}
		if !settled {
			return nil
		}
	}
	// Settling finished calls is bookkeeping. The start step re-reads state, so
	// leftover work here must not block a new explicit asset generation.
	log.Printf("settle assets conflict exhausted, continuing: run=%s", runID)
	return nil
}

func productionAssetModelSelectionEmpty(selection ProductionAssetModelSelection) bool {
	return strings.TrimSpace(selection.Model) == "" &&
		strings.TrimSpace(selection.LogicalModelID) == "" &&
		strings.TrimSpace(selection.ChannelID) == "" &&
		strings.TrimSpace(selection.ChannelModelKey) == "" &&
		strings.TrimSpace(string(selection.ReasoningEffort)) == "" &&
		strings.TrimSpace(selection.Instruction) == "" &&
		!selection.ContinueAppend
}

func productionPlanAssetAppendAuthorized(selection *ProductionAssetModelSelection) bool {
	return selection != nil && selection.ContinueAppend
}

func productionPlanAssetSelectionIsIdempotent(manifest productionManifest, keys []string) bool {
	if manifest.Plan == nil || !manifest.Plan.AssetsStarted {
		return false
	}
	for _, key := range keys {
		if !slices.Contains(manifest.Plan.SelectedAssetKeys, key) {
			return false
		}
	}
	return true
}

const productionUnsubmittedPropValidationFailure = "工具执行失败，请检查输入或稍后重试"

func productionStaleUnsubmittedPropFailure(manifest productionManifest, artifacts []model.ProductionAgentArtifact, item productionPlanAsset, work productionParallelWork) bool {
	if item.Kind != "prop" || work.TaskID != "" || !work.QuietHold ||
		work.Error != productionUnsubmittedPropValidationFailure || work.Notice == nil ||
		work.Notice.Phase != "validation" || work.Notice.ErrorSource != "application" ||
		work.Notice.TaskSubmitted || work.Notice.SafeMessage != productionUnsubmittedPropValidationFailure {
		return false
	}
	dependenciesChanged := work.Dependencies != productionParallelDependencyHash(manifest, artifacts, item.Key)
	targetChanged := work.TargetHash != nil && *work.TargetHash != productionDocumentTargetHash(artifacts, item.Key)
	return dependenciesChanged || targetChanged
}

// Clear only this known legacy rejection after an explicit prop retry. The
// rejected call never created a task, so no billing or artifact receipt exists.
func productionRepairUnsubmittedPropCheckpoints(state *cloudAgentRuntime, manifest productionManifest, artifacts []model.ProductionAgentArtifact, keys []string) bool {
	if state == nil || manifest.Plan == nil || len(keys) == 0 {
		return false
	}
	requested := make(map[string]bool, len(keys))
	for _, key := range keys {
		requested[key] = true
	}
	changed := false
	for key, work := range state.ProductionParallel {
		if !requested[key] {
			continue
		}
		item := productionPlanItem(manifest, key)
		if item == nil || !productionStaleUnsubmittedPropFailure(manifest, artifacts, *item, work) {
			continue
		}
		delete(state.ProductionParallel, key)
		changed = true
	}
	return changed
}

func (s *Service) startProductionPlanAssets(userID, runID string, keys ...string) error {
	return s.startProductionPlanAssetsWithModel(userID, runID, nil, keys...)
}

func (s *Service) startProductionPlanAssetsWithModel(userID, runID string, selection *ProductionAssetModelSelection, keys ...string) error {
	if len(keys) == 0 {
		return BadAuthRequest("请先选择要生成或重试的资产")
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	lastConflict := ""
	for attempt := 0; attempt < 8; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * 40 * time.Millisecond)
		}
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		started := false
		appended := false
		fnRan := false
		s.storageMu.Lock()
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			fnRan = true
			state, err := cloudAgentDecode(current)
			if err != nil {
				return productionAssetStep("decode state", err)
			}
			active := (current.Status == "running" || current.Status == "queued") && !state.ProductionPaused &&
				(s.productionPlanPiRunnerActive(runID) || productionPlanHasLiveAssetCalls(repo, userID, &state))
			staleExecution := (current.Status == "running" || current.Status == "queued") &&
				!s.productionPlanPiRunnerActive(runID) && !productionPlanHasLiveAssetCalls(repo, userID, &state)
			previousRequest := state.Request
			if selection != nil && productionAssetModelSelectionProvided(*selection) {
				if err := s.applyProductionAssetModelSelection(repo, &state, *selection); err != nil {
					return productionAssetStep("apply model selection", err)
				}
				if active {
					state.Request = previousRequest
				}
			}
			var modes []productionLoadMode
			if !active {
				modes = append(modes, productionLoadForAssetGeneration)
			}
			_, m, doc, err := productionLoad(repo, current, &state, modes...)
			if err != nil {
				return productionAssetStep("load production", err)
			}
			if m.Plan == nil || m.Plan.Version < 2 {
				return BadAuthRequest("当前任务不是可分阶段执行的制作方案")
			}
			artifacts, err := repo.ProductionAgentArtifacts(userID, runID)
			if err != nil {
				return productionAssetStep("read artifacts", err)
			}
			selected := []string{}
			for _, key := range keys {
				if productionPlanItem(m, key) == nil {
					return BadAuthRequest("资产不属于当前清单：" + key)
				}
				if !slices.Contains(selected, key) {
					selected = append(selected, key)
				}
			}
			slices.Sort(selected)
			if active {
				// Other assets running never blocks this selection: it is appended
				// to the live batch and runs as its own task.
				appended, err = productionAppendPlanAssets(repo, current, &state, m, doc, artifacts, selected)
				if err != nil {
					return productionAssetStep("append assets", err)
				}
				return productionAssetStep("append settings", applyProductionAssetGenerationSettings(&state, m, artifacts, selected, selection))
			}
			if productionPlanHasLiveSelectedAssetCalls(repo, userID, &state, selected) {
				log.Printf("start assets: resubmitting over a live call: run=%s keys=%v", runID, selected)
			}
			retryableTerminalTask := false
			if state.ActiveTaskID != "" {
				task, err := optionalTaskForUser(repo, userID, state.ActiveTaskID)
				if err != nil {
					return productionAssetStep("read active task", err)
				}
				if task != nil {
					if !cloudAgentTaskTerminal(task.Status) || task.Status == model.TaskStatusSucceeded {
						log.Printf("start assets: dropping orphan active task: run=%s task=%s status=%s", runID, task.ID, task.Status)
					}
					retryableTerminalTask = task.Status == model.TaskStatusCancelled || task.Status == model.TaskStatusFailed
				}
				for key, id := range state.ProductionModelReceipts {
					if id == state.ActiveTaskID {
						delete(state.ProductionModelReceipts, key)
					}
				}
				state.ActiveTaskID = ""
			}
			for key, work := range state.ProductionParallel {
				if !slices.Contains(selected, key) {
					continue
				}
				if work.TaskID == "" {
					continue
				}
				task, err := optionalTaskForUser(repo, userID, work.TaskID)
				if err != nil {
					return productionAssetStep("read parallel task", err)
				}
				if task == nil {
					continue
				}
				// Live calls were rejected above. A terminal task whose result was never
				// settled is replaced by the new submission instead of blocking it.
				if task.Status == model.TaskStatusSucceeded && work.Error == "" {
					log.Printf("start assets: discarding unsettled result: run=%s key=%s task=%s", runID, key, work.TaskID)
				}
				if !slices.Contains(selected, work.Key) {
					continue
				}
				if task.ProviderCancelStatus == model.ProviderCancelStatusRequested || task.ProviderCancelStatus == model.ProviderCancelStatusUncertain {
					log.Printf("start assets: resubmitting despite unconfirmed upstream cancel: run=%s key=%s task=%s", runID, key, work.TaskID)
				}
				if task.Status != model.TaskStatusSucceeded {
					if slices.Contains(selected, work.Key) && (task.Status == model.TaskStatusCancelled || task.Status == model.TaskStatusFailed) {
						retryableTerminalTask = true
					}
				}
			}
			if current.Status != "completed" && current.Status != "failed" && current.Status != "cancelled" && current.Status != "waiting_user" && !state.ProductionPaused && !retryableTerminalTask && !staleExecution {
				log.Printf("start assets: continuing from status %s: run=%s", current.Status, runID)
			}
			m.Plan.AssetsStarted = true
			m.Plan.SelectedAssetKeys = selected
			artifacts, err = productionResetMissingPlanAssets(repo, current, &state, m, doc, artifacts, policy)
			if err != nil {
				return productionAssetStep("reset missing assets", err)
			}
			pending := len(selected)
			for _, key := range selected {
				delete(state.ProductionParallel, key)
				hasPriorReceipt := false
				for _, receipt := range artifacts {
					hasPriorReceipt = hasPriorReceipt || receipt.Key == key
				}
				if hasPriorReceipt && !slices.Contains(m.Plan.NewVersionAssetKeys, key) {
					m.Plan.NewVersionAssetKeys = append(m.Plan.NewVersionAssetKeys, key)
				}
			}
			if err := applyProductionAssetGenerationSettings(&state, m, artifacts, selected, selection); err != nil {
				return productionAssetStep("generation settings", err)
			}
			encoded, err := json.Marshal(m)
			if err != nil {
				return productionAssetStep("encode manifest", err)
			}
			if err := repo.UpdateProductionAgentManifest(userID, runID, string(encoded)); err != nil {
				return productionAssetStep("update manifest", err)
			}
			if err := repo.ValidateProductionAgentJob(userID, runID, false); err != nil {
				return productionAssetStep("validate job", err)
			}
			current.Status, current.FailureMessage = "running", ""
			state.ProductionPaused, state.LastError, state.ProductionRepairs = false, "", 0
			state.ProductionProgressStep = state.Step
			for name := range state.ToolRepairs {
				if strings.HasPrefix(name, "production_") {
					delete(state.ToolRepairs, name)
				}
			}
			state.PiResumePrompt = "用户已选择资产生成范围。只执行 selectedAssetKeys 中尚未完成的资产，复用已保存文稿和资产；所选资产各自依据已保存故事总纲独立生成，完成后结束，不补齐未选资产。"
			state.event(runID, "production_control", map[string]any{"action": "generate_assets", "assetKeys": selected, "text": fmt.Sprintf("已提交所选 %d 项资产，保留已有结果", pending)})
			if err := cloudAgentSave(current, &state); err != nil {
				return productionAssetStep("save run", err)
			}
			started = true
			return nil
		})
		s.storageMu.Unlock()
		if errors.Is(err, repository.ErrCreationConflict) {
			if fnRan {
				lastConflict = err.Error()
			} else {
				lastConflict = "run revision changed before update"
			}
			continue
		}
		if err == nil && started {
			s.projectProductionAgentStatus(userID, runID)
			s.resumeCloudAgentPi(userID, runID)
		} else if err == nil && appended {
			s.projectProductionAgentStatus(userID, runID)
			s.startCloudAgentPi(userID, runID)
		}
		return err
	}
	log.Printf("start assets conflict exhausted: run=%s last=%s", runID, lastConflict)
	return productionPlanConflict("资产任务数据刚被更新，请稍后重试")
}

func (s *Service) productionPlanPiRunnerActive(runID string) bool {
	if s == nil || runID == "" {
		return false
	}
	s.piRunnerMu.Lock()
	defer s.piRunnerMu.Unlock()
	_, active := s.piRunners[runID]
	return active
}

func productionAssetModelSelectionProvided(selection ProductionAssetModelSelection) bool {
	return strings.TrimSpace(selection.Model) != "" ||
		strings.TrimSpace(selection.LogicalModelID) != "" ||
		strings.TrimSpace(selection.ChannelID) != "" ||
		strings.TrimSpace(selection.ChannelModelKey) != ""
}

func productionPlanHasLiveAssetCalls(repo *repository.Repository, userID string, state *cloudAgentRuntime) bool {
	if state == nil {
		return false
	}
	if state.ActiveTaskID != "" {
		if task, err := repo.TaskForUser(userID, state.ActiveTaskID); err == nil && !cloudAgentTaskTerminal(task.Status) {
			return true
		}
	}
	for _, work := range state.ProductionParallel {
		if work.TaskID == "" {
			continue
		}
		if task, err := repo.TaskForUser(userID, work.TaskID); err == nil && !cloudAgentTaskTerminal(task.Status) {
			return true
		}
	}
	return false
}

func productionPlanHasLiveSelectedAssetCalls(repo *repository.Repository, userID string, state *cloudAgentRuntime, selected []string) bool {
	if state == nil {
		return false
	}
	for key, work := range state.ProductionParallel {
		if work.TaskID == "" || !slices.Contains(selected, key) {
			continue
		}
		if task, err := repo.TaskForUser(userID, work.TaskID); err == nil && !cloudAgentTaskTerminal(task.Status) {
			return true
		}
	}
	return false
}

func applyProductionAssetGenerationSettings(state *cloudAgentRuntime, manifest productionManifest, artifacts []model.ProductionAgentArtifact, keys []string, selection *ProductionAssetModelSelection) error {
	if selection == nil || state == nil {
		return nil
	}
	instruction := strings.TrimSpace(selection.Instruction)
	if len([]rune(instruction)) > 2000 {
		return BadAuthRequest("资产补充要求不能超过 2000 个字符")
	}
	effort := selection.ReasoningEffort
	if effort != "" && !effort.valid() {
		return BadAuthRequest("推理强度必须是 low、medium 或 high")
	}
	if state.ProductionParallel == nil {
		state.ProductionParallel = map[string]productionParallelWork{}
	}
	for _, key := range keys {
		if work, exists := state.ProductionParallel[key]; exists && work.TaskID != "" {
			continue
		}
		item := productionPlanItem(manifest, key)
		if item == nil {
			return BadAuthRequest("资产不属于当前清单：" + key)
		}
		work := state.ProductionParallel[key]
		work.Key, work.Name = key, item.Name
		work.Dependencies = productionParallelDependencyHash(manifest, artifacts, key)
		work.GenerationInstruction = instruction
		work.GenerationReasoningEffort = effort
		if productionAssetModelSelectionProvided(*selection) {
			work.GenerationModel = strings.TrimSpace(selection.Model)
			work.GenerationLogicalModelID = strings.TrimSpace(selection.LogicalModelID)
			work.GenerationChannelID = strings.TrimSpace(selection.ChannelID)
			work.GenerationChannelModelKey = strings.TrimSpace(selection.ChannelModelKey)
		}
		state.ProductionParallel[key] = work
	}
	return nil
}

func (s *Service) applyProductionAssetModelSelection(repo *repository.Repository, state *cloudAgentRuntime, selection ProductionAssetModelSelection) error {
	selection.Model = strings.TrimSpace(selection.Model)
	selection.LogicalModelID = strings.TrimSpace(selection.LogicalModelID)
	selection.ChannelID = strings.TrimSpace(selection.ChannelID)
	selection.ChannelModelKey = strings.TrimSpace(selection.ChannelModelKey)
	selection.Instruction = strings.TrimSpace(selection.Instruction)
	if len([]rune(selection.Instruction)) > 2000 {
		return BadAuthRequest("资产补充要求不能超过 2000 个字符")
	}
	if selection.ReasoningEffort != "" && !selection.ReasoningEffort.valid() {
		return BadAuthRequest("推理强度必须是 low、medium 或 high")
	}
	if selection.Model == "" {
		return BadAuthRequest("请选择资产生成文本模型")
	}
	request := state.Request
	request.Model = selection.Model
	request.LogicalModelID = selection.LogicalModelID
	request.ChannelID = selection.ChannelID
	request.ChannelModelKey = selection.ChannelModelKey
	if request.LogicalModelID != "" {
		if request.ChannelID != "" || request.ChannelModelKey != "" {
			return BadAuthRequest("逻辑模型和系统渠道不能混用")
		}
		if _, err := s.ResolveLogicalModel(request.LogicalModelID, ModelRequestIntent{Capability: "text"}); err != nil {
			return err
		}
	} else {
		if request.ChannelID == "" || request.ChannelModelKey == "" || request.Model != request.ChannelModelKey {
			return BadAuthRequest("请选择有效的受管文本模型")
		}
		channelModel, err := repo.ChannelModelByKey(request.ChannelID, request.ChannelModelKey)
		if err != nil || normalizeCapability(channelModel.Capability) != "text" {
			return BadAuthRequest("所选模型不可用或不是文本模型")
		}
	}
	if err := validateCloudAgentRequest(&request); err != nil {
		return err
	}
	state.Request = request
	return nil
}

// Extend the authorization without replacing live checkpoints or restarting Pi.
func productionAppendPlanAssets(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, rows []model.ProductionAgentArtifact, requested []string) (bool, error) {
	if !m.Plan.AssetsStarted {
		return false, BadAuthRequest("制作方案尚未结束，请先完成方案再生成资产")
	}
	selected := slices.Clone(m.Plan.SelectedAssetKeys)
	if selected == nil {
		for _, item := range m.Plan.Assets {
			selected = append(selected, item.Key)
		}
	}
	changed := false
	for _, key := range requested {
		if productionPlanArtifactValid(m, doc, rows, key) {
			continue
		}
		if !slices.Contains(selected, key) {
			selected = append(selected, key)
			changed = true
		}
	}
	for _, key := range requested {
		if productionPlanArtifactValid(m, doc, rows, key) {
			continue
		}
		work, exists := state.ProductionParallel[key]
		if !exists || work.Error == "" {
			continue
		}
		if work.TaskID != "" {
			task, err := optionalTaskForUser(repo, run.UserID, work.TaskID)
			if err != nil {
				return false, err
			}
			if task != nil {
				if !cloudAgentTaskTerminal(task.Status) {
					// The original call is still running and keeps its result.
					continue
				}
				if task.ProviderCancelStatus == model.ProviderCancelStatusRequested || task.ProviderCancelStatus == model.ProviderCancelStatusUncertain {
					log.Printf("append assets: resubmitting despite unconfirmed upstream cancel: run=%s key=%s task=%s", run.ID, key, work.TaskID)
				}
			}
		}
		delete(state.ProductionParallel, key)
		changed = true
	}
	if !changed {
		return false, nil
	}
	slices.Sort(selected)
	m.Plan.SelectedAssetKeys = selected
	encoded, err := json.Marshal(m)
	if err != nil {
		return false, err
	}
	if err := repo.UpdateProductionAgentManifest(run.UserID, run.ID, string(encoded)); err != nil {
		return false, err
	}
	if err := repo.ValidateProductionAgentJob(run.UserID, run.ID, false); err != nil {
		return false, err
	}
	state.event(run.ID, "production_control", map[string]any{"action": "generate_assets", "assetKeys": requested, "selectedAssetKeys": selected, "text": "已追加所选资产，保留正在执行的任务和已有结果，独立生成所选项"})
	return true, cloudAgentSave(run, state)
}

// Deleted nodes remain deleted during background work. A new explicit batch
// retires only their stale pointers; new assets get new node IDs and keep codes.
func productionResetMissingPlanAssets(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, rows []model.ProductionAgentArtifact, policy RuntimePolicySetting) ([]model.ProductionAgentArtifact, error) {
	root := productionWorkflow(productionNode(doc, m.FrameID))
	groups, _ := root["planGroups"].(map[string]any)
	if groups == nil {
		groups = map[string]any{}
		root["planGroups"] = groups
	}
	missingGroups := map[string]string{}
	repairedGroups := map[string]string{}
	for kind, id := range m.Plan.Groups {
		group := productionNode(doc, id)
		groupData := productionWorkflow(group)
		marker, _ := groupData["planGroup"].(map[string]any)
		rootData := productionWorkflow(productionNode(doc, m.FrameID))
		markerValid := group != nil && group["type"] == "frame" && marker["rootFrameId"] == m.FrameID && marker["kind"] == kind && groupData["pipelineId"] == rootData["pipelineId"]
		rootBinding := groups[kind]
		if markerValid {
			if rootBinding != id && productionNode(doc, stringValue(rootBinding)) == nil {
				groups[kind] = id
				repairedGroups[kind] = id
				continue
			}
			if rootBinding == id {
				continue
			}
		}
		// Retire only the stale plan pointer. The frame, its children, and any
		// conflicting root index belong to the canvas and remain untouched.
		missingGroups[kind] = id
		delete(m.Plan.Groups, kind)
		if stringValue(rootBinding) == id {
			delete(groups, kind)
		}
	}
	kept := []model.ProductionAgentArtifact{}
	removed := []map[string]string{}
	for _, row := range rows {
		_, isPlanDocument := planSection(row.Key)
		if m.Plan.AssetsStarted && (row.Key == "story" || isPlanDocument) {
			if productionNode(doc, row.NodeID) != nil {
				kept = append(kept, row)
				continue
			}
			if row.Key == "story" {
				return nil, BadAuthRequest("制作方案故事总纲节点已删除，未创建资产")
			}
			if err := repo.DeleteProductionAgentArtifact(run.UserID, run.ID, row.Key, row.NodeID); err != nil {
				return nil, err
			}
			removed = append(removed, map[string]string{"key": row.Key, "nodeId": row.NodeID, "hash": row.ContentHash})
			continue
		}
		// Asset receipts are checked when their selected generation is applied.
		// Keeping this check here would let one edited asset block unrelated
		// selected assets, and would prevent the existing candidate-version path.
		if productionPlanItem(m, row.Key) != nil {
			node := productionNode(doc, row.NodeID)
			if node == nil {
				if err := repo.DeleteProductionAgentArtifact(run.UserID, run.ID, row.Key, row.NodeID); err != nil {
					return nil, err
				}
				removed = append(removed, map[string]string{"key": row.Key, "nodeId": row.NodeID, "hash": row.ContentHash})
				continue
			}
			kept = append(kept, row)
			continue
		}
		// A document the user edited or moved is kept as is. It is never
		// overwritten here, and it must not block creating asset tasks.
		node := productionNode(doc, row.NodeID)
		if node != nil {
			kept = append(kept, row)
			continue
		}
		if err := repo.DeleteProductionAgentArtifact(run.UserID, run.ID, row.Key, row.NodeID); err != nil {
			return nil, err
		}
		removed = append(removed, map[string]string{"key": row.Key, "nodeId": row.NodeID, "hash": row.ContentHash})
	}
	if len(missingGroups) == 0 && len(repairedGroups) == 0 && len(removed) == 0 {
		return kept, nil
	}
	// Remove stale membership and edges, keeping all surviving nodes and media.
	if len(missingGroups) > 0 {
		edges := []map[string]any{}
		for _, edge := range creationMaps(doc["connections"]) {
			stale := false
			for _, id := range missingGroups {
				stale = stale || edge["fromNodeId"] == id || edge["toNodeId"] == id
			}
			if !stale {
				edges = append(edges, edge)
			}
		}
		doc["connections"] = edges
	}
	for _, node := range creationMaps(doc["nodes"]) {
		if node["id"] != m.FrameID {
			found := false
			for _, id := range m.Plan.Groups {
				found = found || node["id"] == id
			}
			if !found {
				continue
			}
		}
		data := productionWorkflow(node)
		members := []string{}
		for _, id := range productionIDs(data["sourceNodeIds"]) {
			if productionNode(doc, id) != nil {
				members = append(members, id)
			}
		}
		data["sourceNodeIds"] = members
	}
	canvas, err := repo.CanvasProjectForUser(run.UserID, state.Request.CanvasID)
	if err != nil {
		return nil, err
	}
	before := canvas.PayloadJSON
	if err := saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
		return nil, err
	}
	if err := emitCloudAgentCanvasChange(repo, run.ID, state, cloudAgentMutationInput{UserID: run.UserID, CanvasID: canvas.ID, Operation: "production_asset_reset", BeforeJSON: before}); err != nil {
		return nil, err
	}
	state.event(run.ID, "production_asset_reset", map[string]any{"groups": missingGroups, "retiredArtifacts": removed, "text": "已清理删除资产的失效关联；按本次所选范围重新创建，保留制作规范及现存资产"})
	return kept, nil
}
