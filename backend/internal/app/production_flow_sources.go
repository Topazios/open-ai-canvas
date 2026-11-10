package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/repository"
)

type productionFlowSourceSnapshot struct {
	Sections []string
	Bodies   map[string]string
}

type productionFlowSourceCache = platform.BoundedReadCache[string, productionFlowSourceSnapshot]

func newProductionFlowSourceCache() *productionFlowSourceCache {
	return platform.NewBoundedReadCache[string, productionFlowSourceSnapshot](8, 32<<20, 2, 10*time.Minute)
}

func productionFlowPublishedSources(repo *repository.Repository, run *model.CloudAgentExecution, m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact, caches ...*productionFlowSourceCache) ([]string, map[string]string, error) {
	if len(m.Plan.FlowStoryUnits) == 0 {
		sections, bodies := productionInventoryReviewSources(*m.Plan, productionInventoryStory(doc, artifacts))
		return sections, bodies, nil
	}
	g := productionFlowGraph{}
	versions := []string{run.UserID, run.ID, fmt.Sprint(m.Plan.Version), fmt.Sprint(m.Plan.FlowVersion), productionFlowJSON(productionWorkflow(productionNode(doc, m.FrameID))["parameters"])}
	rows, err := repo.ProductionFlowUnitsByIDs(run.UserID, run.ID, m.Plan.FlowStoryUnits)
	if err != nil {
		return nil, nil, err
	}
	byID := map[string]model.ProductionFlowUnit{}
	for _, row := range rows {
		byID[row.ID] = row
	}
	for _, id := range m.Plan.FlowStoryUnits {
		u, exists := byID[id]
		if !exists || u.Status != "accepted" {
			return nil, nil, productionPlanConflict("已发布总纲的采用记录已变化，请先确认当前版本")
		}
		g.Units = append(g.Units, u)
		versions = append(versions, u.ID, u.ResultJSON)
	}
	load := func(context.Context) (productionFlowSourceSnapshot, int, error) {
		fields, err := productionFlowStoryDocument(g, m, doc)
		if err != nil {
			return productionFlowSourceSnapshot{}, 0, err
		}
		content, err := productionRenderPlanDocumentForSchema("story", "", fields, productionPlanSchemaVersion(*m.Plan))
		if err != nil {
			return productionFlowSourceSnapshot{}, 0, err
		}
		sections, bodies := productionInventoryReviewSources(*m.Plan, content)
		bytes := 256
		for _, section := range sections {
			bytes += len(section) + len(bodies[section]) + 64
		}
		return productionFlowSourceSnapshot{Sections: sections, Bodies: bodies}, bytes, nil
	}
	var snapshot productionFlowSourceSnapshot
	if len(caches) > 0 && caches[0] != nil {
		snapshot, err = caches[0].Get(context.Background(), productionHash(versions), load)
		if errors.Is(err, platform.ErrReadCacheBusy) {
			snapshot, _, err = load(context.Background())
		}
	} else {
		snapshot, _, err = load(context.Background())
	}
	if err != nil {
		return nil, nil, err
	}
	// Callers cannot mutate a cached projection shared with another request.
	bodies := make(map[string]string, len(snapshot.Bodies))
	for key, value := range snapshot.Bodies {
		bodies[key] = value
	}
	return append([]string(nil), snapshot.Sections...), bodies, nil
}
