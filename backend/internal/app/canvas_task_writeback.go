package app

import (
	"context"
	"errors"
	"log"
	"math/rand"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

// 任务进入终态后由后端把结果写回画布节点，浏览器是否在线不影响结果落地。
//
// 并发约束：
//   - 每次尝试都重读最新画布，只改目标节点的字段，不覆盖用户在前端做的其他修改。
//   - 版本冲突时重读后重试，不把冲突抛给用户。
//   - 同一画布的回写在进程内串行，减少与自身的竞争。

const canvasWritebackMaxAttempts = 5

func canvasTaskStatusTerminal(status string) bool {
	switch model.TaskStatus(status) {
	case model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled:
		return true
	}
	return false
}

func canvasTaskCanvasID(task model.Task) string {
	return strings.TrimSpace(task.ProjectID)
}

// writeTaskResultToCanvas 把终态任务的结果写入对应节点。
// 任务不属于普通画布节点、画布或节点不存在、节点已绑定其他任务时直接跳过。
func (s *Service) writeTaskResultToCanvas(ctx context.Context, task model.Task) error {
	return s.writeTaskResultToCanvasID(ctx, task, canvasTaskCanvasID(task))
}

// canvasMediaResourceUnavailableMessage 是任务成功但结果资源还不可用时写给节点的可见提示。
const canvasMediaResourceUnavailableMessage = "生成结果已保存,但资源暂不可用"

// canvasNodeTaskUnsettled 判断节点的任务状态是否还没收敛：
// 任务状态非终态，或任务已成功但节点还没拿到内容。
func canvasNodeTaskUnsettled(doc map[string]any, targetID string) bool {
	for _, node := range creationMaps(doc["nodes"]) {
		if stringValue(node["id"]) != targetID {
			continue
		}
		meta, _ := node["metadata"].(map[string]any)
		status := stringValue(meta["taskStatus"])
		if !canvasTaskStatusTerminal(status) {
			return true
		}
		return status == string(model.TaskStatusSucceeded) &&
			stringValue(meta["status"]) != "success" &&
			stringValue(meta["content"]) == ""
	}
	return false
}

func (s *Service) writeTaskResultToCanvasID(ctx context.Context, task model.Task, canvasID string) error {
	if !canvasTaskStatusTerminal(string(task.Status)) {
		return nil
	}
	target, agent := canvasTaskTarget(task)
	if agent || target == "" || canvasID == "" || task.UserID == "" {
		return nil
	}
	var resource *model.Resource
	if task.Status == model.TaskStatusSucceeded {
		if id, _ := taskOutputResource(task.ResultJSON, task.Type); id != "" {
			if item, err := s.repo.ResourceForUser(task.UserID, id); err == nil && item != nil && item.Status == "ready" && s.resourceObjectUsable(item) {
				resource = item
				resource.ID = id
			}
		}
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	return saveCanvasDocumentWithRetry(ctx, s.repo, task.UserID, canvasID, policy, func(doc map[string]any) bool {
		return applyTaskResultToCanvasDoc(doc, task, target, resource)
	})
}

// saveCanvasDocumentWithRetry 每次尝试都基于最新画布重新应用补丁。
// 补丁返回 false 表示无需写入。画布不存在时视为无事可做。
func saveCanvasDocumentWithRetry(ctx context.Context, repo *repository.Repository, userID, canvasID string, policy RuntimePolicySetting, patch func(doc map[string]any) bool) error {
	var lastErr error
	for attempt := 0; attempt < canvasWritebackMaxAttempts; attempt++ {
		if attempt > 0 {
			delay := time.Duration(attempt)*40*time.Millisecond + time.Duration(rand.Intn(60))*time.Millisecond
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(delay):
			}
		}
		canvas, err := repo.CanvasProjectForUser(userID, canvasID)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		doc, err := creationDocument(canvas.PayloadJSON)
		if err != nil {
			return err
		}
		if !patch(doc) {
			return nil
		}
		err = saveCloudAgentDocument(repo, canvas, doc, policy)
		if err == nil {
			return nil
		}
		if !errors.Is(err, repository.ErrCreationConflict) && !errors.Is(err, repository.ErrCanvasRevisionConflict) {
			return err
		}
		lastErr = err
	}
	return lastErr
}

func canvasNodeMetadata(node map[string]any) map[string]any {
	meta, _ := node["metadata"].(map[string]any)
	if meta == nil {
		meta = map[string]any{}
		node["metadata"] = meta
	}
	return meta
}

func canvasTaskTime(value *time.Time) string {
	if value == nil || value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

// applyTaskResultToCanvasDoc 是纯函数：只修改 doc 里的目标节点，返回是否有改动。
func applyTaskResultToCanvasDoc(doc map[string]any, task model.Task, targetID string, resource *model.Resource) bool {
	nodes := creationMaps(doc["nodes"])
	var node map[string]any
	for _, item := range nodes {
		if stringValue(item["id"]) == targetID {
			node = item
			break
		}
	}
	if node == nil {
		return false
	}
	meta := canvasNodeMetadata(node)
	isScreenplayReview := false
	if _, ok := meta["shortDrama"].(map[string]any); ok {
		sd := meta["shortDrama"].(map[string]any)
		if sd["screenplayRepair"] != nil || sd["screenplayAudit"] != nil {
			isScreenplayReview = true
		}
		if isScreenplayReview && task.Status == model.TaskStatusSucceeded {
			return false
		}
	}
	if meta["emotionEdit"] != nil {
		return false
	}
	boundID := stringValue(meta["taskId"])
	content := stringValue(meta["content"])
	if isScreenplayReview {
		if boundID != "" && boundID != task.ID {
			log.Printf("canvas writeback skipped: diagnostic node %s bound to task %s, finished task=%s", targetID, boundID, task.ID)
			return false
		}
		if boundID == "" {
			state := stringValue(meta["status"])
			if state != "loading" && state != "idle" {
				log.Printf("canvas writeback skipped: diagnostic node %s is not awaiting a task, task=%s", targetID, task.ID)
				return false
			}
		}
		switch task.Status {
		case model.TaskStatusFailed:
			meta["status"] = "error"
			meta["errorDetails"] = cloudAgentSafeMediaTaskError(&task)
		case model.TaskStatusCancelled:
			if content != "" {
				meta["status"] = "success"
			} else {
				meta["status"] = "idle"
			}
		default:
			return false
		}
		writeCommonTaskMetadata(meta, task)
		return true
	}
	switch {
	case boundID == task.ID:
	case boundID == "":
		state := stringValue(meta["status"])
		if content != "" || (state != "" && state != "loading" && state != "idle") {
			log.Printf("canvas writeback skipped: node %s already has content or state, task=%s", targetID, task.ID)
			return false
		}
	default:
		log.Printf("canvas writeback skipped: node %s bound to task %s, finished task=%s", targetID, boundID, task.ID)
		return false
	}
	nodeType := stringValue(node["type"])
	resourceUnavailable := false
	switch task.Status {
	case model.TaskStatusSucceeded:
		if boundID == task.ID && stringValue(meta["taskStatus"]) == string(model.TaskStatusSucceeded) &&
			stringValue(meta["status"]) == "success" && content != "" {
			return false
		}
		if !applyTaskSuccess(doc, node, meta, task, nodeType, resource) {
			if nodeType != "image" && nodeType != "video" && nodeType != "audio" {
				return false
			}
			// 媒体任务已成功但资源还取不到：写成可见状态，资源就绪后补偿会改回成功。
			if boundID == task.ID && stringValue(meta["taskStatus"]) == string(model.TaskStatusSucceeded) &&
				stringValue(meta["status"]) == "error" &&
				stringValue(meta["errorDetails"]) == canvasMediaResourceUnavailableMessage {
				return false
			}
			resourceUnavailable = true
		}
	case model.TaskStatusFailed:
		if boundID == task.ID && stringValue(meta["taskStatus"]) == string(task.Status) && stringValue(meta["status"]) == "error" {
			return false
		}
		meta["status"] = "error"
		meta["errorDetails"] = cloudAgentSafeMediaTaskError(&task)
	case model.TaskStatusCancelled:
		if boundID == task.ID && stringValue(meta["taskStatus"]) == string(task.Status) {
			return false
		}
		if content == "" {
			meta["status"] = "idle"
		}
	default:
		return false
	}
	writeCommonTaskMetadata(meta, task)
	if resourceUnavailable {
		// 必须在 writeCommonTaskMetadata 之后设置，它会在成功态清掉 errorDetails。
		meta["status"] = "error"
		meta["errorDetails"] = canvasMediaResourceUnavailableMessage
	}
	return true
}

func writeCommonTaskMetadata(meta map[string]any, task model.Task) {
	progress := task.Progress
	if progress < 0 || progress > 100 || (progress == 0 && task.Status == model.TaskStatusSucceeded) {
		progress = 100
	}
	meta["taskId"] = task.ID
	meta["taskStatus"] = string(task.Status)
	meta["taskProgress"] = progress
	meta["taskStage"] = task.Stage
	meta["taskMediaStage"] = task.MediaStage
	meta["taskCanRecoverMedia"] = false
	if v := canvasTaskTime(task.StartedAt); v != "" {
		meta["taskStartedAt"] = v
	}
	if v := canvasTaskTime(task.CompletedAt); v != "" {
		meta["taskCompletedAt"] = v
	}
	if task.StartedAt != nil && task.CompletedAt != nil {
		duration := task.CompletedAt.Sub(*task.StartedAt).Milliseconds()
		if duration < 0 {
			duration = 0
		}
		meta["taskDurationMs"] = duration
	}
	if !task.CreatedAt.IsZero() {
		meta["taskCreatedAt"] = task.CreatedAt.UTC().Format(time.RFC3339Nano)
	}
	if !task.UpdatedAt.IsZero() {
		meta["taskUpdatedAt"] = task.UpdatedAt.UTC().Format(time.RFC3339Nano)
	}
	if task.Status == model.TaskStatusSucceeded {
		delete(meta, "errorDetails")
		delete(meta, "generationErrorCode")
		delete(meta, "failedPromptFingerprint")
	}
}

func applyTaskSuccess(doc map[string]any, node, meta map[string]any, task model.Task, nodeType string, resource *model.Resource) bool {
	if nodeType == "text" {
		text := taskResultText(task.ResultJSON)
		if text == "" {
			return false
		}
		meta["content"] = text
		meta["richText"] = ""
		if task.Prompt != "" {
			meta["prompt"] = task.Prompt
		}
		meta["status"] = "success"
		delete(meta, "errorDetails")
		delete(meta, "generationErrorCode")
		delete(meta, "resourceReloadAvailable")
		delete(meta, "failedPromptFingerprint")
		return true
	}
	if nodeType != "image" && nodeType != "video" && nodeType != "audio" {
		return false
	}
	if resource == nil || resource.ID == "" || !strings.HasPrefix(resource.MimeType, nodeType+"/") {
		return false
	}
	meta["content"] = resourceFileURL(resource.ID)
	meta["storageKey"] = "resource:" + resource.ID
	meta["status"] = "success"
	meta["naturalWidth"], meta["naturalHeight"] = resource.Width, resource.Height
	// 旧素材配新资源会被云端永久拒绝，所以必须清掉。
	delete(meta, "assetId")
	switch nodeType {
	case "image":
		meta["bytes"] = resource.Size
		meta["mimeType"] = resource.MimeType
		if task.Prompt != "" {
			meta["prompt"] = task.Prompt
		}
		for _, key := range []string{"resourceReloadAvailable", "workflowProvider", "runningHubWorkflowId", "runningHubWorkflowKind", "workflowParameters"} {
			delete(meta, key)
		}
		produced := strings.TrimSpace(stringValue(meta["producedModelCandidate"]))
		if produced == "" {
			produced = strings.TrimSpace(task.Model)
		}
		delete(meta, "producedModelCandidate")
		if produced != "" {
			meta["producedModel"] = produced
		} else {
			delete(meta, "producedModel")
		}
		if manual, _ := meta["manualSize"].(bool); !manual {
			resizeNodeHeight(node, resource)
		}
	case "video":
		meta["durationMs"] = resource.DurationMs
		meta["mimeType"] = resource.MimeType
		if locked, _ := meta["locked"].(bool); !locked {
			resizeNodeHeight(node, resource)
		}
	case "audio":
		mime := resource.MimeType
		if mime == "" {
			mime = "audio/mpeg"
		}
		meta["mimeType"] = mime
	}
	delete(meta, "errorDetails")
	selectGeneratedVersion(doc, node, meta)
	return true
}

func resizeNodeHeight(node map[string]any, resource *model.Resource) {
	if resource.Width <= 0 || resource.Height <= 0 {
		return
	}
	if width, ok := node["width"].(float64); ok && width > 0 {
		node["height"] = width * float64(resource.Height) / float64(resource.Width)
	}
}

// 有版本归属的节点生成完成后成为主版本，同根兄弟节点退为非主版本。
func selectGeneratedVersion(doc map[string]any, node, meta map[string]any) {
	root := stringValue(meta["versionOfNodeId"])
	if root == "" {
		return
	}
	meta["versionPrimary"] = true
	for _, item := range creationMaps(doc["nodes"]) {
		if stringValue(item["id"]) == stringValue(node["id"]) {
			continue
		}
		itemMeta, _ := item["metadata"].(map[string]any)
		itemRoot := stringValue(itemMeta["versionOfNodeId"])
		if itemRoot == "" {
			itemRoot = stringValue(item["id"])
		}
		if itemRoot == root && itemMeta != nil {
			itemMeta["versionPrimary"] = false
		}
	}
}
