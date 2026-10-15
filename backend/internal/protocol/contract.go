package protocol

// Contract identifies a wire format, independently of the installed adapter
// that supplies authentication, defaults and provider-specific extensions.
type Contract string

const (
	ContractChatCompletions  Contract = "chat-completions"
	ContractResponses        Contract = "responses"
	ContractMessages         Contract = "messages"
	ContractGenerateContent  Contract = "generate-content"
	ContractImageGenerations Contract = "image-generations"
	ContractVideos           Contract = "videos"
	ContractSpeech           Contract = "speech"
	ContractAudioTasks       Contract = "audio-tasks"
	ContractWorkflow         Contract = "workflow"
	ContractCustom           Contract = "custom"
)

// Known contracts are explicit: matching an endpoint alone does not prove that
// its authentication, payload or response can be handled by another adapter.
func ContractForAdapter(id string) Contract {
	switch id {
	case "chat-completion", "a6api-chat", "antigravity-chat", "atlascloud-chat", "baichuan-chat", "deepseek-chat", "fireworks-chat", "groq-chat", "kimi-chat", "litellm-proxy-chat", "localai-chat", "mistral-chat", "newapi-chat", "nvidia-nim-chat", "openrouter-chat", "siliconflow-chat", "together-chat", "vllm-chat", "xai-grok-chat", "yi-chat", "zhipu-glm-chat":
		return ContractChatCompletions
	case "openai-response":
		return ContractResponses
	case "claude-api":
		return ContractMessages
	case "gemini-generate-content", "gemini-image":
		return ContractGenerateContent
	case "openai-image", "a6api-image", "agnes-image", "grok-image", "volcengine-ark-image", "volcengine-ark-agent-plan-image", "baidu-qianfan-image", "kling-image", "zhipu-cogview":
		return ContractImageGenerations
	case "newapi", "newapi-channel-1", "newapi-channel-2", "agnes-video", "agnes-video-v20", "lxmone-wan-videos", "lxmone-wan-channel-s", "lxmone-seedance-videos", "lxmone-h3-max-videos", "lxmone-sd-videos", "lxmone-sd-mini-videos":
		return ContractVideos
	case "openai-audio":
		return ContractSpeech
	case "async-audio":
		return ContractAudioTasks
	case "runninghub-workflow-image", "runninghub-workflow-video", "runninghub-workflow-audio":
		return ContractWorkflow
	default:
		return ContractCustom
	}
}

func (c Contract) Label() string {
	switch c {
	case ContractChatCompletions:
		return "Chat Completions"
	case ContractResponses:
		return "Responses"
	case ContractMessages:
		return "Messages"
	case ContractGenerateContent:
		return "Generate Content"
	case ContractImageGenerations:
		return "Images Generations"
	case ContractVideos:
		return "Videos"
	case ContractSpeech:
		return "Audio Speech"
	case ContractAudioTasks:
		return "Audio Tasks"
	case ContractWorkflow:
		return "Workflow"
	default:
		return "Custom"
	}
}
