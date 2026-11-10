package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func episodeSubmissionRows(start, end int) []map[string]any {
	rows := []map[string]any{}
	fixture := strings.Split(productionEpisodeArchitectureFixture(end), "\n")[2:]
	for episode := start; episode <= end; episode++ {
		cells := strings.Split(fixture[episode-1], "|")
		row := map[string]any{"episode": episode}
		for i, key := range productionEpisodeFields[1:] {
			row[key] = strings.TrimSpace(cells[i+1])
		}
		rows = append(rows, row)
	}
	return rows
}

func episodeSubmissionCall(t *testing.T, work productionParallelWork, value any) cloudAgentCall {
	t.Helper()
	args := map[string]any{"key": work.Key, "name": work.Name, "expectedHash": work.DocumentParts.ExpectedHash, "factIds": []string{}, "document": map[string]any{"episodeArchitecture": value}}
	call := productionRuntimeCall("production_submit")
	encoded, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	call.Function.Arguments = string(encoded)
	return call
}

func TestProductionEpisodeSubmissionRendersNamedFieldsWithoutLosingDelimiters(t *testing.T) {
	values := episodeSubmissionRows(1, 2)
	values[0]["outcomeAndCost"] = "取得证据 | 失去信任｜承担后果\n保留全部细节"
	raw, _ := json.Marshal(values)
	rows, err := productionReadEpisodeRows(raw, productionDocumentEpisodeRange{Start: 1, End: 2, Total: 2})
	if err != nil || len(rows) != 2 {
		t.Fatalf("named rows rejected: %v", err)
	}
	if !strings.Contains(rows[1], "取得证据 &#124; 失去信任&#65372;承担后果<br>保留全部细节") {
		t.Fatal("literal delimiters or newlines lost")
	}
	for _, row := range rows {
		if len(strings.Split(strings.Trim(row, "|"), "|")) != productionEpisodeArchitectureColumnCount {
			t.Fatal("rendered table changed column count")
		}
	}
	legacy, _ := json.Marshal(productionEpisodeRowsText(rows))
	parsed, err := productionReadEpisodeRows(legacy, productionDocumentEpisodeRange{Start: 1, End: 2, Total: 2})
	if err != nil || productionHash(parsed) != productionHash(rows) {
		t.Fatal("rendered table is not stable")
	}
}

func TestProductionEpisodeSubmissionReportsAllInvalidRows(t *testing.T) {
	values := episodeSubmissionRows(9, 12)
	delete(values[1], "outcomeAndCost")
	values[2]["action"] = "待补充"
	values = append(values, values[0])
	raw, _ := json.Marshal(values)
	rows, err := productionReadEpisodeRows(raw, productionDocumentEpisodeRange{Start: 9, End: 12, Total: 12})
	if err == nil || len(rows) != 1 || rows[12] == "" {
		t.Fatalf("invalid or duplicate rows were accepted: %v %v", rows, err)
	}
	issues := cloudAgentValidationIssues(err)
	for _, want := range []string{"episode[9]", "episode[10].outcomeAndCost", "episode[11].action"} {
		found := false
		for _, issue := range issues {
			found = found || strings.Contains(issue.Field, want)
		}
		if !found {
			t.Fatalf("missing diagnostic for %s: %v", want, issues)
		}
	}
}

func TestProductionEpisodeSubmissionPreservesSiblingsAndRepairsOnlyMissingEpisode(t *testing.T) {
	s, db, run := planFixture(t, 5)
	productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
	productionEditCanvas(t, s, db, func(doc map[string]any) {
		productionWorkflow(productionNode(doc, "group"))["parameters"].(map[string]any)["episodeCount"] = 12
	})
	m, doc, artifacts := orderedPlanState(t, s, run.ID)
	parts := &productionDocumentParts{SchemaVersion: productionPlanDocumentSchemaVersion(m.Plan.Version), Fields: orderedPlanDocument("story", ""), Pending: [][]string{{"episodeArchitecture"}}, EpisodeRows: map[int]string{}}
	delete(parts.Fields, "episodeArchitecture")
	valid := strings.Split(productionEpisodeArchitectureFixture(12), "\n")[2:]
	for episode := 1; episode <= 8; episode++ {
		parts.EpisodeRows[episode] = valid[episode-1]
	}
	work := productionParallelWork{Key: "story", Name: "故事总纲", Dependencies: productionParallelDependencyHash(m, artifacts, "story"), DocumentParts: parts, DisableThinking: true}
	mutateParallelState(t, s, run.ID, func(_ *model.CloudAgentExecution, state *cloudAgentRuntime) { state.ProductionParallel["story"] = work })
	work = enqueueDocumentPart(t, s, run.ID, "story")
	// The observed failure: episode 10 splits outcome and cost into 12 columns.
	broken := append([]string(nil), valid[8:12]...)
	broken[1] = "10 | 验出缺页 | 当日公会门前 | 证明账页被抽换 | 比对账页残印 | 孙被迫暂停验账 | 取得缺页证据但责任未确认 | 船工转为作证 | 证词众人听见 | 转向仓房 | 孙准备封仓 | 线索不是定罪"
	call := episodeSubmissionCall(t, work, strings.Join(broken, "\n"))
	before := productionHash(work.DocumentParts)
	_, _, failure := productionStageDocumentParts(m, doc, artifacts, &work, call)
	if failure == nil || productionHash(work.DocumentParts) != before || !strings.Contains(failure.Error(), "实际 12 列") {
		t.Fatalf("wrong failure or eager checkpoint mutation: %v", failure)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": productionRuntimeResult(t, call)}).Error; err != nil {
		t.Fatal(err)
	}
	task, _ := s.repo.Task(work.TaskID)
	if err := s.settleProductionParallel("user", run.ID, work, task); err != nil {
		t.Fatal(err)
	}
	s = &Service{repo: repository.New(db), dataDir: s.dataDir, disablePiRuntime: true}
	_, state := productionRuntimeState(t, s, run.ID)
	work = state.ProductionParallel["story"]
	if len(work.DocumentParts.EpisodeRows) != 11 || work.DocumentParts.EpisodeRows[10] != "" || work.DocumentParts.EpisodeRows[12] == "" {
		t.Fatalf("sibling checkpoints lost: %v", work.DocumentParts.EpisodeRows)
	}
	if productionHash(mustPlanArtifacts(t, s, run.ID)) != productionHash(artifacts) {
		t.Fatal("rejected batch leaked into artifacts")
	}
	batch := productionDocumentEpisodeBatch(m, doc, work)
	if batch == nil || batch.Start != 10 || batch.End != 10 {
		t.Fatalf("retry reissues accepted rows: %+v", batch)
	}
	draft := string(productionEpisodeScopedDraft(work, *batch))
	if !strings.Contains(draft, "验出缺页") || strings.Contains(draft, "EP-009") || strings.Contains(draft, "EP-011") {
		t.Fatalf("repair scope includes accepted siblings: %s", draft)
	}
	// Explicit item retry must preserve recovered rows and rejected draft.
	if err := s.RetryProductionAgentItem("user", run.ID, "story"); err != nil {
		t.Fatal(err)
	}
	_, state = productionRuntimeState(t, s, run.ID)
	if len(state.ProductionParallel["story"].DocumentParts.EpisodeRows) != 11 || len(state.ProductionParallel["story"].EpisodeRepairDraft) == 0 {
		t.Fatal("manual retry discarded recovery")
	}
	work = enqueueDocumentPart(t, s, run.ID, "story")
	task, _ = s.repo.Task(work.TaskID)
	var input map[string]any
	_ = json.Unmarshal([]byte(task.InputJSON), &input)
	canonical := stateCanonicalFromInput(input)
	schema := canonical.Tools[0]["function"].(map[string]any)["parameters"].(map[string]any)["properties"].(map[string]any)["document"].(map[string]any)["properties"].(map[string]any)["episodeArchitecture"].(map[string]any)
	if schema["type"] != "array" || numberValue(schema["maxItems"], 0) != 1 {
		t.Fatalf("worker did not receive the single-row named schema: %v", schema)
	}
	call = episodeSubmissionCall(t, work, episodeSubmissionRows(10, 10))
	staged, merged, err := productionStageDocumentParts(m, doc, artifacts, &work, call)
	if err != nil || staged {
		t.Fatalf("hole repair did not complete outline: %v", err)
	}
	var args struct {
		Document map[string]string `json:"document"`
	}
	if err := json.Unmarshal([]byte(merged.Function.Arguments), &args); err != nil {
		t.Fatal(err)
	}
	content, err := productionRenderPlanDocumentForSchema("story", "", args.Document, parts.SchemaVersion)
	if err != nil {
		t.Fatal(err)
	}
	if issues := productionPlanEpisodeArchitectureIssues(m, doc, content, parts.SchemaVersion); len(issues) > 0 {
		t.Fatalf("full outline validation failed: %v", issues)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", work.TaskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": productionRuntimeResult(t, call)}).Error; err != nil {
		t.Fatal(err)
	}
	task, _ = s.repo.Task(work.TaskID)
	if err := s.settleProductionParallel("user", run.ID, work, task); err != nil {
		t.Fatal(err)
	}
	m, doc, artifacts = orderedPlanState(t, s, run.ID)
	if !productionPlanArtifactValid(m, doc, artifacts, "story") {
		t.Fatal("corrected outline not persisted through the ordinary validator")
	}
}

func TestProductionEpisodeSubmissionDoesNotCheckpointInvalidEnvelopeOrVersions(t *testing.T) {
	m, doc := productionEpisodeArchitectureManifest(4)
	m.Plan.Version = 5
	for _, change := range []string{"unknown", "facts", "design", "target", "dependencies", "schema", "wrongTool", "tooLarge"} {
		t.Run(change, func(t *testing.T) {
			work := productionParallelWork{Key: "story", Name: "故事总纲", Dependencies: productionParallelDependencyHash(m, nil, "story"), DocumentParts: &productionDocumentParts{SchemaVersion: 2, Pending: [][]string{{"episodeArchitecture"}}, Fields: map[string]string{}}}
			values := episodeSubmissionRows(1, 4)
			delete(values[1], "action")
			if change == "tooLarge" {
				values[0]["task"] = strings.Repeat("长", productionArtifactContentLimit(m, doc, "story")+1)
			}
			call := episodeSubmissionCall(t, work, values)
			var args map[string]any
			_ = json.Unmarshal([]byte(call.Function.Arguments), &args)
			switch change {
			case "unknown":
				args["extra"] = "unexpected"
			case "facts":
				args["factIds"] = []string{"wrong"}
			case "design":
				args["design"] = map[string]any{}
			case "target":
				work.DocumentParts.ExpectedHash = "stale"
			case "dependencies":
				work.Dependencies = "stale"
			case "schema":
				work.DocumentParts.SchemaVersion++
			case "wrongTool":
				call.Function.Name = "production_read"
			}
			encoded, _ := json.Marshal(args)
			call.Function.Arguments = string(encoded)
			task := &model.Task{ResultJSON: productionRuntimeResult(t, call)}
			before := productionHash(work)
			failure := cloudAgentFieldError("document.episodeArchitecture.episode[2].action", "episode_required", "缺少行动")
			if productionPrepareEpisodeRepair(m, doc, nil, &work, task, failure) || before != productionHash(work) {
				t.Fatal("invalid response or stale version changed private state")
			}
		})
	}
}

func TestProductionEpisodeExhaustedHoldRequiresManualRetry(t *testing.T) {
	for _, key := range []string{"story", "inventory"} {
		t.Run(key, func(t *testing.T) {
			s, _, run := planFixture(t, 5)
			productionCall(t, s, run.ID, "production_read", map[string]any{"pageId": productionFirstPage(t, s, run.ID)}, false)
			mutateParallelState(t, s, run.ID, func(current *model.CloudAgentExecution, state *cloudAgentRuntime) {
				current.Status = "running"
				if key == "inventory" {
					current.Status = "waiting_user"
				}
				state.ProductionParallel[key] = productionParallelWork{Key: key, Name: key, QuietHold: true, Error: "本地内容校验未通过", AutoRetryRounds: productionParallelAutoRetryRounds, InventoryNoProgress: 3}
			})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if _, err := s.runProductionParallel(ctx, "user", run.ID); err != nil {
				t.Fatal(err)
			}
			current, _ := productionRuntimeState(t, s, run.ID)
			if current.Status != "waiting_user" {
				t.Fatalf("exhausted run still appears active: %s", current.Status)
			}
			for i := 0; i < 2; i++ {
				if s.resumeQuietHeldProduction("user", run.ID) {
					t.Fatal("exhausted hold auto-resumed")
				}
			}
			if err := s.RetryProductionAgentItem("user", run.ID, key); err != nil {
				t.Fatal(err)
			}
			current, state := productionRuntimeState(t, s, run.ID)
			work := state.ProductionParallel[key]
			if current.Status == "waiting_user" || work.QuietHold || work.AutoRetryRounds != 0 {
				t.Fatal(fmt.Sprintf("explicit retry did not clear hold: %s %+v", current.Status, work))
			}
		})
	}
}
