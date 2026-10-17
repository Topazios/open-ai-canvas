package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

func TestSharedWorkflowFactsConcurrentConsumersAndCancellation(t *testing.T) {
	s, db := newBatchTestService(t)
	policy := defaultRuntimePolicy()
	policy.Task.ActiveTaskLimit = 10
	if _, err := s.UpdateRuntimePolicySetting(&model.User{ID: "admin", Role: model.UserRoleAdmin}, policy); err != nil {
		t.Fatal(err)
	}
	parents := []*model.Task{}
	for _, category := range []string{"characters", "environments"} {
		parent, err := s.CreateTask("concurrent", sharedFactsRequest(category))
		if err != nil {
			t.Fatal(err)
		}
		parents = append(parents, claimSpecificSharedParent(t, s, db, parent.ID))
	}
	var wg sync.WaitGroup
	failures := make(chan error, 2)
	for _, parent := range parents {
		wg.Add(1)
		go func(p *model.Task) { defer wg.Done(); failures <- s.processWorkflowTextBatch(p) }(parent)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	var children []model.Task
	db.Where("operation = ?", "text").Find(&children)
	if len(children) != 2 {
		t.Fatalf("duplicate concurrent parse: %d", len(children))
	}
	if _, err := s.taskLifecycle().cancelTask(context.Background(), "concurrent", parents[0].ID); err != nil {
		t.Fatal(err)
	}
	child, _ := s.repo.Task(children[0].ID)
	if child.Status != model.TaskStatusQueued {
		t.Fatalf("consumer cancelled shared child: %s", child.Status)
	}
	if err := s.processWorkflowTextBatch(claimSpecificSharedParent(t, s, db, parents[1].ID)); err != nil {
		t.Fatal(err)
	}
	var count int64
	db.Model(&model.Task{}).Where("operation = ?", "text").Count(&count)
	if count != 2 {
		t.Fatal("remaining consumer repeated parse")
	}
}

func TestSharedWorkflowFactsInvalidOutputRetriesOnlyAfterExplicitParentRetry(t *testing.T) {
	s, db := newBatchTestService(t)
	parent, err := s.CreateTask("retry-facts", sharedFactsRequest("characters"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.processWorkflowTextBatch(claimSpecificSharedParent(t, s, db, parent.ID)); err != nil {
		t.Fatal(err)
	}
	before := finishBatchTestChild(t, s, db, "解析结果不是完整JSON", false)
	if err := s.processWorkflowTextBatch(claimSpecificSharedParent(t, s, db, parent.ID)); err != nil {
		t.Fatal(err)
	}
	failed, _ := s.repo.Task(parent.ID)
	if failed.Status != model.TaskStatusFailed {
		t.Fatal("invalid facts counted as success")
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 2 {
		t.Fatal("invalid output automatically retried")
	}
	if _, err := s.taskLifecycle().retryTask(parent.UserID, parent.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.processWorkflowTextBatch(claimSpecificSharedParent(t, s, db, parent.ID)); err != nil {
		t.Fatal(err)
	}
	after := finishBatchTestChild(t, s, db, factsJSON("甲在房间拿起钥匙。"), false)
	if after.ID == before.ID {
		t.Fatal("retry overwrote original facts result")
	}
	raw, _ := s.repo.Task(before.ID)
	if !strings.Contains(raw.ResultJSON, "解析结果不是完整JSON") {
		t.Fatal("failed semantic output lost")
	}
}

func TestSharedWorkflowFactsRealWorkerReusesParserAcrossOutputs(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var calls, parses atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		raw, _ := io.ReadAll(r.Body)
		text := `{"summary":"正文分类资产","items":[{"name":"故事设定","section":"settings","content":"原文事实"},{"name":"表现风格","section":"style","content":"风格待确认"}]}`
		if strings.Contains(string(raw), "你是短剧正文事实解析器") {
			parses.Add(1)
			evidence := "甲离开房间。"
			if strings.Contains(string(raw), "甲在房间拿起钥匙。") {
				evidence = "甲在房间拿起钥匙。"
			}
			text = factsJSON(evidence)
		}
		encoded, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": text}}}})
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", encoded)
	}))
	defer server.Close()
	initial, db := newBatchTestService(t)
	s := New(repository.New(db), initial.dataDir)
	for _, category := range []string{"bible", "characters", "environments", "props", "special"} {
		req := sharedFactsRequest(category)
		req.Input["config"].(map[string]any)["baseUrl"] = server.URL
		parent, err := s.CreateTask("shared-worker-user", req)
		if err != nil {
			t.Fatal(err)
		}
		completed := false
		for turn := 0; turn < 12; turn++ {
			var queued int64
			db.Model(&model.Task{}).Where("operation <> ? AND status = ?", workflowBatchOperation, model.TaskStatusQueued).Count(&queued)
			if queued == 0 {
				db.Model(&model.Task{}).Where("id = ?", parent.ID).Update("next_poll_at", nil)
			}
			if err := s.taskWorker().processNextTask(); err != nil {
				t.Fatal(err)
			}
			current, _ := s.repo.Task(parent.ID)
			if current.Status == model.TaskStatusFailed {
				t.Fatalf("%s: %s", category, current.Error)
			}
			if current.Status == model.TaskStatusSucceeded {
				completed = true
				break
			}
		}
		if !completed {
			t.Fatalf("%s did not finish", category)
		}
	}
	if parses.Load() != 2 || calls.Load() != 7 {
		t.Fatalf("wanted 2 shared parses + 5 outputs, got parses=%d calls=%d", parses.Load(), calls.Load())
	}
}

func sharedFactsRequest(category string) CreateTaskRequest {
	req := batchTestRequest()
	req.Prompt = "生成" + category
	req.Input["workflowBatch"] = workflowTextBatch{Version: 2, Scope: "pipeline-one", Category: category,
		Units:   []workflowTextUnit{{Label: "第1集", Text: "甲在房间拿起钥匙。"}, {Label: "第2集", Text: "甲离开房间。"}},
		Context: []workflowTextUnit{{Label: "制作方案", Text: "计划12集；黑白风格"}}}
	return req
}

func claimSpecificSharedParent(t *testing.T, s *Service, db *gorm.DB, id string) *model.Task {
	t.Helper()
	if err := db.Model(&model.Task{}).Where("id = ?", id).Updates(map[string]any{"status": model.TaskStatusRunning, "lease_owner": "shared-test", "lease_expires_at": time.Now().Add(time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	task, err := s.repo.Task(id)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func factsJSON(evidence string) string {
	facts := []workflowFact{
		{Kind: "character", Name: "甲", Aliases: []string{}, Description: "正文人物", Evidence: evidence},
		{Kind: "environment", Name: "房间", Aliases: []string{}, Description: "正文空间", Evidence: evidence},
	}
	result, _ := json.Marshal(map[string]any{"facts": facts})
	return string(result)
}

func TestWorkflowEvidenceRecoversOnlyVerifiableSourceSpans(t *testing.T) {
	source := "**甲：**把钥匙给我。\r\n\r\n乙看了一眼门口。\r\n\r\n**乙：**就在桌上。"
	for _, evidence := range []string{source, "**甲：**把钥匙给我。\n\n**乙：**就在桌上。", `**甲：**把钥匙给我。\n\n**乙：**就在桌上。`} {
		located, ok := locateWorkflowEvidence(source, evidence)
		if !ok || located != source {
			t.Fatalf("source span lost: %q %v", located, ok)
		}
		if _, err := selectWorkflowFacts(factsJSON(evidence), source, "characters"); err != nil {
			t.Fatal(err)
		}
	}
	for _, invalid := range []string{"", "**甲：**把金条给我。", "**乙：**就在桌上。\n**甲：**把钥匙给我。", "**甲：**把钥匙给我。\n不存在的对白。"} {
		if _, ok := locateWorkflowEvidence(source, invalid); ok {
			t.Fatalf("invalid evidence: %q", invalid)
		}
	}
	if _, ok := locateWorkflowEvidence("甲拿起钥匙。"+strings.Repeat("无关场次。", 200)+"乙关上大门。", "甲拿起钥匙。\n乙关上大门。"); ok {
		t.Fatal("distant scenes joined")
	}
}

func TestWorkflowEvidenceNormalizesPunctuationWhitespaceAndMarkdown(t *testing.T) {
	source := "**林岚：**\r\n林岚提着旧相机，走进照相馆。\r\n她停在门口。"
	cases := []string{
		"林岚提着旧相机，走进照相馆。",
		"林岚提着旧相机, 走进照相馆.",
		"**林岚：** 林岚提着旧相机，\n走进照相馆。",
	}
	for _, evidence := range cases {
		located, ok := locateWorkflowEvidence(source, evidence)
		if !ok || located != "林岚提着旧相机，走进照相馆。" && located != "**林岚：**\r\n林岚提着旧相机，走进照相馆。" {
			t.Fatalf("normalized evidence was not recovered: %q %v", located, ok)
		}
	}
	if _, ok := locateWorkflowEvidence(source, "林岚不存在的动作。"); ok {
		t.Fatal("paraphrased evidence accepted")
	}
	if _, ok := locateWorkflowEvidence(source, "林岚"); ok {
		t.Fatal("too-short evidence accepted")
	}
}

func TestWorkflowAssetResultRejectsFalseEmptySuccess(t *testing.T) {
	empty := `{"summary":"没有提供正文","items":[]}`
	if validateWorkflowAssetResult(empty, "characters", true) == nil {
		t.Fatal("known characters lost silently")
	}
	if err := validateWorkflowAssetResult(`{"summary":"本次正文没有特殊资产","items":[]}`, "special", false); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{`{}`, `{"summary":"done","items":null}`, "未提供正文", `{"summary":"done","items":[{"name":"甲"}]}`} {
		if validateWorkflowAssetResult(invalid, "characters", true) == nil {
			t.Fatal("invalid output accepted")
		}
	}
}

func TestWorkflowFinalRetryRetainsParsedFacts(t *testing.T) {
	s, db := newBatchTestService(t)
	parent, err := s.CreateTask("final-retry", sharedFactsRequest("characters"))
	if err != nil {
		t.Fatal(err)
	}
	for _, evidence := range []string{"甲在房间拿起钥匙。", "甲离开房间。"} {
		if err := s.processWorkflowTextBatch(claimSpecificSharedParent(t, s, db, parent.ID)); err != nil {
			t.Fatal(err)
		}
		finishBatchTestChild(t, s, db, factsJSON(evidence), false)
	}
	if err := s.processWorkflowTextBatch(claimSpecificSharedParent(t, s, db, parent.ID)); err != nil {
		t.Fatal(err)
	}
	bad := finishBatchTestChild(t, s, db, `{"summary":"没有正文","items":[]}`, false)
	if err := s.processWorkflowTextBatch(claimSpecificSharedParent(t, s, db, parent.ID)); err != nil {
		t.Fatal(err)
	}
	failed, _ := s.repo.Task(parent.ID)
	if failed.Status != model.TaskStatusFailed || !strings.Contains(failed.Error, "分类结果为空") {
		t.Fatalf("false success: %+v", failed)
	}
	if _, err := s.taskLifecycle().retryTask(parent.UserID, parent.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.processWorkflowTextBatch(claimSpecificSharedParent(t, s, db, parent.ID)); err != nil {
		t.Fatal(err)
	}
	good := finishBatchTestChild(t, s, db, `{"summary":"已提取正文人物","items":[{"name":"甲","content":"依据正文整理人物"}]}`, false)
	if good.ID == bad.ID || strings.Contains(good.Prompt, "你是短剧正文事实解析器") {
		t.Fatal("retry repeated parser or overwrote result")
	}
	if err := s.processWorkflowTextBatch(claimSpecificSharedParent(t, s, db, parent.ID)); err != nil {
		t.Fatal(err)
	}
	done, _ := s.repo.Task(parent.ID)
	if done.Status != model.TaskStatusSucceeded {
		t.Fatalf("retry did not finish: %s", done.Error)
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 5 {
		t.Fatalf("expected parent + 2 parses + 2 final attempts, got %d", count)
	}
}

func TestSharedWorkflowFactsSeparateContextValidateEvidenceAndScope(t *testing.T) {
	request := sharedFactsRequest("characters")
	input, _ := normalizeTaskInput(request.Input)
	if batch, err := validateWorkflowTextBatch(request.Type, request.Prompt, input); err != nil || len(batch.Units) != 2 || len(batch.Context) != 1 {
		t.Fatalf("v2: %+v %v", batch, err)
	}
	for _, category := range []string{"", "arbitrary", "bible|characters"} {
		batch := request.Input["workflowBatch"].(workflowTextBatch)
		batch.Category = category
		input["workflowBatch"] = batch
		if _, err := validateWorkflowTextBatch(request.Type, request.Prompt, input); err == nil {
			t.Fatalf("invalid category: %s", category)
		}
	}
	selected, err := selectWorkflowFacts(factsJSON("甲在房间拿起钥匙。"), "甲在房间拿起钥匙。", "characters")
	if err != nil || strings.Contains(selected, `"kind":"environment"`) || !strings.Contains(selected, `"kind":"character"`) {
		t.Fatalf("filter: %s %v", selected, err)
	}
	for _, invalid := range []string{`{}`, `{"facts":null}`, `{"facts":[`, factsJSON("虚构证据")} {
		if _, err := selectWorkflowFacts(invalid, "甲在房间拿起钥匙。", "bible"); err == nil {
			t.Fatalf("invalid evidence accepted: %s", invalid)
		}
	}
	parent := &model.Task{UserID: "owner", ProjectID: "project", Model: "model"}
	a := workflowSharedIdentity(parent, request.Input, "pipeline-one")
	for _, change := range []string{"user", "project", "model", "scope", "credential"} {
		p := *parent
		next := sharedFactsRequest("environments").Input
		scope := "pipeline-one"
		switch change {
		case "user":
			p.UserID = "another"
		case "project":
			p.ProjectID = "another"
		case "model":
			p.Model = "another"
		case "scope":
			scope = "another"
		case "credential":
			next["config"].(map[string]any)["apiKey"] = "another"
		}
		if a == workflowSharedIdentity(&p, next, scope) {
			t.Fatalf("cache crossed %s boundary", change)
		}
	}
}

func TestSharedWorkflowFactsReuseRunningAndCompletedWorkAcrossCategoriesAndRestart(t *testing.T) {
	s, db := newBatchTestService(t)
	policy := defaultRuntimePolicy()
	policy.Task.ActiveTaskLimit = 10
	if _, err := s.UpdateRuntimePolicySetting(&model.User{ID: "admin", Role: model.UserRoleAdmin}, policy); err != nil {
		t.Fatal(err)
	}
	parents := []*model.Task{}
	for _, category := range []string{"characters", "environments"} {
		parent, err := s.CreateTask("shared-user", sharedFactsRequest(category))
		if err != nil {
			t.Fatal(err)
		}
		parents = append(parents, parent)
	}
	for unit, evidence := range []string{"甲在房间拿起钥匙。", "甲离开房间。"} {
		for _, parent := range parents {
			p := claimSpecificSharedParent(t, s, db, parent.ID)
			if err := s.processWorkflowTextBatch(p); err != nil {
				t.Fatal(err)
			}
		}
		var children []model.Task
		db.Where("operation = ? AND status = ?", "text", model.TaskStatusQueued).Find(&children)
		if len(children) != 2-unit {
			t.Fatalf("unit %d repeated work: %d", unit, len(children))
		}
		childID := ""
		for _, child := range children {
			if strings.Contains(child.Prompt, "计划12集") || strings.Contains(child.Prompt, "生成characters") || strings.Contains(child.Prompt, "生成environments") {
				t.Fatal("output requirements or plan entered shared prose parsing")
			}
			if strings.Contains(child.Prompt, evidence) {
				childID = child.ID
			}
		}
		if childID == "" {
			t.Fatal("requested unit was not scheduled")
		}
		child := claimSpecificSharedParent(t, s, db, childID)
		payload, _ := json.Marshal(map[string]any{"mode": "text", "text": factsJSON(evidence)})
		if err := s.saveTaskCompletionWithinStorageQuota(child, payload, nil, false); err != nil {
			t.Fatal(err)
		}
		s = &Service{repo: repository.New(db), dataDir: s.dataDir}
	}
	for _, parent := range parents {
		if err := s.processWorkflowTextBatch(claimSpecificSharedParent(t, s, db, parent.ID)); err != nil {
			t.Fatal(err)
		}
	}
	var merges []model.Task
	db.Where("operation = ? AND status = ?", "text", model.TaskStatusQueued).Find(&merges)
	if len(merges) != 2 {
		t.Fatalf("independent outputs missing: %d", len(merges))
	}
	for _, merge := range merges {
		if !strings.Contains(merge.Prompt, "计划12集") {
			t.Fatal("production constraints lost")
		}
		if strings.Contains(merge.Prompt, "生成characters") && strings.Contains(merge.Prompt, `"kind":"environment"`) {
			t.Fatal("unrelated category injected")
		}
	}
	// Cancel one consumer while the other finishes; shared facts remain usable.
	db.Model(&model.Task{}).Where("id = ?", parents[0].ID).Update("status", model.TaskStatusCancelled)
	later, err := s.CreateTask("shared-user", sharedFactsRequest("props"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.processWorkflowTextBatch(claimSpecificSharedParent(t, s, db, later.ID)); err != nil {
		t.Fatal(err)
	}
	var parsed int64
	db.Model(&model.Task{}).Where("status = ? AND operation = ?", model.TaskStatusSucceeded, "text").Count(&parsed)
	if parsed != 2 {
		t.Fatalf("shared fact count: %d", parsed)
	}
	stored, _ := s.repo.Task(later.ID)
	if !strings.Contains(stored.Stage, "正文解析已复用") {
		t.Fatalf("reuse not visible: %s", stored.Stage)
	}
	changed := sharedFactsRequest("special")
	batch := changed.Input["workflowBatch"].(workflowTextBatch)
	batch.Units[1].Text = "甲回到房间。"
	changed.Input["workflowBatch"] = batch
	edited, err := s.CreateTask("shared-user", changed)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.processWorkflowTextBatch(claimSpecificSharedParent(t, s, db, edited.ID)); err != nil {
		t.Fatal(err)
	}
	stored, _ = s.repo.Task(edited.ID)
	if !strings.Contains(stored.Stage, "共享正文解析 · 已完成 1/2") {
		t.Fatalf("unchanged unit reparsed: %s", stored.Stage)
	}
}
