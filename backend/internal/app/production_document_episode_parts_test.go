package app

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestProductionDocumentChapterRequestDoesNotReissueWholePlan(t *testing.T) {
	s, db, runID := parallelPlanFixture(t)
	work := enqueueDocumentPart(t, s, runID, "visual")
	failDocumentPart(t, s, db, runID, work)
	work = enqueueDocumentPart(t, s, runID, "visual")
	task, _ := s.repo.Task(work.TaskID)
	var input map[string]any
	_ = json.Unmarshal([]byte(task.InputJSON), &input)
	canonical := stateCanonicalFromInput(input)
	if strings.Contains(canonical.SystemPrompt, "【制作执行规范") || !strings.Contains(canonical.SystemPrompt, "章节子任务") {
		t.Fatal("chapter worker still carries a whole-plan delivery policy")
	}
	user := stringValue(canonical.Messages[1]["content"])
	if !strings.HasPrefix(user, "执行当前章节子任务") || !strings.Contains(user, `"originalRequest"`) || !strings.Contains(user, `"documentFields"`) {
		t.Fatal("chapter request lost original requirements or retained the full task as its execution instruction")
	}
}

func TestProductionDocumentEpisodeBatchesSurviveRestartAndMerge(t *testing.T) {
	s, db, run := planFixture(t, 5)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionWorkflow(productionNode(doc, "group"))["parameters"].(map[string]any)["episodeCount"] = 6
	})
	m, doc, artifacts := orderedPlanState(t, s, run.ID)
	parts := &productionDocumentParts{SchemaVersion: productionPlanDocumentSchemaVersion(m.Plan.Version), Fields: orderedPlanDocument("story", ""), Pending: [][]string{{"episodeArchitecture"}}}
	delete(parts.Fields, "episodeArchitecture")
	work := productionParallelWork{Key: "story", Name: "故事总纲", Dependencies: productionParallelDependencyHash(m, artifacts, "story"), DocumentParts: parts, DisableThinking: true}
	all := strings.Split(productionEpisodeArchitectureFixture(6), "\n")
	batchRows := func(start, end int) string {
		rows := []string{}
		for _, row := range all {
			for episode := start; episode <= end; episode++ {
				if strings.Contains(row, "EP-"+leftPadEpisode(episode)) {
					rows = append(rows, row)
				}
			}
		}
		return strings.Join(rows, "\n")
	}
	first := productionDocumentEpisodeBatch(m, doc, work)
	if first == nil || first.Start != 1 || first.End != 4 || first.Total != 6 {
		t.Fatalf("unexpected first range: %+v", first)
	}
	text, staged, err := productionStageDocumentEpisodes(m, doc, &work, batchRows(1, 4), *first)
	if err != nil || !staged || text != "" || len(parts.EpisodeRows) != 4 {
		t.Fatalf("first complete batch not checkpointed: staged=%v err=%v rows=%v", staged, err, parts.EpisodeRows)
	}
	mutateParallelState(t, s, run.ID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) { state.ProductionParallel["story"] = work })
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	_, restored := productionRuntimeState(t, s, run.ID)
	work = restored.ProductionParallel["story"]
	next := productionDocumentEpisodeBatch(m, doc, work)
	if next == nil || next.Start != 5 || next.End != 6 {
		t.Fatalf("restart replayed accepted rows: %+v", next)
	}
	context := map[string]any{"nextAction": map[string]any{"key": "story", "tool": "production_submit", "documentSchemaVersion": 2, "documentFields": []string{"episodeArchitecture"}, "documentBudget": productionDocumentWorkBudget(m, doc, work)}}
	productionDocumentEpisodeContext(m, doc, work, context)
	tools := productionRuntimeTools(m, context)
	encoded, _ := json.Marshal(tools)
	if !strings.Contains(string(encoded), "本批仅生成第 5 至 6 集") || context["previousEpisodeRow"] != work.DocumentParts.EpisodeRows[4] {
		t.Fatal("tool schema or continuity context has the wrong range")
	}
	text, staged, err = productionStageDocumentEpisodes(m, doc, &work, batchRows(5, 6), *next)
	if err != nil || staged {
		t.Fatalf("last batch did not merge: %v", err)
	}
	fields := work.DocumentParts.Fields
	fields["episodeArchitecture"] = text
	content, err := productionRenderPlanDocumentForSchema("story", "", fields, parts.SchemaVersion)
	if err != nil || len(productionPlanEpisodeArchitectureIssues(m, doc, content, parts.SchemaVersion)) != 0 {
		t.Fatalf("merged rows failed ordinary full-outline validation: %v %v", err, productionPlanEpisodeArchitectureIssues(m, doc, content, parts.SchemaVersion))
	}
	if len(mustPlanArtifacts(t, s, run.ID)) != len(artifacts) {
		t.Fatal("partial rows leaked into canvas artifacts")
	}
}

func leftPadEpisode(episode int) string {
	return strings.Repeat("0", max(0, 3-len(strconv.Itoa(episode)))) + strconv.Itoa(episode)
}

func TestProductionDocumentEpisodeBatchRejectsMissingDuplicateAndOutOfRangeRows(t *testing.T) {
	m := productionManifest{Plan: &productionPlan{StoryStructureVersion: 1}}
	for _, text := range []string{"", productionEpisodeArchitectureFixture(2), productionEpisodeArchitectureFixture(4) + "\n" + productionEpisodeArchitectureFixture(1)} {
		work := productionParallelWork{DocumentParts: &productionDocumentParts{Fields: map[string]string{}, EpisodeRows: map[int]string{}}}
		_, _, err := productionStageDocumentEpisodes(m, nil, &work, text, productionDocumentEpisodeRange{Start: 1, End: 3, Total: 6})
		if err == nil || len(work.DocumentParts.EpisodeRows) != 0 {
			t.Fatal("invalid row batch changed checkpoint")
		}
	}
}
