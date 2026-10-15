package app

import (
	"strings"

	"infinite-canvas/backend/internal/productionrules"
)

// Only explicit production sources opt into these rules. Metadata is not an
// authorization signal; normal task admission still validates every request.
func productionTaskStage(metadata map[string]any) (string, bool, error) {
	source, _ := metadata["source"].(string)
	switch source {
	case "canvas-short-drama-workflow", "canvas-workflow-batch-child":
		stage, _ := metadata["workflowStage"].(string)
		if !productionrules.ValidStage(stage) {
			return "", true, BadAuthRequest("无效的短剧制作阶段")
		}
		return stage, true, nil
	case "canvas-story-development":
		if stage, exists := metadata["workflowStage"]; exists && stage != "story" {
			return "", true, BadAuthRequest("故事开发必须使用 story 制作阶段")
		}
		if raw, exists := metadata["stage"]; exists {
			stage, ok := raw.(string)
			if !ok {
				return "", true, BadAuthRequest("无效的故事开发阶段")
			}
			switch stage {
			case "topic", "plan", "outline", "episodes", "body":
			default:
				return "", true, BadAuthRequest("无效的故事开发阶段")
			}
		}
		return "story", true, nil
	default:
		return "", false, nil
	}
}

func applyProductionTaskRules(taskType, prompt string, input map[string]any) (string, error) {
	metadata, _ := input["metadata"].(map[string]any)
	stage, scoped, err := productionTaskStage(metadata)
	if err != nil || !scoped {
		return strings.TrimSpace(prompt), err
	}
	mode, _ := input["mode"].(string)
	expected := map[string]string{"text": "text", "canvas_text": "text", "canvas_image": "image", "canvas_video": "video", "canvas_audio": "audio"}[taskType]
	if strings.HasPrefix(taskType, "video_") && len(taskType) > len("video_") {
		expected = "video"
	}
	if expected == "" || mode != expected {
		return "", BadAuthRequest("短剧制作模式与任务类型不一致")
	}
	inputPrompt, ok := input["prompt"].(string)
	if raw, exists := input["prompt"]; exists && raw != nil && !ok {
		return "", BadAuthRequest("短剧制作提示词必须为文本")
	}
	if strings.TrimSpace(inputPrompt) == "" {
		inputPrompt = prompt
	}
	// The executor prefers input.prompt. Persist the same effective prompt for
	// billing and task display; Apply leaves audio (including whitespace) intact.
	prompt = productionrules.Apply(inputPrompt, stage, mode)
	input["prompt"] = prompt
	return prompt, nil
}
