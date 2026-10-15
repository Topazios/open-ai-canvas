package app

import (
	"errors"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func (s *Service) initializeProductionAgent(userID, runID string) error {
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	run, err := s.repo.CloudAgent(userID, runID)
	if err != nil {
		return err
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		return err
	}
	if state.Request.Production == nil || cloudAgentRunTerminal(run.Status) {
		return nil
	}
	// Job creation and target binding commit together. Replays must not reset
	// progress or require unchanged sources merely to observe an existing run.
	if _, err := s.repo.ProductionAgentJob(userID, runID); err == nil {
		return nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	return s.repo.MutateCloudAgent(userID, runID, run.Revision, func(current *model.CloudAgentExecution, repo *repository.Repository) error {
		_, _, doc, err := productionLoad(repo, current, &state)
		if err != nil {
			return err
		}
		usage, err := repo.UserStorageUsage(userID)
		if err != nil {
			return err
		}
		if err = validateTaskDataGrowthQuotaWithPolicy(usage, 0, policy.Resource); err != nil {
			return err
		}
		canvas, err := repo.CanvasProjectForUser(userID, state.Request.CanvasID)
		if err != nil {
			return err
		}
		before := canvas.PayloadJSON
		target := productionNode(doc, state.Request.Production.TargetNodeID)
		meta, _ := target["metadata"].(map[string]any)
		data := productionWorkflow(target)
		agent, _ := data["productionAgent"].(map[string]any)
		if agent == nil {
			agent = map[string]any{}
		}
		agent["runId"] = runID
		data["productionAgent"] = agent
		data["submission"] = "submitted"
		meta["status"], meta["taskStage"] = "loading", "制作 Agent 正在规划"
		if err = saveCloudAgentDocument(repo, canvas, doc, policy); err != nil {
			return err
		}
		if err = emitCloudAgentCanvasChange(repo, runID, &state, cloudAgentMutationInput{UserID: userID, CanvasID: canvas.ID, Operation: "production_start", BeforeJSON: before}); err != nil {
			return err
		}
		return cloudAgentSave(current, &state)
	})
}
