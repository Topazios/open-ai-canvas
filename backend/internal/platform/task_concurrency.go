package platform

import "infinite-canvas/backend/internal/model"

func (p RuntimeTaskPolicy) ConcurrencyFor(kind model.TaskConcurrencyKind) int {
	switch kind {
	case model.TaskConcurrencyImage:
		return p.ImageConcurrency
	case model.TaskConcurrencyText:
		return p.TextConcurrency
	case model.TaskConcurrencyAgent:
		return p.AgentConcurrency
	case model.TaskConcurrencyVideo:
		return p.VideoConcurrency
	case model.TaskConcurrencyAudio:
		return p.AudioConcurrency
	default:
		return p.WorkerConcurrency
	}
}
