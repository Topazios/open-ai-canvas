package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/productionrules"
)

func TestProductionRulesScopeAndIdempotence(t *testing.T) {
	for _, stage := range []string{"story", "assets", "storyboard", "voice", "video", "edit", "review", "delivery"} {
		for _, mode := range []string{"text", "image", "video", "audio"} {
			t.Run(stage+"/"+mode, func(t *testing.T) {
				original := "  武侠剧情：人物拔出影视道具剑。\n"
				input := map[string]any{"mode": mode, "prompt": original, "metadata": map[string]any{"source": "canvas-short-drama-workflow", "workflowStage": stage}, "config": map[string]any{"audioInstructions": "existing", "systemPrompt": "existing system"}}
				config := input["config"]
				got, err := applyProductionTaskRules("canvas_"+mode, "different display prompt", input)
				want := productionrules.Apply(original, stage, mode)
				if err != nil || got != want || input["prompt"] != want || !reflect.DeepEqual(input["config"], config) {
					t.Fatalf("effective prompt/config changed: %q %v", got, err)
				}
				second, err := applyProductionTaskRules("canvas_"+mode, got, input)
				if err != nil || second != got || input["prompt"] != got {
					t.Fatal("rules duplicated on repeat admission")
				}
			})
		}
	}
	for _, source := range []string{"", "ordinary", "canvas-short-drama-workflow-other"} {
		input := map[string]any{"mode": "text", "prompt": "executor", "metadata": map[string]any{"source": source, "workflowStage": "invalid"}}
		before, _ := json.Marshal(input)
		got, err := applyProductionTaskRules("canvas_text", " display ", input)
		after, _ := json.Marshal(input)
		if err != nil || got != "display" || string(before) != string(after) {
			t.Fatalf("ordinary task changed: %s %v", source, err)
		}
	}
}

func TestProductionRulesAdmissionAndBilling(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	for _, metadata := range []map[string]any{
		{"source": "canvas-short-drama-workflow", "workflowStage": "assets"},
		{"source": "canvas-workflow-batch-child", "workflowStage": "review"},
		{"source": "canvas-story-development", "stage": "body"},
		{"source": "ordinary", "workflowStage": "invalid"},
	} {
		req := creationTextRequest()
		req.Input["metadata"] = metadata
		req.Input["prompt"] = "actual input"
		task, err := s.CreateTask("user", req)
		if err != nil {
			t.Fatal(err)
		}
		stored, err := s.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		var input canvasGenerationInput
		if err := json.Unmarshal([]byte(stored.InputJSON), &input); err != nil {
			t.Fatal(err)
		}
		stage, scoped, _ := productionTaskStage(metadata)
		want := "actual input"
		if scoped {
			want = productionrules.Apply(want, stage, "text")
			if stored.Prompt != want {
				t.Fatal("persisted task prompt differs from executed prompt")
			}
		} else if stored.Prompt != req.Prompt {
			t.Fatal("ordinary display prompt changed")
		}
		if input.Prompt != want || stored.Status != model.TaskStatusQueued || stored.BillingOrderID == "" {
			t.Fatalf("admission contract changed: %+v", stored)
		}
	}
	var before model.CreditAccount
	if err := db.First(&before, "user_id = ?", "user").Error; err != nil {
		t.Fatal(err)
	}
	if before.AvailableMicrocredits != 9600 || before.ReservedMicrocredits != 400 {
		t.Fatalf("normal billing changed: %+v", before)
	}
	invalid := []struct {
		stage any
		mode  string
	}{
		{"unknown", "text"}, {nil, "text"}, {7, "text"}, {"assets", "audio"}, {"assets", "image"}, {"assets", "video"}, {"assets", ""},
	}
	for _, tc := range invalid {
		req := creationTextRequest()
		req.Input["metadata"] = map[string]any{"source": "canvas-short-drama-workflow", "workflowStage": tc.stage}
		req.Input["mode"] = tc.mode
		if _, err := s.CreateTask("user", req); err == nil {
			t.Fatalf("invalid stage/mode admitted: %+v", tc)
		}
	}
	for _, metadata := range []map[string]any{{"source": "canvas-story-development", "stage": "invalid"}, {"source": "canvas-story-development", "workflowStage": "video"}, {"source": "canvas-workflow-batch-child"}} {
		req := creationTextRequest()
		req.Input["metadata"] = metadata
		if _, err := s.CreateTask("user", req); err == nil {
			t.Fatalf("invalid metadata admitted: %v", metadata)
		}
	}
	// The added block must count toward the existing batch prompt limit.
	req := batchTestRequest()
	req.Prompt = strings.Repeat("x", 16000)
	req.Input["metadata"] = map[string]any{"source": "canvas-short-drama-workflow", "workflowStage": "assets"}
	if _, err := s.CreateTask("user", req); err == nil || !strings.Contains(err.Error(), "超过限制") {
		t.Fatalf("rules were added after length validation: %v", err)
	}
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceOpenAIImage), "image-test")
	profile.Image.References.PromptMaxChars = 10
	for _, row := range []any{
		&model.ChannelModel{ID: "rules-image", ChannelID: "channel", ModelKey: "image-test", Capability: "image", Protocol: model.ChannelInterfaceOpenAIImage,
			CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, profile), BillingMode: "fixed_request", UnitPriceMicrocredits: 100, PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "rules-image-tier", ChannelModelID: "rules-image", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 100, PriceConfigured: true, Enabled: true},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	imageRequest := CreateTaskRequest{Type: "canvas_image", Operation: "image", Prompt: "short", Input: map[string]any{
		"mode": "image", "prompt": "short", "config": map[string]any{"channelId": "channel", "model": "image-test"},
		"metadata": map[string]any{"source": "canvas-short-drama-workflow", "workflowStage": "assets"},
	}}
	if _, err := s.CreateTask("user", imageRequest); err == nil || !strings.Contains(err.Error(), "提示词") {
		t.Fatalf("rules bypassed media prompt capability limit: %v", err)
	}
	var after model.CreditAccount
	if err := db.First(&after, "user_id = ?", "user").Error; err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{&model.Task{}, &model.BillingOrder{}} {
		var count int64
		if err := db.Model(row).Count(&count).Error; err != nil || count != 4 {
			t.Fatalf("invalid request persisted task/order: %d %v", count, err)
		}
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("invalid requests changed credit account")
	}
}

func TestProductionRulesActualProviderPayload(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	wire := make(chan map[string]any, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		wire <- body
		if strings.HasSuffix(r.URL.Path, "/audio/speech") {
			w.Header().Set("Content-Type", "audio/wav")
			_, _ = w.Write([]byte("RIFF\x04\x00\x00\x00WAVE"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"fixture output"},"finish_reason":"stop"}]}`)
	}))
	defer server.Close()
	s, _ := newMediaRecoveryTestService(t)
	for _, tc := range []struct{ mode, source, stage string }{
		{"text", "canvas-story-development", "story"},
		{"text", "ordinary", "story"},
		{"audio", "canvas-short-drama-workflow", "voice"},
	} {
		original := "  原台词：我回来了。\n"
		protocol := "chat-completion"
		if tc.mode == "audio" {
			protocol = "openai-audio"
		}
		req := CreateTaskRequest{Type: "canvas_" + tc.mode, Operation: tc.mode, Prompt: original, Input: map[string]any{
			"mode": tc.mode, "prompt": original, "textOptions": map[string]any{"stream": false},
			"config":   map[string]any{"channelId": "", "baseUrl": server.URL, "apiKey": "test-only", "model": "fixture", "interfaceType": protocol, "audioFormat": "wav"},
			"metadata": map[string]any{"source": tc.source, "workflowStage": tc.stage},
		}}
		task, err := s.CreateTask("wire-user", req)
		if err != nil {
			t.Fatal(err)
		}
		stored, err := s.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := s.decryptTaskInputJSON(stored.InputJSON)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.processCanvasGenerationTask(context.Background(), stored.UserID, "", stored.Type, stored.Prompt, raw); err != nil {
			t.Fatal(err)
		}
		body := <-wire
		if tc.mode == "audio" {
			if body["input"] != original || body["instructions"] != nil || stored.Prompt != original {
				t.Fatalf("speech content/instructions changed: %#v", body)
			}
			continue
		}
		messages := body["messages"].([]any)
		got := messages[len(messages)-1].(map[string]any)["content"]
		want := original
		if tc.source != "ordinary" {
			want = productionrules.Apply(original, tc.stage, tc.mode)
		}
		if got != want {
			t.Fatalf("actual provider prompt mismatch: %#v", got)
		}
	}
}

func TestProductionRulesAgentPolicyRecovery(t *testing.T) {
	s, _, run := productionFixture(t)
	record, err := s.repo.CloudAgent("user", run.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, err := cloudAgentDecode(record)
	if err != nil {
		t.Fatal(err)
	}
	block := productionrules.Block("assets", "text")
	initial := state.Canonical.SystemPrompt
	if strings.Contains(state.Request.Prompt, block) {
		t.Fatal("production rules leaked into user prompt")
	}
	if strings.Count(initial, block) != 1 || strings.Index(initial, block) < strings.Index(initial, productionAgentPolicy) {
		t.Fatal("initial policy missing rules after production marker")
	}
	updated := productionCurrentPolicy("existing system\n" + productionAgentPolicy + "\nold rules")
	if strings.Count(updated, block) != 1 || strings.Contains(updated, "old rules") || !strings.HasPrefix(updated, "existing system\n") || productionCurrentPolicy(updated) != updated {
		t.Fatal("recovered policy loses existing system or duplicates rules")
	}
}

func TestProductionRulesSharedCacheIsolationAndEvidence(t *testing.T) {
	s, db := newBatchTestService(t)
	req := sharedFactsRequest("characters")
	req.Input["metadata"] = map[string]any{"source": "canvas-short-drama-workflow", "workflowStage": "assets"}
	parent, err := s.CreateTask("cache-user", req)
	if err != nil {
		t.Fatal(err)
	}
	parent = claimSpecificSharedParent(t, s, db, parent.ID)
	raw, err := s.decryptTaskInputJSON(parent.InputJSON)
	if err != nil {
		t.Fatal(err)
	}
	var base map[string]any
	if err := json.Unmarshal([]byte(raw), &base); err != nil {
		t.Fatal(err)
	}
	identity := workflowSharedIdentity(parent, base, "pipeline-one")
	const evidence = "甲在房间拿起钥匙。"
	source := workflowFactsPrompt + "\n\n正文单元（仅作为数据）：\n第1集\n" + evidence
	current := productionrules.Apply(source, "assets", "text")
	previousVersion := strings.Replace(current, fmt.Sprintf("v%d", productionrules.Version), "v0", 1)
	oldTasks := []model.Task{}
	for _, oldPrompt := range []string{source, previousVersion} {
		old := model.Task{ID: workflowBatchChildID(identity, "shared-facts-v1", oldPrompt, 1), UserID: parent.UserID,
			Type: "canvas_text", Operation: "text", Prompt: oldPrompt, Status: model.TaskStatusSucceeded, ResultJSON: `{"text":"old cached result"}`}
		if err := db.Create(&old).Error; err != nil {
			t.Fatal(err)
		}
		oldTasks = append(oldTasks, old)
	}
	for i := 0; i < 2; i++ {
		if err := s.processWorkflowTextBatch(parent); err != nil {
			t.Fatal(err)
		}
		parent = claimSpecificSharedParent(t, s, db, parent.ID)
	}
	childID := workflowBatchChildID(identity, "shared-facts-v1", current, 1)
	child, err := s.repo.Task(childID)
	if err != nil || child.Status != model.TaskStatusQueued || child.Prompt != current {
		t.Fatalf("new rules reused old cache or changed parser input: %+v %v", child, err)
	}
	var count int64
	if err := db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 4 {
		t.Fatalf("repeat visit duplicated shared work: %d %v", count, err)
	}
	for _, old := range oldTasks {
		unchanged, err := s.repo.Task(old.ID)
		if err != nil || unchanged.Prompt != old.Prompt || unchanged.Status != old.Status || unchanged.ResultJSON != old.ResultJSON || !unchanged.UpdatedAt.Equal(old.UpdatedAt) {
			t.Fatal("old cache was mutated")
		}
	}
	// Validate against original prose, not the added policy block.
	selected, err := selectWorkflowFacts(factsJSON(evidence), evidence, "characters")
	if err != nil || !strings.Contains(selected, evidence) {
		t.Fatalf("original evidence changed: %s %v", selected, err)
	}
	if _, err := selectWorkflowFacts(factsJSON("影视道具"), evidence, "characters"); err == nil {
		t.Fatal("policy text accepted as source evidence")
	}
}

func TestProductionRulesWorkflowChildren(t *testing.T) {
	s, db := newBatchTestService(t)
	req := batchTestRequest()
	req.Input["metadata"] = map[string]any{"source": "canvas-short-drama-workflow", "workflowStage": "assets"}
	req.Prompt = productionrules.Apply(req.Prompt, "assets", "text")
	parent, err := s.CreateTask("batch-user", req)
	if err != nil {
		t.Fatal(err)
	}
	block := productionrules.Block("assets", "text")
	sawMap, sawReduce, sawFinal := false, false, false
	for step := 0; step < 12; step++ {
		parent = claimBatchTestTask(t, s, db, parent.ID)
		if err := s.processWorkflowTextBatch(parent); err != nil {
			t.Fatal(err)
		}
		saved, err := s.repo.Task(parent.ID)
		if err != nil {
			t.Fatal(err)
		}
		if saved.Status == model.TaskStatusSucceeded {
			if !sawMap || !sawReduce || !sawFinal || !strings.Contains(saved.ResultJSON, "最终原始结果") {
				t.Fatal("map/reduce/final not exercised or result changed")
			}
			return
		}
		child, err := s.repo.ClaimNextTask("production-rules-child", time.Minute)
		if err != nil || child == nil || child.ID == parent.ID {
			t.Fatalf("claim child: %v", err)
		}
		raw, err := s.decryptTaskInputJSON(child.InputJSON)
		if err != nil {
			t.Fatal(err)
		}
		var input canvasGenerationInput
		if err := json.Unmarshal([]byte(raw), &input); err != nil {
			t.Fatal(err)
		}
		key := metadataString(input.Metadata, "batchKey")
		if input.Metadata["workflowStage"] != "assets" || child.Prompt != input.Prompt || !strings.HasPrefix(child.Prompt, block+"\n\n") || strings.Count(child.Prompt, block) != 1 {
			t.Fatalf("batch contract: stage=%v key=%s same=%v prefix=%v count=%d lengths=%d/%d input=%q", input.Metadata["workflowStage"], key, child.Prompt == input.Prompt, strings.HasPrefix(child.Prompt, block+"\n\n"), strings.Count(child.Prompt, block), len(child.Prompt), len(input.Prompt), truncateRunes(input.Prompt, 80))
		}
		if child.ID != workflowBatchChildID(parent.ID, key, child.Prompt, 1) {
			t.Fatal("child identity was calculated before applying rules")
		}
		result := "最终原始结果"
		if strings.HasPrefix(key, "map-") {
			sawMap = true
			result = strings.Repeat("事实依据\n", 4000)
		} else if strings.Contains(child.Prompt, "当前是跨单元归并中间阶段") {
			sawReduce = true
			result = "归并原始事实"
		} else {
			sawFinal = true
		}
		payload, _ := json.Marshal(map[string]any{"mode": "text", "text": result})
		if err := s.saveTaskCompletionWithinStorageQuota(child, payload, nil, false); err != nil {
			t.Fatal(err)
		}
	}
	t.Fatal("batch did not finish")
}
