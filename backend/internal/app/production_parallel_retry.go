package app

import (
	"errors"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// RetryProductionAgentItem puts one failed or abandoned production document
// back into the parallel queue. It is a convenience entry for occasional spot
// checks: the scheduler already retries on its own and never blocks siblings.
func (s *Service) RetryProductionAgentItem(userID, runID, key string) error {
	task, err := s.repo.TaskForUser(userID, runID)
	if err != nil {
		return err
	}
	if err := s.ensureProductionRunActive(userID, task, "对应节点已删除，制作任务已移除"); err != nil {
		return err
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
		_, manifest, _, err := productionLoad(s.repo, run, &state)
		if err != nil {
			return err
		}
		if !productionRetryKeyAllowed(manifest, key) {
			return BadAuthRequest("该项不属于当前制作方案，无法重试")
		}
		if state.ActiveTaskID != "" {
			active, err := optionalTaskForUser(s.repo, userID, state.ActiveTaskID)
			if err != nil {
				return err
			}
			if active != nil && !cloudAgentTaskTerminal(active.Status) {
				return productionPlanConflict("当前调用尚未完成收尾，请稍后再试")
			}
		}
		if work, ok := state.ProductionParallel[key]; ok && work.TaskID != "" {
			previous, err := optionalTaskForUser(s.repo, userID, work.TaskID)
			if err != nil {
				return err
			}
			if previous != nil && !cloudAgentTaskTerminal(previous.Status) {
				return productionPlanConflict("该项的上一次调用尚未完成收尾，请稍后再试")
			}
		}
		wasStopped := run.Status == "failed" || run.Status == "waiting_user"
		if run.Status == "completed" || wasStopped {
			// A finished run was validated against the old content; reopen it.
			if err := s.repo.ValidateProductionAgentJob(userID, runID, false); err != nil {
				return err
			}
		}
		err = s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
			currentState, err := cloudAgentDecode(current)
			if err != nil {
				return err
			}
			_, currentManifest, _, err := productionLoad(repo, current, &currentState)
			if err != nil {
				return err
			}
			artifacts, err := repo.ProductionAgentArtifacts(userID, runID)
			if err != nil {
				return err
			}
			if currentState.ProductionParallel == nil {
				currentState.ProductionParallel = map[string]productionParallelWork{}
			}
			// Keep the item's model choice; clear everything about the failed attempt.
			previous := currentState.ProductionParallel[key]
			name := previous.Name
			if name == "" {
				name = productionRetryItemName(currentManifest, key)
			}
			currentState.ProductionParallel[key] = productionParallelWork{
				Key:                       key,
				Name:                      name,
				GenerationInstruction:     previous.GenerationInstruction,
				GenerationReasoningEffort: previous.GenerationReasoningEffort,
				GenerationModel:           previous.GenerationModel,
				GenerationLogicalModelID:  previous.GenerationLogicalModelID,
				GenerationChannelID:       previous.GenerationChannelID,
				GenerationChannelModelKey: previous.GenerationChannelModelKey,
				DisableThinking:           previous.DisableThinking,
				Dependencies:              productionParallelDependencyHash(currentManifest, artifacts, key),
			}
			currentState.ProductionPaused = false
			currentState.LastError = ""
			if current.Status == "failed" || current.Status == "waiting_user" || current.Status == "completed" {
				productionBlockRuntime(current, &currentState)
			}
			return cloudAgentSave(current, &currentState)
		})
		if errors.Is(err, repository.ErrCreationConflict) {
			continue
		}
		if err != nil {
			return err
		}
		s.projectProductionAgentStatus(userID, runID)
		if wasStopped {
			s.resumeCloudAgentPi(userID, runID)
		} else {
			s.startCloudAgentPi(userID, runID)
		}
		return nil
	}
	return productionPlanConflict("任务数据刚被更新，请稍后重试")
}

func productionRetryKeyAllowed(m productionManifest, key string) bool {
	switch key {
	case "story", "inventory", "visual", "direction", "generation":
		return m.Plan != nil
	}
	return m.Plan != nil && productionPlanItem(m, key) != nil && productionPlanAssetSelected(m, key)
}

func productionRetryItemName(m productionManifest, key string) string {
	if section, ok := planSection(key); ok && section.Title != "" {
		return section.Title
	}
	if item := productionPlanItem(m, key); item != nil {
		return item.Name
	}
	return key
}
