package app

import "encoding/json"

// Recover only declared chapter keys placed one level too high. No text is
// invented, conflicts remain errors, and full schema/subject checks still run.
func productionNormalizeDocumentFields(m productionManifest, work productionParallelWork, call cloudAgentCall) (cloudAgentCall, error) {
	if m.Plan == nil || !work.ServerBoundArguments || call.Function.Name != "production_submit" {
		return call, nil
	}
	var args map[string]json.RawMessage
	if err := decodeCloudAgentJSONObject(call.Function.Arguments, &args); err != nil {
		return call, cloudAgentJSONArgumentError(err)
	}
	var document map[string]json.RawMessage
	if json.Unmarshal(args["document"], &document) != nil || document == nil {
		return call, nil
	}
	changed := false
	for _, section := range productionPlanDocumentSectionsForSchema(work.Key, productionPlanKind(m, work.Key), productionPlanSchemaVersion(*m.Plan)) {
		raw, misplaced := args[section.Key]
		if !misplaced {
			continue
		}
		if nested, exists := document[section.Key]; exists {
			var a, b any
			if json.Unmarshal(raw, &a) != nil || json.Unmarshal(nested, &b) != nil || productionHash(a) != productionHash(b) {
				return call, cloudAgentFieldError("document."+section.Key, "conflicting_sections", "正文内外的同名字段内容不同，需明确保留哪一份；未自动覆盖")
			}
		}
		document[section.Key] = raw
		delete(args, section.Key)
		changed = true
	}
	if changed {
		args["document"], _ = json.Marshal(document)
		encoded, err := json.Marshal(args)
		if err != nil {
			return call, err
		}
		call.Function.Arguments = string(encoded)
	}
	return call, nil
}

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
	for _, field := range []struct{ key, expected string }{{"key", work.Key}, {"name", work.Name}} {
		if raw, exists := args[field.key]; exists {
			var supplied string
			if json.Unmarshal(raw, &supplied) != nil || supplied != field.expected {
				return call, cloudAgentFieldError(field.key, "work_identity", "返回内容明确指向其他任务，未改名保存；请仅生成当前资产："+work.Name)
			}
		}
	}
	for key, value := range values {
		// Fill omitted scheduling metadata; an explicitly different subject is
		// rejected above instead of being silently relabeled.
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
	if productionAssetPrefixes[stringValue(next["kind"])] != "" {
		context["instruction"] = stringValue(context["instruction"]) + "只设计当前指定主体，facts中的资产名称、编码必须与当前资产索引一致，关联人物写入关系字段，禁止复制其他资产档案后仅改标题。已定身份与剧情事实不可改动；缺少外貌、尺寸、材质、布局或声线时，应按时代和剧情补充完整的制作设定，并写明是本次设计，不使用没有正文依据、未知或待定代替设计。普通状态不登记为新身份或重大形态。"
		if context["assetBackgroundContext"] != nil {
			context["instruction"] = stringValue(context["instruction"]) + "依据 requiredDocuments 中的本版总纲、registeredAssets 中当前主体与 assetBackgroundContext 设计。关联摘要可以跨类别，只用于本资产的生活背景、使用条件及外观言行一致性，不扩写其他档案或等待关联资产生成；背景对应的可见设计直接写进服装妆发、空间陈设或材质字段，不能只回指小传。"
		}
	}
	if _, exists := next["documentEpisodeRange"]; exists {
		context["instruction"] = stringValue(context["instruction"]) + "本批 episodeArchitecture 必须提交命名字段的对象数组，每集一个对象，严格遵守 documentEpisodeRange；不要自行排 Markdown 表格。episodeRepairDraft 仅含待修复集数的原稿，保留剧情并按字段修复。previousEpisodeRow 和 followingEpisodeRow 是前后承接依据，不重复提交。"
	}
}
