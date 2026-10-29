package app

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Synchronous relays must validate the terminal response before settling a
// successful request. HTTP 200 alone does not prove a completed generation.
func ValidateResponsesProviderResult(data []byte, stream bool) error {
	if stream {
		parser := newStreamingAgentParser("responses", nil)
		parser.consume("text/event-stream", data)
		parser.flush()
		_, err := parser.result()
		return err
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(data, &payload); err != nil {
		return providerResponseDecodeError{Err: errors.New("Responses 返回无效 JSON")}
	}
	_, err := parseAgentToolPayload(payload, "responses")
	return err
}

// Conversations and recovery are owned by the local task/Agent runtime.
// Do not implicitly enable provider storage or tighten optional tool fields.
func applyResponsesRequestDefaults(body map[string]interface{}, wire string) {
	if wire != "responses" {
		return
	}
	if _, present := body["store"]; !present {
		body["store"] = false
	}
	for _, value := range interfaceSlice(body["tools"]) {
		tool, _ := value.(map[string]interface{})
		if stringField(tool, "type") == "function" {
			if _, present := tool["strict"]; !present {
				tool["strict"] = false
			}
		}
	}
}

func validateResponsesCompletion(payload map[string]interface{}) error {
	if err := validateTextPayload(payload); err != nil {
		return err
	}
	switch stringField(payload, "status") {
	case "", "completed": // Some compatible gateways omit status on final JSON.
	case "incomplete":
		details, _ := payload["incomplete_details"].(map[string]interface{})
		if stringField(details, "reason") == "max_output_tokens" {
			return errProviderOutputLimit
		}
		return providerResponseDecodeError{Err: errors.New("Responses 返回未完成结果，不能作为完整内容采用")}
	case "failed", "cancelled", "canceled", "expired":
		raw, _ := json.Marshal(payload)
		return providerPayloadError{raw: string(raw), message: fmt.Sprintf("上游 Responses 返回状态 %q，生成未完成", stringField(payload, "status"))}
	default:
		return providerResponseDecodeError{Err: fmt.Errorf("Responses 返回非完成状态 %q，生成未完成", stringField(payload, "status"))}
	}
	for _, value := range interfaceSlice(payload["output"]) {
		item, _ := value.(map[string]interface{})
		if status := stringField(item, "status"); status != "" && status != "completed" {
			return providerResponseDecodeError{Err: errors.New("Responses 输出条目未完成，生成未完成")}
		}
		for _, value := range interfaceSlice(item["content"]) {
			part, _ := value.(map[string]interface{})
			if stringField(part, "type") == "refusal" {
				return providerResponseDecodeError{Err: errors.New("模型拒绝了本次请求，未生成可用内容")}
			}
		}
	}
	return nil
}
