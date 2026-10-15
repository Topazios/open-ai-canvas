package app

// 文本生成、Agent 工具循环和文本流解析。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func runTextTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	if _, ok := declarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType); ok {
		return runDeclarativeProtocolTask(ctx, input)
	}
	switch input.Config.InterfaceType {
	case "chat-completion":
		return runChatCompletionsTextTask(ctx, input)
	case "openai-response":
		return runResponsesTextTask(ctx, input)
	case string(model.ChannelInterfaceClaudeAPI):
		return runClaudeTextTask(ctx, input)
	}
	return runLegacyTextTask(ctx, input)
}

// Known text protocols keep the plugin's request mapping and host transport,
// while sharing the SSE parser used by text generation and Agent requests.
func executeProtocolCreateRequest(ctx context.Context, input canvasGenerationInput, spec protocol.RequestSpec) ([]byte, *protocol.Result, error) {
	wire, streamable := streamingProtocolForRequest(input, spec)
	contract := protocol.ContractForAdapter(input.Config.InterfaceType)
	if input.Mode == "text" && contract == protocol.ContractGenerateContent {
		body := protocolBodyObject(spec.Body)
		if body == nil {
			return nil, nil, errors.New("声明式文本请求体必须是 JSON 对象")
		}
		body = cloneStringAnyMap(body)
		applyTextThinking(body, input, "gemini")
		spec.Body = body
	}
	if input.Mode == "text" && streamable && contract != protocol.ContractCustom {
		body := protocolBodyObject(spec.Body)
		if body == nil {
			return nil, nil, errors.New("声明式文本请求体必须是 JSON 对象")
		}
		body = cloneStringAnyMap(body)
		if wire == "responses" {
			// The generic manifest message view uses Chat content parts. Build
			// Responses input through the same converter as the builtin path.
			if len(input.ReferenceAudios) > 0 {
				return nil, nil, errors.New("Responses 文本协议当前不支持音频参考，请选择支持音频输入的协议")
			}
			requestInput := input
			requestInput.Config.SystemPrompt = "" // The manifest already maps instructions.
			converted, err := textResponseInput(requestInput)
			if err != nil {
				return nil, nil, err
			}
			body["input"] = converted
		}
		applyResponsesRequestDefaults(body, wire)
		applyTextThinking(body, input, wire)
		applyAgentOutputLimit(body, agentStepOutputLimit(input), wire)
		applyStructuredTextOutput(body, input, wire)
		if !input.StreamText {
			delete(body, "stream")
		}
		spec.Body = body
	}
	if input.Mode != "text" || !input.StreamText || !streamable {
		data, err := executeProtocolRequest(ctx, input.Config, spec)
		if err == nil && input.Mode == "text" && wire == "responses" {
			result, parseErr := parseProtocolResponsesText(data)
			return data, result, parseErr
		}
		return data, nil, err
	}
	body := protocolBodyObject(spec.Body)
	if body == nil {
		return nil, nil, errors.New("声明式流式文本请求体必须是 JSON 对象")
	}
	body["stream"] = true
	if wire == "chat-completion" {
		if err := ensureChatCompletionStreamUsage(body); err != nil {
			return nil, nil, err
		}
	}
	spec.Body = body
	parser := newStreamingAgentParser(wire, input.OnTextDelta)
	parser.emitReasoning = input.OnReasoningDelta
	data, mimeType, err := executeProtocolBinaryRequestWithConsumer(ctx, input.Config, spec, parser.consume)
	if err != nil || !strings.Contains(strings.ToLower(mimeType), "event-stream") {
		if err == nil && wire == "responses" {
			result, parseErr := parseProtocolResponsesText(data)
			return data, result, parseErr
		}
		return data, nil, err
	}
	parser.flush()
	parsed, err := parser.result()
	if err != nil {
		return nil, nil, err
	}
	text := stringField(parsed, "text")
	if text == "" {
		return nil, nil, errors.New("流式文本接口没有返回内容")
	}
	usage, _ := parsed["usage"].(map[string]interface{})
	return data, &protocol.Result{Text: text, Reasoning: stringField(parsed, "reasoning"), Usage: usage}, nil
}

func parseProtocolResponsesText(data []byte) (*protocol.Result, error) {
	var payload map[string]interface{}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	if err := validateTextPayload(payload); err != nil {
		return nil, err
	}
	if err := validateResponsesCompletion(payload); err != nil {
		return nil, err
	}
	text := firstNonEmptyString(stringField(payload, "output_text"), extractResponseText(payload))
	if strings.TrimSpace(text) == "" {
		return nil, errors.New("Responses 接口没有返回文本内容")
	}
	usage, _ := payload["usage"].(map[string]interface{})
	return &protocol.Result{Text: text, Reasoning: extractResponseReasoning(payload), Usage: usage}, nil
}

func streamingProtocolForRequest(input canvasGenerationInput, spec protocol.RequestSpec) (string, bool) {
	wire := strings.TrimSpace(input.Config.InterfaceType)
	switch wire {
	case "chat-completion":
		return "chat-completion", true
	case string(model.ChannelInterfaceOpenAIResponse), "responses":
		return "responses", true
	case "claude-api":
		return "claude-api", true
	}

	// Declarative plugins use their provider ID as InterfaceType, so they
	// cannot be identified by the built-in protocol names above. Recognize
	// only the well-known request shapes to avoid applying an SSE parser to
	// unrelated custom protocols that happen to support text.
	body := protocolBodyObject(spec.Body)
	if body == nil {
		return "", false
	}
	path := strings.ToLower(strings.TrimSpace(strings.SplitN(spec.Path, "?", 2)[0]))
	switch {
	case strings.Contains(path, "/chat/completions") && body["messages"] != nil:
		return "chat-completion", true
	case strings.HasSuffix(path, "/responses") && body["input"] != nil:
		return "responses", true
	case strings.HasSuffix(path, "/messages") && body["messages"] != nil:
		return "claude-api", true
	default:
		return "", false
	}
}

func runLegacyTextTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	responseInput, err := textResponseInput(input)
	if err != nil {
		return nil, err
	}
	body := map[string]interface{}{"model": input.Config.Model, "input": responseInput}
	applyTextThinking(body, input, "responses")
	applyTextOutputLimit(body, input.MaxOutputTokens, "max_output_tokens")
	applyStructuredTextOutput(body, input, "responses")
	result, err := requestTextProvider(ctx, input.Config, "/responses", body, "responses", input.StreamText, input.OnTextDelta)
	if err != nil {
		if !shouldFallbackTextToChat(err) {
			return nil, err
		}
		result, chatErr := runChatCompletionsTextTask(ctx, input)
		if chatErr == nil {
			return result, nil
		}
		return nil, fmt.Errorf("文本接口请求失败：Responses API %v；Chat Completions %v", err, chatErr)
	}
	return providerTextTaskResult(result), nil
}

func runResponsesTextTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	responseInput, err := textResponseInput(input)
	if err != nil {
		return nil, err
	}
	body := map[string]interface{}{"model": input.Config.Model, "input": responseInput}
	applyTextThinking(body, input, "responses")
	applyTextOutputLimit(body, input.MaxOutputTokens, "max_output_tokens")
	applyStructuredTextOutput(body, input, "responses")
	result, err := requestTextProvider(ctx, input.Config, "/responses", body, "responses", input.StreamText, input.OnTextDelta)
	if err != nil {
		return nil, err
	}
	return providerTextTaskResult(result), nil
}

func runChatCompletionsTextTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	messages := []map[string]interface{}{}
	if systemPrompt := strings.TrimSpace(input.Config.SystemPrompt); systemPrompt != "" {
		messages = append(messages, map[string]interface{}{"role": "system", "content": systemPrompt})
	}
	messages = append(messages, validatedTextHistory(input.TextHistory)...)
	userContent, err := textChatContent(input)
	if err != nil {
		return nil, err
	}
	messages = append(messages, map[string]interface{}{"role": "user", "content": userContent})
	body := map[string]interface{}{"model": input.Config.Model, "messages": messages}
	applyTextThinking(body, input, "chat-completion")
	applyTextOutputLimit(body, input.MaxOutputTokens, "max_tokens")
	applyStructuredTextOutput(body, input, "chat-completion")
	result, err := requestTextProvider(ctx, input.Config, "/chat/completions", body, "chat-completion", input.StreamText, input.OnTextDelta)
	if err != nil {
		return nil, err
	}
	return providerTextTaskResult(result), nil
}

func runClaudeTextTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	if len(input.ReferenceVideos) > 0 {
		return nil, errors.New("Claude API 当前不支持视频参考输入")
	}
	messages := make([]map[string]interface{}, 0, len(input.TextHistory)+1)
	for _, message := range validatedTextHistory(input.TextHistory) {
		messages = append(messages, message)
	}
	content, err := claudeTextContent(input)
	if err != nil {
		return nil, err
	}
	messages = append(messages, map[string]interface{}{"role": "user", "content": content})
	maxTokens := 4096
	if input.MaxOutputTokens > 0 {
		maxTokens = input.MaxOutputTokens
	}
	body := map[string]interface{}{"model": input.Config.Model, "max_tokens": maxTokens, "messages": messages}
	applyTextThinking(body, input, "claude-api")
	if systemPrompt := strings.TrimSpace(input.Config.SystemPrompt); systemPrompt != "" {
		body["system"] = systemPrompt
	}
	result, err := requestTextProvider(ctx, input.Config, "/messages", body, "claude-api", input.StreamText, input.OnTextDelta)
	if err != nil {
		return nil, err
	}
	return providerTextTaskResult(result), nil
}

func applyTextThinking(body map[string]interface{}, input canvasGenerationInput, protocol string) {
	if input.TextOptions.ReasoningDisabled {
		switch protocol {
		case "responses":
			delete(body, "reasoning")
		case "chat-completion":
			delete(body, "reasoning_effort")
		case "claude-api":
			delete(body, "thinking")
			if output, ok := body["output_config"].(map[string]interface{}); ok {
				delete(output, "effort")
			}
		case "gemini":
			if generation, ok := body["generationConfig"].(map[string]interface{}); ok {
				delete(generation, "thinkingConfig")
			}
		}
		return
	}
	effort := string(input.TextOptions.ReasoningEffort.effective())
	switch protocol {
	case "responses":
		reasoning, _ := body["reasoning"].(map[string]interface{})
		reasoning = cloneStringAnyMap(reasoning)
		if reasoning == nil {
			reasoning = map[string]interface{}{}
		}
		reasoning["effort"] = effort
		if reasoning["summary"] == nil {
			reasoning["summary"] = "auto"
		}
		body["reasoning"] = reasoning
	case "chat-completion":
		body["reasoning_effort"] = effort
	case "claude-api":
		if usesClaudeAdaptiveThinking(input.Config.Model) {
			body["thinking"] = map[string]interface{}{"type": "adaptive"}
			output, _ := body["output_config"].(map[string]interface{})
			output = cloneStringAnyMap(output)
			if output == nil {
				output = map[string]interface{}{}
			}
			output["effort"] = effort
			body["output_config"] = output
			return
		}
		budget := map[string]int{"low": 1024, "medium": 4096, "high": 8192}[effort]
		limit := agentStepOutputLimit(input)
		if limit == 0 {
			switch value := body["max_tokens"].(type) {
			case int:
				limit = value
			case float64:
				limit = int(value)
			}
		}
		if limit > 0 && limit <= 1024 {
			return
		}
		if limit > 1024 && budget >= limit {
			budget = max(1024, limit/2)
		}
		body["thinking"] = map[string]interface{}{"type": "enabled", "budget_tokens": budget}
	case "gemini":
		generation, _ := body["generationConfig"].(map[string]interface{})
		generation = cloneStringAnyMap(generation)
		if generation == nil {
			generation = map[string]interface{}{}
		}
		generation["thinkingConfig"] = geminiReasoningConfig(input.Config.Model, input.TextOptions.ReasoningEffort)
		body["generationConfig"] = generation
	}
}

// Chat Completion defaults to automatic tool selection when tools are present,
// so an explicit "auto" only reduces compatibility. Reasoning endpoints also
// disagree on forced choices. Normalize before the first network request while
// preserving required/named choices for non-reasoning structured tasks.
func normalizeAgentToolChoice(body map[string]interface{}, input canvasGenerationInput, protocol string) {
	if protocol == "chat-completion" && (!input.TextOptions.ReasoningDisabled || isAutoAgentToolChoice(body["tool_choice"])) {
		delete(body, "tool_choice")
	}
}

type providerTextResult struct {
	Text      string
	Reasoning string
}

func providerTextTaskResult(result providerTextResult) map[string]interface{} {
	payload := map[string]interface{}{"mode": "text", "text": result.Text}
	if strings.TrimSpace(result.Reasoning) != "" {
		payload["reasoning"] = result.Reasoning
	}
	return payload
}

func applyTextOutputLimit(body map[string]interface{}, limit int, field string) {
	if limit > 0 {
		body[field] = limit
	}
}

func applyStructuredTextOutput(body map[string]interface{}, input canvasGenerationInput, protocol string) {
	output := input.TextOptions.StructuredOutput
	if output == nil || strings.TrimSpace(output.Name) == "" || len(output.Schema) == 0 {
		return
	}
	strict := true
	if output.Strict != nil {
		strict = *output.Strict
	}
	switch protocol {
	case "chat-completion":
		body["response_format"] = map[string]interface{}{
			"type": "json_schema",
			"json_schema": map[string]interface{}{
				"name": output.Name, "strict": strict, "schema": output.Schema,
			},
		}
	case "responses":
		body["text"] = map[string]interface{}{
			"format": map[string]interface{}{
				"type":   "json_schema",
				"name":   output.Name,
				"strict": strict,
				"schema": output.Schema,
			},
		}
	}
}

func claudeTextContent(input canvasGenerationInput) (interface{}, error) {
	if len(input.ReferenceImages) == 0 {
		return input.Prompt, nil
	}
	content := []map[string]interface{}{{"type": "text", "text": input.Prompt}}
	for _, image := range input.ReferenceImages {
		value, err := openAIImageInputURL(image)
		if err != nil {
			return nil, err
		}
		if strings.HasPrefix(value, "data:") {
			mimeType, data, ok := splitDataURL(value)
			if !ok {
				return nil, errors.New("Claude 参考图片 data URL 无效")
			}
			content = append(content, map[string]interface{}{"type": "image", "source": map[string]interface{}{"type": "base64", "media_type": mimeType, "data": data}})
		} else {
			content = append(content, map[string]interface{}{"type": "image", "source": map[string]interface{}{"type": "url", "url": value}})
		}
	}
	return content, nil
}

func splitDataURL(value string) (string, string, bool) {
	if !strings.HasPrefix(value, "data:") {
		return "", "", false
	}
	separator := strings.Index(value, ",")
	if separator <= len("data:") {
		return "", "", false
	}
	header := strings.TrimPrefix(value[:separator], "data:")
	if !strings.HasSuffix(header, ";base64") {
		return "", "", false
	}
	return strings.TrimSuffix(header, ";base64"), value[separator+1:], value[separator+1:] != ""
}

func textResponseInput(input canvasGenerationInput) (interface{}, error) {
	systemPrompt := strings.TrimSpace(input.Config.SystemPrompt)
	if len(input.TextHistory) == 0 && len(input.ReferenceImages) == 0 && len(input.ReferenceVideos) == 0 {
		return withSystemPrompt(input.Config, input.Prompt), nil
	}
	messages := make([]map[string]interface{}, 0, len(input.TextHistory)+2)
	if systemPrompt != "" {
		messages = append(messages, map[string]interface{}{"role": "system", "content": systemPrompt})
	}
	messages = append(messages, validatedTextHistory(input.TextHistory)...)
	content, err := textResponseContent(input)
	if err != nil {
		return nil, err
	}
	messages = append(messages, map[string]interface{}{"role": "user", "content": content})
	return messages, nil
}

func validatedTextHistory(history []providerTextMessage) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(history))
	for _, message := range history {
		role := strings.ToLower(strings.TrimSpace(message.Role))
		content := strings.TrimSpace(message.Content)
		if (role != "user" && role != "assistant") || content == "" {
			continue
		}
		result = append(result, map[string]interface{}{"role": role, "content": content})
	}
	return result
}

func textResponseContent(input canvasGenerationInput) ([]map[string]interface{}, error) {
	content := []map[string]interface{}{{"type": "input_text", "text": input.Prompt}}
	for _, image := range input.ReferenceImages {
		url, err := openAIImageInputURL(image)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "input_image", "image_url": url})
	}
	for _, video := range input.ReferenceVideos {
		url, err := openAIVideoInputURL(video)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "input_video", "video_url": url})
	}
	return content, nil
}

func textChatContent(input canvasGenerationInput) (interface{}, error) {
	if len(input.ReferenceImages) == 0 && len(input.ReferenceVideos) == 0 {
		return input.Prompt, nil
	}
	content := []map[string]interface{}{{"type": "text", "text": input.Prompt}}
	for _, image := range input.ReferenceImages {
		url, err := openAIImageInputURL(image)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": url}})
	}
	for _, video := range input.ReferenceVideos {
		url, err := openAIVideoInputURL(video)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "video_url", "video_url": map[string]interface{}{"url": url}})
	}
	return content, nil
}

func shouldFallbackTextToChat(err error) bool {
	var httpErr providerHTTPError
	if !errors.As(err, &httpErr) {
		return false
	}
	// 只在上游明确说这个路径不存在/不允许时，才把 Responses 换成 Chat Completions。
	// 502/503/504 是瞬时故障，换协议不会修好，还会把真正的上游故障伪装成“能力缺失后的第二次失败”。
	switch httpErr.StatusCode {
	case http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusNotImplemented:
		return true
	default:
		return false
	}
}
