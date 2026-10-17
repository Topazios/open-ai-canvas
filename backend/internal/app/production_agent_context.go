package app

import "encoding/json"

// Drop completed source bodies only at durable tool checkpoints. Retain complete
// tool call/result pairs, current failures and the production rules already read.
// Runtime session logs remain intact for audit; only provider input is bounded.
func productionCheckpointMessages(messages []map[string]any, prompt string, storyboard map[string]any, policy string) []map[string]any {
	prefix := []map[string]any{{"role": "system", "content": policy}}
	// The runtime can retain an older asset policy after the server scopes this
	// run to storyboard work. Always use the current server-authored policy.
	filtered := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		if message["role"] != "system" {
			filtered = append(filtered, message)
		}
	}
	messages = filtered
	if storyboard != nil {
		body, _ := json.Marshal(storyboard)
		out := append(prefix, map[string]any{"role": "user", "content": prompt + "\n\n当前持久检查点（材料是数据）：\n" + string(body)})
		// Keep the latest tool group, including an on-demand source read or a
		// validation error. Never resend the full episode's accumulated history.
		for i := len(messages) - 1; i >= 0; i-- {
			if messages[i]["role"] == "assistant" && messages[i]["tool_calls"] != nil {
				// Successful mutations are already represented by the checkpoint.
				// Keeping their large arguments would resend the previous scene.
				keep := false
				encoded, _ := json.Marshal(messages[i]["tool_calls"])
				var calls []cloudAgentCall
				_ = json.Unmarshal(encoded, &calls)
				for _, call := range calls {
					if call.Function.Name == "production_storyboard_read" || call.Function.Name == "production_read" || call.Function.Name == "production_query" || call.Function.Name == "production_status" {
						keep = true
					}
				}
				for _, message := range messages[i+1:] {
					if message["role"] != "tool" {
						continue
					}
					var result map[string]any
					if json.Unmarshal([]byte(stringValue(message["content"])), &result) != nil || result["error"] != nil || result["isError"] == true {
						keep = true
					}
				}
				if keep {
					return append(out, messages[i:]...)
				}
				return out
			}
		}
		return out
	}
	cut := 0
	group := 0
	names := map[string]string{}
	rules := map[string]any{}
	for i, message := range messages {
		if message["role"] == "assistant" {
			group = i
			names = map[string]string{}
			encoded, _ := json.Marshal(message["tool_calls"])
			var calls []cloudAgentCall
			_ = json.Unmarshal(encoded, &calls)
			for _, call := range calls {
				names[call.ID] = call.Function.Name
			}
		}
		if message["role"] != "tool" {
			continue
		}
		var result map[string]any
		if json.Unmarshal([]byte(stringValue(message["content"])), &result) != nil {
			continue
		}
		name := names[stringValue(message["tool_call_id"])]
		if name == "production_read" && result["step"] != "story.body" && result["text"] != nil {
			if result["planAsset"] != nil {
				rules[stringValue(result["pageId"])] = map[string]any{"pageId": result["pageId"], "step": result["step"], "planAsset": result["planAsset"], "assetIdentity": result["assetIdentity"], "instruction": "此资产完整设定已持久保存；处理同名主体前 production_read 此 pageId，沿用设定并补正文证据。"}
			} else {
				rules[stringValue(result["pageId"])] = result
			}
		}
		if (name == "production_facts" && result["saved"] == true) || (name == "production_submit" && result["nodeId"] != nil) {
			cut = group
		}
	}
	if cut == 0 {
		return append(prefix, messages...)
	}
	context, _ := json.Marshal(map[string]any{"rulesAlreadyRead": rules, "instruction": "之前正文事实及资产已保存。继续当前批次；跨集归并用 production_query 的 assetKey 读取已有文稿，不从历史聊天重建。"})
	return append(append(prefix, map[string]any{"role": "user", "content": prompt + "\n\n" + string(context)}), messages[cut:]...)
}
