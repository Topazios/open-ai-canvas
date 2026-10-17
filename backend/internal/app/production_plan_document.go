package app

import "strings"

// productionPlanDocumentSections is the strict v2 contract. Callers select it
// explicitly for v2 plans and resolve asset kind from the registered inventory.
// Reserved document keys require an empty kind; asset keys require a known kind.
// Each call owns its slice so tool-schema construction cannot alter the contract.
func productionPlanDocumentSections(key, kind string) []productionDocumentSection {
	var fields []productionDocumentSection
	switch key {
	case "story":
		fields = []productionDocumentSection{
			{"facts", "选题依据与制作体量"},
			{"premise", "故事命题与核心看点"},
			{"motivation", "主角目标、动机与失败代价"},
			{"world", "时代背景与世界设定"},
			{"worldRules", "世界运行规则、限制与代价"},
			{"conflict", "核心冲突与对抗升级"},
			{"plot", "完整起承转合与关键转折"},
			{"arcs", "篇章划分、集数分配与阶段目标"},
			{"characterArcs", "主要人物成长弧光"},
			{"relationships", "人物关系与关系变化"},
			{"ending", "结局安排、本季收束与开放悬念"},
			{"foreshadowing", "伏笔埋设与回收计划"},
			{"continuity", "时间线与故事连续性规则"},
			{"uncertainties", "已定依据、创作设计与未定事项"},
		}
	case "visual":
		fields = []productionDocumentSection{
			{"facts", "视觉依据与项目约束"},
			{"style", "整体视觉风格与媒介质感"},
			{"palette", "主辅色、角色色与禁用色"},
			{"lighting", "光源方向、光比与日夜照明"},
			{"composition", "构图、景别与画幅规范"},
			{"characterDesign", "人物比例、服装与妆发规范"},
			{"environmentDesign", "场景建筑、空间与陈设规范"},
			{"propDesign", "道具尺度、材质与工艺规范"},
			{"specialDesign", "状态变化与效果表现规范"},
			{"referenceLayout", "参考图视角、版式与背景要求"},
			{"sound", "视觉节奏与声音配合约束"},
			{"prompt", "共用视觉生成提示词"},
			{"negativePrompt", "视觉禁止项与负面提示词"},
			{"continuity", "跨资产与跨集视觉一致性"},
			{"uncertainties", "视觉创作设计与未定事项"},
		}
	case "direction":
		fields = []productionDocumentSection{
			{"facts", "导演依据与叙事约束"},
			{"narrative", "叙事视角与信息揭示规则"},
			{"pacing", "单集节奏、情绪曲线与悬念"},
			{"blocking", "人物调度、轴线与空间关系"},
			{"camera", "景别、机位、镜头运动与使用条件"},
			{"editing", "剪辑节奏、转场与镜头衔接"},
			{"performance", "表演尺度、动作与情绪边界"},
			{"voiceDirection", "对白、旁白与配音指导"},
			{"music", "音乐主题、进入退出与情绪功能"},
			{"ambience", "环境声层次与空间听感"},
			{"soundEffects", "拟音、标志音效与同步规则"},
			{"sound", "声画关系、混音层级与静默规则"},
			{"prompt", "共用导演与视听制作描述"},
			{"negativePrompt", "导演与表演禁止项"},
			{"continuity", "动作、视线与声画连续性"},
			{"uncertainties", "导演创作设计与未定事项"},
		}
	case "generation":
		fields = []productionDocumentSection{
			{"facts", "生成依据与交付约束"},
			{"workflow", "参考图、镜头、视频与音频生成顺序"},
			{"identityRules", "资产编码、引用与身份锁定规则"},
			{"referenceRules", "参考图选择、视角与引用规则"},
			{"promptStructure", "提示词结构与资产组合规则"},
			{"imageConstraints", "图像画幅、构图与清晰度要求"},
			{"videoConstraints", "视频时长、动作、运镜与首尾帧要求"},
			{"sound", "音频生成、声线引用与同步要求"},
			{"stateTransitions", "资产状态变更与镜头衔接规则"},
			{"qualityChecks", "生成验收标准与缺陷判定"},
			{"repairStrategy", "失败重试、局部修复与替代方案"},
			{"prompt", "共用生成提示词模板"},
			{"negativePrompt", "生成禁止项与负面提示词"},
			{"continuity", "版本追踪与跨镜头一致性"},
			{"uncertainties", "生成设计、能力假设与未定事项"},
		}
	case "inventory":
		fields = []productionDocumentSection{
			{"facts", "清单来源与故事总纲版本"},
			{"design", "资产编码、类别、名称与预计出场表"},
			{"continuity", "计划与实际出场区分及身份复用规则"},
			{"uncertainties", "缺省类别理由与未定事项"},
		}
	}
	if fields != nil {
		if kind != "" {
			return nil
		}
		return fields
	}
	if strings.TrimSpace(key) == "" || key != strings.TrimSpace(key) || key == "$summary" {
		return nil
	}
	switch kind {
	case "character":
		fields = []productionDocumentSection{
			{"facts", "人物编码、别名、选题依据与预计出场"},
			{"role", "人物身份与剧情功能"},
			{"personality", "性格特征、行为习惯与矛盾面"},
			{"motivation", "欲望、目标、恐惧与行动动机"},
			{"backstory", "人物经历与关键成因"},
			{"relationships", "人物关系与关系弧光"},
			{"characterArc", "人物成长与阶段变化"},
			{"appearance", "年龄感、体型、面部与辨识特征"},
			{"costume", "固定服装、配饰与材质配色"},
			{"hairMakeup", "发型、妆容与固定细节"},
			{"performance", "姿态、动作、表情与表演边界"},
			{"variants", "服化与情绪状态变体及启用条件"},
			{"sound", "人物声线设计与声音资产引用"},
			{"voiceTimbre", "声线音色、质感与辨识点"},
			{"voiceRange", "音域、音高与共鸣位置"},
			{"voicePace", "语速、节奏、停顿与重音"},
			{"voiceAccent", "语言、口音与咬字习惯"},
			{"voicePerformance", "配音情绪范围与表演禁区"},
			{"voicePrompt", "可复用配音提示词"},
			{"prompt", "人物参考图生成提示词"},
			{"negativePrompt", "人物外观与声线禁止变化"},
			{"continuity", "人物跨集不变项与变化条件"},
			{"uncertainties", "人物创作设计与未定事项"},
		}
	case "environment":
		fields = []productionDocumentSection{
			{"facts", "场景编码、别名、选题依据与预计出场"},
			{"function", "场景剧情功能与使用场次"},
			{"eraLocation", "地理位置、时代与建筑类型"},
			{"layout", "空间布局、尺度与固定陈设"},
			{"entrances", "出入口、通道与人物动线"},
			{"spatialRelations", "相邻空间、方位与视线关系"},
			{"materials", "建筑材质、表面质感与配色"},
			{"lighting", "固定光源、日夜与天气光照"},
			{"cameraPositions", "可用机位、遮挡与取景边界"},
			{"variants", "日夜、天气与陈设状态变体"},
			{"sound", "环境声源、层次、混响与变化条件"},
			{"prompt", "场景参考图生成提示词"},
			{"negativePrompt", "空间与陈设禁止变化"},
			{"continuity", "场景跨集固定项与状态衔接"},
			{"uncertainties", "场景创作设计与未定事项"},
		}
	case "prop":
		fields = []productionDocumentSection{
			{"facts", "道具编码、别名、选题依据与预计出场"},
			{"function", "道具剧情功能与使用方式"},
			{"appearance", "道具形状、尺寸、比例与辨识特征"},
			{"materials", "道具材质、工艺、配色与表面细节"},
			{"ownership", "初始归属、持有人与转移条件"},
			{"mechanism", "影视表现方式、外观状态切换与功能限制"},
			{"interaction", "握持、佩戴与人物交互规则"},
			{"variants", "完好、损坏、消耗与修复状态"},
			{"sound", "操作声、材质声与标志音效"},
			{"prompt", "道具参考图生成提示词"},
			{"negativePrompt", "道具形态与功能禁止变化"},
			{"continuity", "道具位置、归属与状态连续性"},
			{"uncertainties", "道具创作设计与未定事项"},
		}
	case "special":
		fields = []productionDocumentSection{
			{"facts", "特殊资产编码、别名、选题依据与预计出场"},
			{"function", "特殊资产类别与剧情功能"},
			{"form", "固定形态、尺度、材质与辨识特征"},
			{"triggers", "触发条件、使用者与解除条件"},
			{"abilities", "能力表现、作用对象与范围"},
			{"limits", "能力边界、持续时间与失效条件"},
			{"cost", "使用代价、副作用与恢复条件"},
			{"visualEffects", "特效颜色、运动、光照与空间影响"},
			{"variants", "启动、持续、衰减与失效形态"},
			{"sound", "触发、持续、结束与标志声音"},
			{"prompt", "特殊资产生成提示词"},
			{"negativePrompt", "特殊资产形态与能力禁止项"},
			{"continuity", "特殊资产规则与状态连续性"},
			{"uncertainties", "特殊资产创作设计与未定事项"},
		}
	case "sound":
		fields = []productionDocumentSection{
			{"facts", "声音编码、别名、选题依据与预计出场"},
			{"soundType", "声音类别与独立复用目的"},
			{"subjectReferences", "关联人物、场景或道具编码"},
			{"sound", "声音核心设计与听觉辨识特征"},
			{"timbre", "音色、频段、质感与声源构成"},
			{"rhythm", "节奏、速度、时长与循环规则"},
			{"emotion", "情绪功能、强度与动态范围"},
			{"spatial", "距离、方位、混响与空间层次"},
			{"cues", "触发、进入、退出与同步时点"},
			{"mixing", "音量层级、对白避让与混音边界"},
			{"variants", "强弱、情绪与场景适配变体"},
			{"prompt", "声音生成提示词与声线复用要求"},
			{"negativePrompt", "声音禁止项与失真限制"},
			{"continuity", "声音跨集复用与变化规则"},
			{"uncertainties", "声音创作设计与未定事项"},
		}
	}
	return fields
}

// productionRenderPlanDocument only renders strict v2 documents. Unknown fields
// are errors, not discarded prose. No caller-owned fields or saved content change.
func productionRenderPlanDocument(key, kind string, document map[string]string) (string, error) {
	sections := productionPlanDocumentSections(key, kind)
	if len(sections) == 0 {
		return "", cloudAgentFieldError("document", "unknown_schema", "制作方案文稿需要有效的共用文稿 key 或已登记的资产 kind。")
	}
	allowed := make(map[string]bool, len(sections))
	for _, section := range sections {
		allowed[section.Key] = true
	}
	for field := range document {
		if !allowed[field] {
			return "", cloudAgentFieldError("document", "unknown_fields", "document 含有当前文稿类型未声明的字段；请按当前类型的必填字段保留并整理原有内容后重新提交。")
		}
	}
	parts, missing := []string{}, []string{}
	for _, section := range sections {
		value := strings.TrimSpace(document[section.Key])
		if value == "" {
			missing = append(missing, section.Key+"（"+section.Title+"）")
		}
		switch strings.ToLower(strings.Trim(value, " \t\r\n。.!！?？…")) {
		case "待补充", "待完善", "待确认", "待定", "同上", "略", "todo", "tbd":
			return "", cloudAgentFieldError("document."+section.Key, "placeholder_content", "此字段只有占位文字，请填写具体制作要求；不适用时说明原因。"+productionPlanFieldDescription(key, kind, section))
		}
		invalidHeading := false
		closed := productionPlanDocumentScan(value, func(level int, _ string) {
			if level == 1 || level == 2 {
				invalidHeading = true
			}
		})
		if invalidHeading || !closed {
			return "", cloudAgentFieldError("document."+section.Key, "invalid_section", "字段正文不能包含一级或二级标题，代码围栏必须闭合；细分内容请使用三级或更低层级标题。")
		}
		parts = append(parts, "## "+section.Title+"\n"+value)
	}
	if len(missing) > 0 {
		return "", cloudAgentFieldError("document", "missing_sections", "请补齐当前类型的 document 字段："+strings.Join(missing, "、")+"。没有对应项时明确说明不适用及原因，不要空填。")
	}
	content := strings.Join(parts, "\n\n")
	if missing = productionPlanDocumentMissing(key, kind, content); len(missing) > 0 {
		return "", cloudAgentFieldError("document", "missing_sections", "以下字段只有标题或空代码围栏，请补充正文："+strings.Join(missing, "、"))
	}
	return content, nil
}

// productionPlanDocumentMissing reports absent, empty or duplicate sections in
// canonical field order. "$schema" means the key/kind pair is unsupported.
// This validates structure, not creative quality, and never repairs saved prose.
func productionPlanDocumentMissing(key, kind, content string) []string {
	sections := productionPlanDocumentSections(key, kind)
	if len(sections) == 0 {
		return []string{"$schema"}
	}
	counts, values := map[string]int{}, map[string]bool{}
	current := ""
	closed := productionPlanDocumentScan(content, func(level int, value string) {
		// Historical receipts keep their original text and hash.
		if key == "visual" && level == 2 && value == "特殊资产形态与特效规范" {
			value = "状态变化与效果表现规范"
		}
		if level == 1 || level == 2 {
			current = ""
			if level == 2 {
				current = value
				counts[current]++
			}
		} else if level == 0 && current != "" && strings.TrimSpace(value) != "" {
			values[current] = true
		}
	})
	missing := []string{}
	for _, section := range sections {
		if counts[section.Title] != 1 || !values[section.Title] || (!closed && current == section.Title) {
			missing = append(missing, section.Key)
		}
	}
	return missing
}

// Scan ATX headings while treating fenced examples as body text, so an example
// cannot supply missing document sections. Return false for an unclosed fence.
func productionPlanDocumentScan(content string, visit func(int, string)) bool {
	var fence byte
	fenceLength := 0
	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(raw)
		if line != "" && (line[0] == '`' || line[0] == '~') {
			length := 0
			for length < len(line) && line[length] == line[0] {
				length++
			}
			if fence == 0 && length >= 3 {
				fence, fenceLength = line[0], length
				continue
			}
			if line[0] == fence && length >= fenceLength && strings.TrimSpace(line[length:]) == "" {
				fence, fenceLength = 0, 0
				continue
			}
		}
		level := 0
		if fence == 0 {
			for level < len(line) && line[level] == '#' {
				level++
			}
			if level > 6 || (level < len(line) && line[level] != ' ' && line[level] != '\t') {
				level = 0
			}
		}
		visit(level, strings.TrimSpace(line[level:]))
	}
	return fence == 0
}
