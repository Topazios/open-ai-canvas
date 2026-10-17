package app

import "infinite-canvas/backend/internal/model"

func productionModelCompletedPayload(task *model.Task, step int, text string) map[string]any {
	payload := map[string]any{"taskId": task.ID, "step": step, "status": task.Status, "text": text}
	if task.StartedAt != nil {
		payload["queueMs"] = max(int64(0), task.StartedAt.Sub(task.CreatedAt).Milliseconds())
		if task.CompletedAt != nil {
			payload["executionMs"] = max(int64(0), task.CompletedAt.Sub(*task.StartedAt).Milliseconds())
		}
	}
	return payload
}
