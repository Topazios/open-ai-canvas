package app

import "infinite-canvas/backend/internal/model"

type ProductionPlanAssetProgress struct {
	Key                 string   `json:"key"`
	Code                string   `json:"code"`
	Name                string   `json:"name"`
	Kind                string   `json:"kind"`
	Priority            int      `json:"priority,omitempty"`
	Status              string   `json:"status"`
	Error               string   `json:"error,omitempty"`
	Severity            string   `json:"severity,omitempty"`
	MissingDependencies []string `json:"missingDependencies"`
}

func productionPlanAssetProgress(m productionManifest, doc map[string]any, rows []model.ProductionAgentArtifact, state *cloudAgentRuntime, tasks map[string]model.TaskStatus, active bool) []ProductionPlanAssetProgress {
	items := []ProductionPlanAssetProgress{}
	for _, asset := range m.Plan.Assets {
		item := ProductionPlanAssetProgress{Key: asset.Key, Code: asset.Key, Name: asset.Name, Kind: productionPlanGroupKind(asset), Priority: asset.Priority, Status: "pending", MissingDependencies: []string{}}
		if asset.Identity != nil {
			item.Code = asset.Identity.Code
		}
		for _, key := range productionPlanAssetDependencies(m, asset) {
			if !productionPlanArtifactValid(m, doc, rows, key) {
				item.MissingDependencies = append(item.MissingDependencies, key)
			}
		}
		if len(item.MissingDependencies) > 0 {
			item.Status = "blocked"
		}
		if work, ok := state.ProductionParallel[asset.Key]; ok {
			if productionStaleUnsubmittedPropFailure(m, rows, asset, work) && !productionPlanAssetSelected(m, asset.Key) {
				items = append(items, item)
				continue
			}
			item.Error = work.Error
			if item.Error == "" && work.Notice != nil && work.Notice.Severity == "warning" {
				item.Error = work.Notice.SafeMessage
				item.Severity = "warning"
			}
			if work.Error != "" {
				item.Status = "failed"
				if work.Notice != nil {
					item.Severity = work.Notice.Severity
				}
			} else if productionPlanAssetSelected(m, asset.Key) {
				if !active || state.ProductionPaused {
					item.Status = "stopped"
				} else if work.TaskID == "" {
					item.Status = "queued"
					if work.RetryAt > 0 {
						item.Status = "retrying"
					}
				} else {
					switch tasks[work.TaskID] {
					case model.TaskStatusQueued:
						item.Status = "queued"
					case model.TaskStatusSucceeded:
						item.Status = "saving"
					case model.TaskStatusFailed, model.TaskStatusCancelled:
						item.Status = "retrying"
					default:
						item.Status = "running"
					}
				}
			}
		} else if productionPlanAssetSelected(m, asset.Key) && active && !state.ProductionPaused && item.Status == "pending" {
			item.Status = "queued"
		}
		if productionPlanArtifactValid(m, doc, rows, asset.Key) {
			item.Status, item.Error = "complete", ""
			item.Severity = ""
		}
		items = append(items, item)
	}
	return items
}
