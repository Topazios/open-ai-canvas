package app

import "encoding/json"

// A queued document already owns its destination and source version. Models
// author content; they need not reproduce deterministic scheduling metadata.
func productionBindDocumentCall(work productionParallelWork, call cloudAgentCall) (cloudAgentCall, error) {
	if !work.ServerBoundArguments || call.Function.Name != "production_submit" {
		return call, nil
	}
	if work.TargetHash == nil {
		return call, BadAuthRequest("文稿任务缺少目标版本检查点，已保留结果；请检查本地调度状态")
	}
	if len(call.Function.Arguments) > productionToolArgumentsMaxBytes {
		return call, BadAuthRequest("文稿工具参数超过安全大小限制")
	}
	var args map[string]json.RawMessage
	if err := decodeCloudAgentJSONObject(call.Function.Arguments, &args); err != nil {
		return call, cloudAgentJSONArgumentError(err)
	}
	values := map[string]any{"key": work.Key, "name": work.Name, "expectedHash": *work.TargetHash, "factIds": []string{}}
	for key, value := range values {
		// The queued checkpoint owns identity and target version. Providers can
		// return stale or hallucinated metadata, so normalize it before validation
		// rather than rejecting otherwise valid authored content.
		args[key], _ = json.Marshal(value)
	}
	encoded, err := json.Marshal(args)
	if err != nil {
		return call, err
	}
	call.Function.Arguments = string(encoded)
	return call, nil
}

func productionBoundDocumentContext(context map[string]any) {
	next := context["nextAction"].(map[string]any)
	next["serverBoundArguments"] = true
	delete(next, "arguments")
	if fields, partial := next["documentFields"].([]string); partial && len(fields) == 0 {
		context["instruction"] = "原稿已由服务端暂存。本次只提交 document={}，不重写正文，不添加 design。任务身份、固定引用和目标版本由服务端绑定；服务端复用原稿执行完整校验。"
		return
	}
	context["instruction"] = "本次只完成指定文稿，直接调用 production_submit。只提交 document 和当前模板允许的 design；任务身份、目标版本和固定引用参数由服务端从持久检查点绑定，不生成这些参数，不放入 document。只填写本次模板声明的正文字段，不添加说明或占位字段。不读取或查询状态，不生成其他文稿。"
	if _, partial := next["documentFields"]; partial {
		context["instruction"] = stringValue(context["instruction"]) + "只填写 nextAction.documentFields 指定章节，不重复 acceptedDocumentFields；字段列表为空时提交 document={}，服务端复用暂存原稿执行完整校验。遵守 documentMaxChars 及本批 documentBudget，最后一批才可提交资产 design。"
	}
	context["instruction"] = stringValue(context["instruction"]) + "repairDocumentFields 和 repairDesign 是私有修复草稿，按 correction 定向修正并显式重提；design 修正后显式提交，保留有效正文及设计信息。按 nextAction.documentBudget 控制本批合计篇幅，不能把整份上限当作每批上限；压缩重复表述，不删制作要求。"
}
