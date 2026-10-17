package model

import "strings"

type TaskConcurrencyKind string

const (
	TaskConcurrencyImage TaskConcurrencyKind = "image"
	TaskConcurrencyText  TaskConcurrencyKind = "text"
	TaskConcurrencyAgent TaskConcurrencyKind = "agent"
	TaskConcurrencyVideo TaskConcurrencyKind = "video"
	TaskConcurrencyAudio TaskConcurrencyKind = "audio"
	TaskConcurrencyOther TaskConcurrencyKind = "other"
)

func TaskConcurrencyKinds() []TaskConcurrencyKind {
	return []TaskConcurrencyKind{TaskConcurrencyImage, TaskConcurrencyText, TaskConcurrencyAgent, TaskConcurrencyVideo, TaskConcurrencyAudio, TaskConcurrencyOther}
}

// Media spawned by an Agent consumes its media lane, not a text-model slot.
func TaskConcurrency(typeName, operation string) TaskConcurrencyKind {
	switch {
	case typeName == "canvas_image" || typeName == "image":
		return TaskConcurrencyImage
	case typeName == "canvas_video" || typeName == "video" || strings.HasPrefix(typeName, "video_") || typeName == TaskTypeTimelineRender:
		return TaskConcurrencyVideo
	case typeName == "canvas_audio" || typeName == "audio" || typeName == TaskTypeTimelineTranscription:
		return TaskConcurrencyAudio
	case typeName == "canvas_text" || typeName == "text":
		if strings.HasPrefix(operation, "cloud_agent") || operation == "agent_memory_compact" {
			return TaskConcurrencyAgent
		}
		return TaskConcurrencyText
	default:
		return TaskConcurrencyOther
	}
}
