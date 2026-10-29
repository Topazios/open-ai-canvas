package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type productionParallelOutputError struct{ error }

func (e productionParallelOutputError) Unwrap() error { return e.error }

type productionParallelStaleResultError struct{ message string }

func (e productionParallelStaleResultError) Error() string { return e.message }

const rejectedStoryboardToolMessage = "请直接调用 production_submit，仅保存指定的一项完整内容"

// Task identities and input receipts survive process restarts. Model calls use
// the regular queue/billing path; only their result commits are serialized.
type productionParallelWork struct {
	Key                        string                         `json:"key"`
	Name                       string                         `json:"name"`
	GenerationInstruction      string                         `json:"generationInstruction,omitempty"`
	GenerationReasoningEffort  ReasoningEffort                `json:"generationReasoningEffort,omitempty"`
	GenerationModel            string                         `json:"generationModel,omitempty"`
	GenerationLogicalModelID   string                         `json:"generationLogicalModelId,omitempty"`
	GenerationChannelID        string                         `json:"generationChannelId,omitempty"`
	GenerationChannelModelKey  string                         `json:"generationChannelModelKey,omitempty"`
	TaskID                     string                         `json:"taskId,omitempty"`
	Step                       int                            `json:"step"`
	Attempts                   int                            `json:"attempts"`
	ValidationAttempts         int                            `json:"validationAttempts,omitempty"`
	RepairUsed                 bool                           `json:"repairUsed,omitempty"`
	QuietHold                  bool                           `json:"quietHold,omitempty"`
	TransientAttempts          int                            `json:"transientAttempts,omitempty"`
	Dependencies               string                         `json:"dependencies"`
	Correction                 string                         `json:"correction,omitempty"`
	Error                      string                         `json:"error,omitempty"`
	RetryAt                    int64                          `json:"retryAt,omitempty"`
	DisableThinking            bool                           `json:"disableThinking,omitempty"`
	DocumentParts              *productionDocumentParts       `json:"documentParts,omitempty"`
	TargetHash                 *string                        `json:"targetHash,omitempty"`
	ServerBoundArguments       bool                           `json:"serverBoundArguments,omitempty"`
	RepairDocument             map[string]string              `json:"repairDocument,omitempty"`
	RepairDocumentRaw          map[string]json.RawMessage     `json:"repairDocumentRaw,omitempty"`
	RepairDesign               *productionDesignFields        `json:"repairDesign,omitempty"`
	ValidationSignature        string                         `json:"validationSignature,omitempty"`
	ValidationIssues           []cloudAgentValidationIssue    `json:"validationIssues,omitempty"`
	ValidationProblems         []string                       `json:"validationProblems,omitempty"`
	ValidationProblemCounts    map[string]int                 `json:"validationProblemCounts,omitempty"`
	ValidationProblemHistory   []string                       `json:"validationProblemHistory,omitempty"`
	RepeatedValidationFailures int                            `json:"repeatedValidationFailures,omitempty"`
	ValidationRepair           *cloudAgentToolRepair          `json:"validationRepair,omitempty"`
	Notice                     *model.TaskExecutionDiagnostic `json:"notice,omitempty"`
}

// Provider failures and locally rejected outputs use independent counters.
// Repeated validation categories also stop at the ordinary tool repair limit;
// storage, permission and version conflicts do not start another model call.
const productionParallelTransientRetries = cloudAgentModelStepRetries * 2

func productionParallelReady(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) []productionParallelWork {
	if m.Storyboard != nil {
		if m.Storyboard.Version == storyboardEpisodeVersion {
			return nil
		}
		return storyboardParallelReady(m)
	}
	if m.Plan == nil || m.Plan.Version < 2 {
		return nil
	}
	if m.Plan.AssetsStarted {
		candidates := make([]productionParallelWork, 0, len(m.Plan.SelectedAssetKeys))
		for _, key := range m.Plan.SelectedAssetKeys {
			item := productionPlanItem(m, key)
			if item == nil || productionPlanArtifactValid(m, doc, artifacts, key) {
				continue
			}
			candidates = append(candidates, productionParallelWork{
				Key: key, Name: item.Name, Dependencies: productionParallelDependencyHash(m, artifacts, key),
			})
		}
		return candidates
	}
	if m.Plan.Version >= 5 {
		var candidates []productionParallelWork
		keys := []string{"story"}
		if m.Plan.PlansStarted {
			keys = append(keys, m.Plan.SelectedPlanKeys...)
			if len(m.Plan.SelectedAssetKinds) > 0 && !slices.Contains(keys, "inventory") {
				keys = append(keys, "inventory")
			}
		}
		if m.Plan.AssetsStarted {
			keys = append([]string{}, m.Plan.SelectedAssetKeys...)
		}
		for _, key := range keys {
			deferredInventory := key == "inventory" && len(m.Plan.SelectedAssetKinds) > 0
			if (productionPlanArtifactValid(m, doc, artifacts, key) && !deferredInventory) || productionPlanPrerequisites(m, doc, artifacts, key) != nil {
				continue
			}
			section, _ := planSection(key)
			name := section.Title
			if item := productionPlanItem(m, key); item != nil {
				name = item.Name
			}
			candidates = append(candidates, productionParallelWork{Key: key, Name: name, Dependencies: productionParallelDependencyHash(m, artifacts, key)})
		}
		return candidates
	}
	next := productionPlanNextAction(m, doc, artifacts)
	if stringValue(next["blockedReason"]) != "" {
		return nil
	}
	var candidates []productionParallelWork
	switch productionPlanPhase(stringValue(next["phase"])) {
	case planPhaseStandards:
		for _, key := range []string{"visual", "direction"} {
			section, _ := planSection(key)
			candidates = append(candidates, productionParallelWork{Key: key, Name: section.Title})
		}
	case planPhaseAssets:
		for _, item := range m.Plan.Assets {
			if productionPlanAssetSelected(m, item.Key) {
				candidates = append(candidates, productionParallelWork{Key: item.Key, Name: item.Name})
			}
		}
	default:
		return nil
	}
	ready := []productionParallelWork{}
	for _, work := range candidates {
		if productionPlanArtifactValid(m, doc, artifacts, work.Key) || productionPlanPrerequisites(m, doc, artifacts, work.Key) != nil {
			continue
		}
		work.Dependencies = productionStoredValueHash(productionPlanDependencies(m, artifacts, work.Key))
		ready = append(ready, work)
	}
	return ready
}

func productionParallelDependencyHash(m productionManifest, artifacts []model.ProductionAgentArtifact, key string) string {
	if m.Storyboard != nil {
		return storyboardParallelDependencies(m, key)
	}
	return productionStoredValueHash(productionPlanDependencies(m, artifacts, key))
}
func productionParallelPrerequisites(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, key string) error {
	if m.Storyboard != nil {
		return storyboardParallelPrerequisites(m, key)
	}
	return productionPlanPrerequisites(m, doc, artifacts, key)
}

func productionParallelKeys(work map[string]productionParallelWork) []string {
	keys := make([]string, 0, len(work))
	for key := range work {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func productionParallelModelSelection(work productionParallelWork, state cloudAgentRuntime) (channelID, channelModelKey, logicalModelID, modelName string) {
	if strings.TrimSpace(work.GenerationModel) != "" {
		return work.GenerationChannelID, work.GenerationChannelModelKey, work.GenerationLogicalModelID, work.GenerationModel
	}
	channelID = state.Request.ChannelID
	channelModelKey = state.Request.ChannelModelKey
	logicalModelID = state.Request.LogicalModelID
	modelName = firstNonEmpty(channelModelKey, state.Request.Model)
	return
}

func productionParallelExternalFailure(work productionParallelWork) bool {
	return work.Error != "" && work.Notice != nil && (work.Notice.ErrorSource == "upstream" || work.Notice.ErrorSource == "network")
}

func productionParallelQuietHeld(state cloudAgentRuntime) bool {
	for _, work := range state.ProductionParallel {
		if work.QuietHold {
			return true
		}
	}
	return false
}

func (s *Service) finalizeProductionPlanStage(userID, runID string) error {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	for attempt := 0; attempt < 4; attempt++ {
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return err
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			state, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			job, m, doc, err := productionLoad(repo, current, &state)
			if err != nil {
				return err
			}
			if m.Plan == nil || m.Plan.Version < 5 {
				return nil
			}
			artifacts, err := repo.ProductionAgentArtifacts(userID, runID)
			if err != nil {
				return err
			}
			keys := []string{"story"}
			label := "故事总纲与世界规则"
			if m.Plan.PlansStarted {
				keys = append(keys, m.Plan.SelectedPlanKeys...)
				label = "其他制作方案"
			}
			for _, key := range keys {
				if !productionPlanArtifactValid(m, doc, artifacts, key) {
					return nil
				}
			}
			canvas, err := repo.CanvasProjectForUser(userID, current.CanvasID)
			if err != nil {
				return err
			}
			target := productionNode(doc, state.Request.Production.TargetNodeID)
			if target == nil {
				return BadAuthRequest("制作方案容器已删除")
			}
			meta, _ := target["metadata"].(map[string]any)
			targetData := productionWorkflow(target)
			meta["content"] = label + "已保存。资产总表与制作规范的结构完整性由模板约束，语义质量待人工验收。"
			meta["status"], meta["taskStage"] = "success", label+"已完成"
			targetData["materializedTaskId"] = runID
			frameData := productionWorkflow(productionNode(doc, m.FrameID))
			frameData["planReady"] = true
			m.Plan.SummaryHash = productionTargetHash(target)
			encoded, _ := json.Marshal(m)
			if err := repo.UpdateProductionAgentManifest(userID, runID, string(encoded)); err != nil {
				return err
			}
			if err := repo.ValidateProductionAgentJob(userID, runID, true); err != nil {
				return err
			}
			before := canvas.PayloadJSON
			if err := saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
				return err
			}
			if err := emitCloudAgentCanvasChange(repo, runID, &state, cloudAgentMutationInput{UserID: userID, CanvasID: canvas.ID, Operation: "production_plan_stage_complete", BeforeJSON: before}); err != nil {
				return err
			}
			_ = job
			return cloudAgentSave(current, &state)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		return err
	}
	return repository.ErrCreationConflict
}

func (s *Service) refreshProductionParallelCheckpoint(run *model.CloudAgentExecution, key string) error {
	return s.repo.MutateCloudAgent(run.UserID, run.ID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		work, exists := state.ProductionParallel[key]
		if !exists || work.TaskID != "" {
			return repository.ErrCreationConflict
		}
		_, manifest, document, err := productionLoad(repo, current, &state)
		if err != nil {
			return err
		}
		artifacts, err := repo.ProductionAgentArtifacts(run.UserID, run.ID)
		if err != nil {
			return err
		}
		if productionParallelPrerequisites(manifest, document, artifacts, key) != nil {
			delete(state.ProductionParallel, key)
			return cloudAgentSave(current, &state)
		}
		state.ProductionParallel[key] = productionParallelWork{
			Key: key, Name: work.Name,
			Dependencies: productionParallelDependencyHash(manifest, artifacts, key),
		}
		return cloudAgentSave(current, &state)
	})
}

// Invoked at a Pi model boundary, so the serial model lane is never active
// while independent dossiers are being drafted.
func (s *Service) runProductionParallel(ctx context.Context, userID, runID string) (bool, error) {
	handled := false
	for {
		if err := ctx.Err(); err != nil {
			return handled, err
		}
		if s.IsDraining() {
			return handled, context.Canceled
		}
		run, err := s.repo.CloudAgent(userID, runID)
		if err != nil {
			return handled, err
		}
		state, err := cloudAgentDecode(run)
		if err != nil {
			return handled, err
		}
		if cloudAgentRunTerminal(run.Status) {
			return handled, context.Canceled
		}
		if run.Status == "waiting_user" {
			return handled, nil
		}
		if state.Request.Production == nil || state.ActiveTaskID != "" || state.MediaTaskID != "" {
			return handled, nil
		}
		_, m, doc, err := productionLoad(s.repo, run, &state)
		if err != nil {
			return handled, err
		}
		if m.Storyboard != nil && m.Storyboard.Version == storyboardEpisodeVersion {
			return handled, nil
		}
		if m.Storyboard != nil && m.Storyboard.Version != storyboardLayoutVersion {
			if err := s.upgradeStoryboardLayout(run, &state); errors.Is(err, repository.ErrCreationConflict) {
				continue
			} else if err != nil {
				return handled, err
			}
			continue
		}
		if m.Storyboard == nil && (m.Plan == nil || m.Plan.Version < 2) {
			return handled, nil
		}
		artifacts, err := s.repo.ProductionAgentArtifacts(userID, runID)
		if err != nil {
			return handled, err
		}
		changed, running, retryPending, quietHeld := false, false, false, false
		failed := []string{}
		for _, key := range productionParallelKeys(state.ProductionParallel) {
			if m.Plan != nil && productionPlanItem(m, key) != nil && !productionPlanAssetSelected(m, key) {
				continue
			}
			work := state.ProductionParallel[key]
			// A locally rejected response gets one aggregated repair call. If that
			// call is also rejected, persist a quiet hold at this checkpoint; never
			// clear it on restart or let dependent production advance.
			if work.QuietHold {
				quietHeld = true
				continue
			}
			if work.Error != "" && !(m.Storyboard != nil && work.TaskID != "" && work.Error == rejectedStoryboardToolMessage) {
				failed = append(failed, work.Name+"："+work.Error)
				continue
			}
			if work.TaskID == "" {
				if work.Dependencies != productionParallelDependencyHash(m, artifacts, key) || productionParallelPrerequisites(m, doc, artifacts, key) != nil {
					err = s.refreshProductionParallelCheckpoint(run, key)
					if errors.Is(err, repository.ErrCreationConflict) {
						continue
					}
					if err != nil {
						return true, err
					}
					changed, handled = true, true
					break
				}
				retryPending = true
				continue
			}
			task, err := s.repo.TaskForUser(userID, work.TaskID)
			if err != nil {
				return true, err
			}
			if !cloudAgentTaskTerminal(task.Status) {
				running = true
				continue
			}
			err = s.settleProductionParallel(userID, runID, work, task)
			if errors.Is(err, repository.ErrCreationConflict) {
				changed = true
				break
			}
			if err != nil {
				return true, err
			}
			changed = true
			break
		}
		if changed {
			handled = true
			continue
		}
		// Settle responses before regrouping: a migration may need their
		// receipts to drain, while new sibling groups can be added immediately.
		if m.Plan != nil {
			changed, err := s.ensureProductionPlanGroups(userID, runID)
			if errors.Is(err, repository.ErrCreationConflict) {
				select {
				case <-ctx.Done():
					return handled, ctx.Err()
				case <-time.After(250 * time.Millisecond):
				}
				continue
			}
			if err != nil {
				return handled, err
			}
			if changed {
				continue
			}
		}
		capacityBlocked := false
		if !state.ProductionPaused {
			policy, err := s.runtimeConcurrencySetting()
			if err != nil {
				return handled, err
			}
			ready := productionParallelReady(m, doc, artifacts)
			// Serial documents can enter this lane after a bounded output-limit
			// recovery. Their parts retain the same dependency and admission rules.
			for _, key := range productionParallelKeys(state.ProductionParallel) {
				work := state.ProductionParallel[key]
				if m.Plan != nil && productionPlanItem(m, key) != nil && !productionPlanAssetSelected(m, key) {
					continue
				}
				if work.DocumentParts == nil || work.Error != "" || work.QuietHold || work.TaskID != "" {
					continue
				}
				found := false
				for _, candidate := range ready {
					found = found || candidate.Key == key
				}
				if !found {
					ready = append(ready, work)
				}
			}
			inFlight := 0
			for _, work := range state.ProductionParallel {
				if m.Plan != nil && productionPlanItem(m, work.Key) != nil && !productionPlanAssetSelected(m, work.Key) {
					continue
				}
				if work.TaskID != "" && work.Error == "" && !work.QuietHold {
					inFlight++
				}
			}
			for _, work := range ready {
				// A smaller policy drains existing requests before admitting new work,
				// including retries whose checkpoint no longer has a task receipt.
				if inFlight >= policy.ConcurrencyFor(model.TaskConcurrencyAgent) {
					break
				}
				if existing, ok := state.ProductionParallel[work.Key]; ok {
					if existing.Error != "" || existing.QuietHold || existing.TaskID != "" || existing.RetryAt > time.Now().UnixMilli() {
						continue
					}
					work = existing
				}
				err = s.enqueueProductionParallel(run, &state, m, doc, artifacts, work)
				if errors.Is(err, repository.ErrActiveTaskLimit) {
					capacityBlocked = true
					break
				}
				if errors.Is(err, repository.ErrCreationConflict) {
					changed = true
					break
				}
				if err != nil {
					return true, err
				}
				changed = true
				handled = true
				break
			}
			if changed {
				continue
			}
			if quietHeld && !running && !retryPending {
				if m.Plan != nil && m.Plan.Version >= 5 {
					err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
						state, decodeErr := cloudAgentDecode(current)
						if decodeErr != nil {
							return decodeErr
						}
						current.Status, current.FailureMessage = "waiting_user", ""
						state.ActiveTaskID, state.LastError = "", ""
						return cloudAgentSave(current, &state)
					})
					if errors.Is(err, repository.ErrCreationConflict) {
						continue
					}
					if err != nil {
						return handled, err
					}
					s.projectProductionAgentStatus(userID, runID)
					return true, nil
				}
				return handled, nil
			}
			if !running && !retryPending && len(failed) == 0 && !capacityBlocked {
				if m.Plan != nil && m.Plan.Version >= 5 {
					if err := s.finalizeProductionPlanStage(userID, runID); err != nil {
						return true, err
					}
					return true, nil
				}
				return handled, nil
			}
		}
		// Only an upstream/network failure reaches this branch. Local validation
		// remains attached to its current item and therefore keeps dependencies
		// blocked without converting the run into a failed/waiting state.
		if len(failed) > 0 && !running && !retryPending && !capacityBlocked && !state.ProductionPaused {
			message := fmt.Sprintf("%d 项文稿未完成：%s", len(failed), strings.Join(failed, "；"))
			return true, BadAuthRequest(message)
		}
		select {
		case <-ctx.Done():
			return handled, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (s *Service) enqueueProductionParallel(run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, work productionParallelWork) error {
	if m.Storyboard != nil && m.Storyboard.Version == storyboardEpisodeVersion {
		return BadAuthRequest("本集使用连续批量分镜，不创建逐镜并发任务")
	}
	if state.ProductionPaused {
		return repository.ErrCreationConflict
	}
	if err := productionParallelPrerequisites(m, doc, artifacts, work.Key); err != nil {
		return err
	}
	if work.Dependencies != productionParallelDependencyHash(m, artifacts, work.Key) {
		return BadAuthRequest("前置文稿版本已变化，未继续旧文稿调用")
	}
	var context map[string]any
	var err error
	toolName := "production_submit"
	if m.Storyboard != nil {
		context, err = storyboardParallelContext(s.repo, run, m, doc, work)
		toolName = "production_storyboard_expand"
		if work.Correction == rejectedStoryboardToolMessage {
			work.Correction = ""
		}
	} else {
		context, err = productionPlanContext(s.repo, run, m, doc)
	}
	if err != nil {
		return err
	}
	if m.Plan != nil && m.Plan.Version >= 5 && work.Key == "inventory" {
		context["independent"] = true
		if len(m.Plan.SelectedAssetKinds) > 0 {
			context["selectedAssetKinds"] = m.Plan.SelectedAssetKinds
			context["instruction"] = "用户正在生成指定类别资产。只依据本版故事总纲和已登记资产总表，从总纲提取完整清单；不读取或引用选题来源、项目参数、其他方案文稿或历史资产。完成清单后系统会自动继续生成所选类别。"
			delete(context, "projectParameters")
		}
	}
	if m.Storyboard == nil {
		if m.Plan != nil && m.Plan.AssetsStarted && productionPlanItem(m, work.Key) != nil {
			item := productionPlanItem(m, work.Key)
			context["requiredDocuments"] = productionPlanRequiredContext(m, doc, artifacts, "story")
			context["selectedAssetKeys"] = []string{work.Key}
			context["selectedAssetKinds"] = []string{item.Kind}
			if registered, ok := context["registeredAssets"].([]map[string]any); ok {
				selected := make([]map[string]any, 0, len(registered))
				for _, asset := range registered {
					if stringValue(asset["kind"]) == item.Kind {
						selected = append(selected, asset)
					}
				}
				context["registeredAssets"] = selected
			}
			delete(context, "progress")
			delete(context, "projectParameters")
			delete(context, "existingAssets")
			delete(context, "reuseInstruction")
			delete(context, "sections")
			delete(context, "sourceSections")
			delete(context, "sourceInputs")
			context["instruction"] = "只依据 requiredDocuments 中的本版故事总纲和 registeredAssets 中本次指定类别资产生成当前资产。不要查询、引用或校验选题来源、项目参数、视觉/导演/生成规范、其他类别资产或其他来源；直接提交当前资产文稿。"
		}
		targetHash := productionDocumentTargetHash(artifacts, work.Key)
		if work.TargetHash != nil && *work.TargetHash != targetHash {
			return BadAuthRequest("目标文稿版本已变化，未继续旧结果重试")
		}
		work.TargetHash = &targetHash
		args := map[string]any{"key": work.Key, "name": work.Name, "factIds": []string{}, "expectedHash": targetHash}
		context["nextAction"] = map[string]any{"key": work.Key, "name": work.Name, "kind": productionPlanKind(m, work.Key), "tool": "production_submit", "arguments": args, "documentSchemaVersion": productionPlanDocumentSchemaVersion(m.Plan.Version)}
		context["nextAction"].(map[string]any)["documentBudget"] = productionDocumentWorkBudget(m, doc, work)
		if !(m.Plan.AssetsStarted && productionPlanItem(m, work.Key) != nil) {
			context["requiredDocuments"] = productionPlanRequiredContext(m, doc, artifacts, work.Key)
			context["instruction"] = "本次只完成指定文稿。直接调用 production_submit；key、name、expectedHash 原样沿用 nextAction.arguments，factIds=[]。新建时 expectedHash=\"\"，不得复制前置文稿版本。只使用本次 document 模板字段，不添加说明或占位字段。repairDocumentFields 是当前制作项保留的原稿，保留合格内容，并根据 validationIssues 和 currentItemFeedback 一次补齐本项。不读取或查询状态，不输出开场说明，不生成其他文稿。"
		}
		if m.Plan.Version >= 5 && !(m.Plan.AssetsStarted && productionPlanItem(m, work.Key) != nil) {
			context["instruction"] = independentPlanPolicy
			delete(context, "progress")
			delete(context, "selectedAssetKeys")
			delete(context, "registeredAssets")
			delete(context, "existingAssets")
			delete(context, "reuseInstruction")
			delete(context, "sections")
			delete(context, "sourceSections")
			if work.Key != "story" {
				delete(context, "sourceInputs")
				delete(context, "projectParameters")
			}
		}
		if m.Plan.AssetsStarted && productionPlanItem(m, work.Key) != nil {
			context["instruction"] = "只依据 requiredDocuments 中已保存的本版故事总纲和 registeredAssets 中当前资产生成指定项。不要读取、引用或校验其他制作规范、其他资产类别、选题来源或项目参数；直接提交本项完整文稿。"
		}
		if m.Plan.Version >= 5 && work.Key == "inventory" {
			toolName = "production_plan_inventory"
			context["nextAction"] = productionPlanNextAction(m, doc, artifacts)
			if next, ok := context["nextAction"].(map[string]any); ok {
				if sections, exists := next["sourceSections"]; exists {
					context["sourceSections"] = sections
				}
				if sectionText, exists := next["sourceSectionText"]; exists {
					context["sourceSectionText"] = sectionText
					delete(next, "sourceSectionText")
				}
			}
			if len(m.Plan.SelectedAssetKinds) > 0 {
				context["instruction"] = "本次为用户发起的资产生成流程。只依据本版故事总纲和当前资产总表，补齐总纲中实际存在的资产并提交完整总表；不读取、引用或核对其他来源或规范。提交 complete=true 后，系统会自动继续生成用户选择的类别。"
			} else {
				context["instruction"] = independentPlanPolicy + " 本次直接调用 production_plan_inventory，complete=true，一次提交完整登记及本次模板要求的全部来源核对。"
			}
			delete(context, "sourceInputs")
			delete(context, "projectParameters")
			delete(context, "existingAssets")
			delete(context, "reuseInstruction")
			delete(context, "sections")
			work.TargetHash = nil
		}
		if len(work.RepairDocument) > 0 {
			context["repairDocumentFields"] = work.RepairDocument
		}
		if work.DocumentParts != nil {
			if err := productionDocumentPartsContext(m, doc, artifacts, work, context); err != nil {
				return err
			}
		}
		if len(work.RepairDocumentRaw) > 0 {
			context["repairDocumentFields"] = work.RepairDocumentRaw
			context["instruction"] = stringValue(context["instruction"]) + "repairDocumentFields 保留了当前制作项原稿的原始字段与类型；按完整 validationIssues 统一处理，不丢弃有效正文。key、name、factIds、expectedHash 必须与 document 并列放在工具参数根层级，不能嵌入 document。"
		}
		if work.RepairDesign != nil {
			context["repairDesign"] = work.RepairDesign
			context["instruction"] = stringValue(context["instruction"]) + "repairDesign 是当前制作项保留的结构化设计草稿，不是已接受的资产数据；保留并核对变体、声音关联与冲突信息，完成后显式提交在根层级 design，分批文稿只在最后一批提交 design。"
		}
		if toolName == "production_submit" {
			work.ServerBoundArguments = true
			productionBoundDocumentContext(context)
		}
	}
	if work.Correction != "" {
		context["currentItemFeedback"] = work.Correction
	}
	if work.GenerationInstruction != "" {
		context["instruction"] = strings.TrimSpace(stringValue(context["instruction"]) + "\n用户补充要求：" + work.GenerationInstruction)
	}
	if len(work.ValidationIssues) > 0 {
		failures := make([]error, 0, len(work.ValidationIssues))
		for _, issue := range work.ValidationIssues {
			failures = append(failures, cloudAgentFieldError(issue.Field, issue.Issue, issue.Message))
		}
		cloudAgentValidationModelReceipt(context, cloudAgentValidationErrors(failures...))
	}
	tools := productionRuntimeTools(m, context)
	var submit []map[string]any
	for _, tool := range tools {
		if tool["function"].(map[string]any)["name"] == toolName {
			submit = append(submit, tool)
		}
	}
	// The scheduler already enforces that this exact tool must be called and
	// validates the returned call before accepting it. Keep the wire choice
	// automatic: several reasoning providers reject tool_choice=required even
	// when they support the tool itself.
	toolChoice := "auto"
	canonical := canonicalAgentRequest{SystemPrompt: productionScopedPolicy(state.Canonical.SystemPrompt, m), Tools: submit, ToolChoice: toolChoice, Messages: productionCheckpointMessages(nil, state.Request.Prompt, context, productionScopedPolicy(state.Canonical.SystemPrompt, m)), PromptCacheKey: state.Canonical.PromptCacheKey}
	state.StepLimits, err = s.cloudAgentStepLimits()
	if err != nil {
		return err
	}
	state.Canonical.Tools = productionRuntimeTools(m, nil)
	// RepairUsed limits one repair response at a time. A new queued model call
	// starts the next repair window; leaving the flag set would quiet-hold the
	// item after its first repeated validation failure.
	work.RepairUsed = false
	work.Attempts++
	thinking := cloudAgentReasoningEnabled(state.Policy.ReasoningMode) && !state.ForceThinkingOff && !work.DisableThinking
	reasoningEffort := state.Request.ReasoningEffort.effective()
	if work.GenerationReasoningEffort.valid() {
		reasoningEffort = work.GenerationReasoningEffort
	}
	channelID, channelModelKey, logicalModelID, modelName := productionParallelModelSelection(work, *state)
	input := map[string]any{"mode": "text", "prompt": state.Request.Prompt, "agentRequests": map[string]any{"canonical": canonical}, "config": map[string]any{"channelId": channelID, "channelModelKey": channelModelKey, "model": firstNonEmpty(channelModelKey, modelName)}, "textOptions": map[string]any{"stream": true, "thinking": thinking, "reasoningEffort": reasoningEffort, "reasoningDisabled": !thinking, "maxOutputTokens": cloudAgentStepOutputBudget(state.StepLimits, state.BoostStepOutputBudget)}, "productionParallelKey": work.Key, "productionDependencies": work.Dependencies}
	req := CreateTaskRequest{ProjectID: state.Request.CanvasID, Type: "canvas_text", Operation: cloudAgentStepOperation, Prompt: state.Request.Prompt, Model: firstNonEmpty(channelModelKey, modelName), LogicalModelID: logicalModelID, Input: input}
	if err = s.enqueueCloudAgentTaskWithWork(run, state, req, nil, &work); err == nil {
		s.wakeTaskDispatcher()
	}
	return err
}

func (s *Service) settleProductionParallel(userID, runID string, work productionParallelWork, task *model.Task, allowTerminalRun ...bool) error {
	settleTerminal := len(allowTerminalRun) > 0 && allowTerminalRun[0]
	var failure error
	retryable := false
	if task.Status != model.TaskStatusSucceeded {
		failure = BadAuthRequest(userFacingTaskFailure(task))
		retryable = s.cloudAgentModelTaskRetryable(task.ID)
	} else {
		// Terminal task inputs are intentionally compacted. The durable job,
		// rather than a retained request or the model response, owns the tool contract.
		job, err := s.repo.ProductionAgentJob(userID, runID)
		if err != nil {
			return err
		}
		var manifest productionManifest
		if err := json.Unmarshal([]byte(job.ManifestJSON), &manifest); err != nil {
			return err
		}
		toolName := "production_submit"
		if manifest.Storyboard != nil {
			toolName = "production_storyboard_expand"
		}
		if manifest.Plan != nil && manifest.Plan.Version >= 5 && work.Key == "inventory" {
			toolName = "production_plan_inventory"
		}
		var result struct {
			ToolCalls []cloudAgentCall `json:"toolCalls"`
		}
		if err := json.Unmarshal([]byte(task.ResultJSON), &result); err != nil || len(result.ToolCalls) != 1 || result.ToolCalls[0].Function.Name != toolName {
			failure = BadAuthRequest("请直接调用 " + toolName + "，仅保存指定的一项完整内容")
			retryable = true
		} else {
			call := result.ToolCalls[0]
			call.ID = "parallel-" + task.ID
			if toolName != "production_plan_inventory" {
				call, failure = productionBindDocumentCall(work, call)
			}
			if failure == nil && toolName != "production_plan_inventory" {
				failure = productionParallelCallError(work, call, toolName)
			}
			if failure != nil {
				retryable = true
			} else {
				failure = s.commitProductionParallel(userID, runID, work, task, call, settleTerminal)
				var staleResult productionParallelStaleResultError
				if errors.As(failure, &staleResult) {
					return s.recordProductionParallelFailure(userID, runID, work, task, failure, false, settleTerminal)
				}
				var outputError productionParallelOutputError
				if errors.As(failure, &outputError) {
					retryable = true
				} else {
					// A storage, source-version or cancellation failure must not
					// trigger another billed model call for a valid response.
					return failure
				}
			}
		}
		if failure == nil || errors.Is(failure, repository.ErrCreationConflict) {
			return failure
		}
	}
	return s.recordProductionParallelFailure(userID, runID, work, task, failure, retryable, settleTerminal)
}

func (s *Service) commitProductionParallel(userID, runID string, work productionParallelWork, task *model.Task, call cloudAgentCall, allowTerminalRun ...bool) error {
	settleTerminal := len(allowTerminalRun) > 0 && allowTerminalRun[0]
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return err
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	return s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		if cloudAgentRunTerminal(current.Status) && !settleTerminal {
			return context.Canceled
		}
		if state.ProductionParallel[work.Key].TaskID != task.ID {
			return repository.ErrCreationConflict
		}
		work = state.ProductionParallel[work.Key]
		_, m, doc, err := productionLoad(repo, current, &state)
		if err != nil {
			return err
		}
		artifacts, err := repo.ProductionAgentArtifacts(userID, runID)
		if err != nil {
			return err
		}
		if m.Plan != nil {
			if m.Plan.Version < 5 && !m.Plan.AssetsStarted {
				if reason := stringValue(productionPlanNextAction(m, doc, artifacts)["blockedReason"]); reason != "" {
					if strings.HasPrefix(reason, "已有文稿被删除、移动或人工修改") {
						return productionParallelStaleResultError{message: reason}
					}
					return BadAuthRequest(reason)
				}
			}
		}
		if work.Dependencies != productionParallelDependencyHash(m, artifacts, work.Key) {
			return productionParallelStaleResultError{message: "前置文稿版本已变化，旧结果未写入"}
		}
		if work.TargetHash != nil && *work.TargetHash != productionDocumentTargetHash(artifacts, work.Key) {
			return productionParallelStaleResultError{message: "目标文稿版本已变化，旧结果未写入"}
		}
		if err := productionParallelPrerequisites(m, doc, artifacts, work.Key); err != nil {
			return err
		}
		if work.DocumentParts != nil {
			if err := productionDocumentPartsVersion(m, doc, artifacts, work); err != nil {
				return err
			}
			staged, merged, err := productionStageDocumentParts(m, doc, artifacts, &work, call)
			if err != nil {
				return productionParallelOutputError{err}
			}
			if staged {
				payload := productionModelCompletedPayload(task, work.Step, "文稿章节已暂存，继续剩余章节")
				payload["itemName"] = work.Name
				state.event(runID, "production_model_completed", payload)
				state.event(runID, "production_progress", map[string]any{"text": productionDocumentPartsProgress(work), "itemName": work.Name})
				work.TaskID, work.RetryAt, work.Correction = "", 0, ""
				work.RepairDocument = nil
				work.ValidationSignature, work.RepeatedValidationFailures = "", 0
				work.ValidationIssues, work.ValidationProblems, work.ValidationProblemCounts = nil, nil, nil
				work.ValidationProblemHistory = nil
				state.ProductionProgressStep = state.Step
				state.ProductionParallel[work.Key] = work
				return cloudAgentSave(current, &state)
			}
			call = merged
		}
		done := false
		if m.Storyboard != nil {
			done = storyboardShotDone(m, work.Key)
		} else {
			done = productionPlanArtifactValid(m, doc, artifacts, work.Key)
		}
		if !done {
			if _, err = productionAgentTool(repo, current, &state, call, policy); err != nil {
				var invalid *kernel.AppError
				if errors.As(err, &invalid) && invalid.Status == 400 {
					return productionParallelOutputError{err}
				}
				return err
			}
		}
		payload := productionModelCompletedPayload(task, work.Step, "文稿已保存")
		payload["itemName"] = work.Name
		if work.ValidationRepair != nil {
			state.event(runID, "production_validation", map[string]any{
				"taskId": task.ID, "itemName": work.Name, "phase": "validation", "errorSource": "application",
				"outcome": "recovered", "text": "本次修复后的完整文稿已通过校验并保存",
				"retry": cloudAgentRetryReceipt(work.ValidationRepair.GroupID, work.ValidationRepair.Attempt, "recovered"),
			})
		}
		state.event(runID, "production_model_completed", payload)
		work.ValidationRepair = nil
		delete(state.ProductionParallel, work.Key)
		return cloudAgentSave(current, &state)
	})
}

func (s *Service) recordProductionParallelFailure(userID, runID string, work productionParallelWork, task *model.Task, failure error, retryable bool, allowTerminalRun ...bool) error {
	settleTerminal := len(allowTerminalRun) > 0 && allowTerminalRun[0]
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return err
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	return s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		state, err := cloudAgentDecode(current)
		if err != nil {
			return err
		}
		if cloudAgentRunTerminal(current.Status) && !settleTerminal {
			return context.Canceled
		}
		if state.ProductionParallel[work.Key].TaskID != task.ID {
			return repository.ErrCreationConflict
		}
		work = state.ProductionParallel[work.Key]
		_, manifest, document, loadErr := productionLoad(repo, current, &state)
		if loadErr != nil {
			return loadErr
		}
		work.Correction = truncateRunes(cloudAgentSafeToolError(failure), 1200)
		validationFailure := task.Status == model.TaskStatusSucceeded
		message := work.Correction
		if validationFailure {
			message = "模型调用已完成"
		}
		payload := productionModelCompletedPayload(task, work.Step, message)
		payload["itemName"] = work.Name
		work.Notice = taskExecutionDiagnostic(task)
		if validationFailure {
			work.Notice = nil
			work.ValidationIssues = cloudAgentValidationIssues(failure)
			for i, issue := range work.ValidationIssues {
				work.ValidationIssues[i] = cloudAgentSafeValidationIssue(issue)
			}
		}
		if !validationFailure {
			payload["status"] = "failed"
			state.event(runID, "production_model_completed", payload)
		} else {
			// The provider task succeeded. Keep that receipt separate from the
			// application-level validation and repair checkpoint.
			payload["status"] = string(model.TaskStatusSucceeded)
			state.event(runID, "production_model_completed", payload)
		}
		var staleResult productionParallelStaleResultError
		if errors.As(failure, &staleResult) {
			work.Error, work.TaskID, work.RetryAt = work.Correction, "", 0
			work.QuietHold = true
			work.Notice = &model.TaskExecutionDiagnostic{Severity: "warning", ErrorSource: "application", Outcome: "needs_revision", Phase: "validation", SafeMessage: work.Correction}
			message := "前置文稿已变化，旧结果未写入；请手动重试此项"
			state.event(runID, "production_control", map[string]any{
				"action": "needs_revision", "text": message, "severity": "warning",
				"errorSource": "application", "phase": "validation", "outcome": "needs_revision",
			})
			state.ProductionParallel[work.Key] = work
			if err := persistStoryboardWork(repo, current, &state, policy); err != nil {
				return err
			}
			return cloudAgentSave(current, &state)
		}
		if cloudAgentOutputLimitReached(task) {
			if manifest.Plan != nil && manifest.Plan.Version >= 2 {
				artifacts, artifactErr := repo.ProductionAgentArtifacts(userID, runID)
				if artifactErr != nil {
					return artifactErr
				}
				if splitErr := productionSplitDocumentParts(manifest, document, artifacts, &work); splitErr != nil {
					work.Error = cloudAgentSafeToolError(splitErr)
				}
			}
			work.QuietHold = work.Error != "" || work.DocumentParts == nil
			work.TaskID, work.RetryAt = "", 0
			work.Correction = "模型输出达到上限，已改为按章节继续。"
			work.Notice = &model.TaskExecutionDiagnostic{Severity: "warning", ErrorSource: "content", Outcome: "incomplete", Phase: "content", Code: providerOutputLimitCode, SafeMessage: work.Correction}
		} else if retryable {
			// A valid response rejected by the local contract and a transient
			// provider failure need independent retry budgets. Otherwise three
			// malformed outputs can consume the allowance before a later 502 has
			// any chance to recover.
			retryCount := work.TransientAttempts
			if validationFailure {
				work.ValidationAttempts++
				_, m, doc, err := productionLoad(repo, current, &state)
				if err != nil {
					return err
				}
				artifacts, err := repo.ProductionAgentArtifacts(userID, runID)
				if err != nil {
					return err
				}
				if m.Plan != nil && m.Plan.Version >= 2 {
					productionPrepareDocumentRepair(m, doc, artifacts, &work, task, failure)
				}
				productionReopenDocumentField(&work, failure)
				work.ValidationSignature = productionValidationFailureSignature(work, failure, task)
				problems := productionValidationProblems(cloudAgentValidationIssues(failure), cloudAgentSafeToolError(failure))
				work.ValidationProblemCounts, work.RepeatedValidationFailures = productionTrackValidationProblems(problems, work.ValidationProblemCounts, &work.ValidationProblemHistory)
				work.ValidationProblems = problems
				groupID := runID + ":parallel:" + work.Key
				if work.ValidationRepair == nil || work.ValidationRepair.GroupID != groupID {
					work.ValidationRepair = &cloudAgentToolRepair{GroupID: groupID}
				}
				work.ValidationRepair.Attempt = work.ValidationAttempts
				if work.ValidationRepair.Attempt > cloudAgentToolAttemptLimit {
					work.ValidationRepair.Attempt = cloudAgentToolAttemptLimit
				}
				work.ValidationRepair.CallID = task.ID
				work.ValidationRepair.ProductionProgressStep = state.ProductionProgressStep
				work.ValidationRepair.ValidationIssues = append([]cloudAgentValidationIssue(nil), work.ValidationIssues...)
				work.ValidationRepair.ValidationProblemSignature = work.ValidationSignature
				work.ValidationRepair.ValidationMessage = work.Correction
				work.Error, work.TaskID, work.RetryAt = "", "", 0
				if work.RepeatedValidationFailures >= cloudAgentToolAttemptLimit {
					work.Error = fmt.Sprintf("当前制作项累计修复 %d 次仍未通过校验：%s", work.ValidationAttempts, cloudAgentSafeToolError(failure))
					work.QuietHold = true
					work.Notice = &model.TaskExecutionDiagnostic{Severity: "warning", ErrorSource: "application", Outcome: "needs_revision", Phase: "validation", SafeMessage: work.Error}
					state.ProductionParallel[work.Key] = work
					state.event(runID, "production_validation", map[string]any{
						"taskId": task.ID, "itemName": work.Name, "phase": "validation", "errorSource": "application",
						"outcome": "needs_revision", "text": work.Error,
						"retry": cloudAgentRetryReceipt(groupID, work.ValidationRepair.Attempt, "exhausted"),
					})
					state.event(runID, "production_control", map[string]any{
						"action": "needs_revision", "text": work.Error, "severity": "warning", "errorSource": "application",
						"phase": "validation", "outcome": "needs_revision", "retry": cloudAgentRetryReceipt(groupID, work.ValidationRepair.Attempt, "exhausted"),
					})
					return cloudAgentSave(current, &state)
				}
				work.RepairUsed = true
				work.RetryAt = time.Now().Add(time.Second).UnixMilli()
				state.event(runID, "production_validation", map[string]any{
					"taskId": task.ID, "itemName": work.Name, "phase": "validation", "errorSource": "application",
					"outcome": "needs_revision", "text": work.Correction,
					"retry": cloudAgentRetryReceipt(groupID, work.ValidationRepair.Attempt, "retrying"),
				})
			} else {
				work.TransientAttempts++
				retryCount = work.TransientAttempts
			}
			if validationFailure {
				// One unified repair call receives the complete issue set.
			} else if retryCount <= productionParallelTransientRetries {
				work.TaskID = ""
				work.RetryAt = time.Now().Add(time.Duration(1<<(retryCount-1)) * time.Second).UnixMilli()
				// Retry state is durable; keep transport retries out of the content journal.
			} else {
				work.Error = work.Correction
			}
		} else {
			work.Error = work.Correction
		}
		state.ProductionParallel[work.Key] = work
		if err := persistStoryboardWork(repo, current, &state, policy); err != nil {
			return err
		}
		return cloudAgentSave(current, &state)
	})
}
