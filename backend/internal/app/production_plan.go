package app

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type productionPlanAsset struct {
	Identity     *productionAssetIdentity `json:"identity,omitempty"`
	BaseKey      string                   `json:"baseKey,omitempty"`
	StateName    string                   `json:"stateName,omitempty"`
	Key          string                   `json:"key"`
	Kind         string                   `json:"kind"`
	Name         string                   `json:"name"`
	Priority     int                      `json:"priority,omitempty"`
	Episodes     []int                    `json:"episodes"`
	Purpose      string                   `json:"purpose,omitempty"`
	PlannedRange string                   `json:"plannedRange,omitempty"`
	DependsOn    []string                 `json:"dependsOn,omitempty"`
	SubjectKeys  []string                 `json:"subjectKeys,omitempty"`
	GroupKind    string                   `json:"groupKind,omitempty"`
}

type productionPlan struct {
	Groups                 map[string]string                  `json:"groups,omitempty"`
	Version                int                                `json:"version,omitempty"`
	ContinuityVersion      int                                `json:"continuityVersion,omitempty"`
	StoryStructureVersion  int                                `json:"storyStructureVersion,omitempty"`
	InventoryReviewVersion int                                `json:"inventoryReviewVersion,omitempty"`
	InventoryReview        []productionInventorySectionReview `json:"inventoryReview,omitempty"`
	Relationships          []productionRelationshipRecord     `json:"relationships,omitempty"`
	Assets                 []productionPlanAsset              `json:"assets"`
	Absent                 map[string]string                  `json:"absent"`
	StoryHash              string                             `json:"storyHash"`
	Complete               bool                               `json:"complete,omitempty"`
	AssetsStarted          bool                               `json:"assetsStarted,omitempty"`
	PlansStarted           bool                               `json:"plansStarted,omitempty"`
	SelectedPlanKeys       []string                           `json:"selectedPlanKeys,omitempty"`
	SelectedAssetKeys      []string                           `json:"selectedAssetKeys,omitempty"`
	SelectedAssetKinds     []string                           `json:"selectedAssetKinds,omitempty"`
	NewVersionAssetKeys    []string                           `json:"newVersionAssetKeys,omitempty"`
	SummaryHash            string                             `json:"summaryHash,omitempty"`
}

var productionPlanKinds = []string{"character", "environment", "prop", "special"}
var productionCurrentPlanKinds = []string{"character", "environment", "prop", "sound"}

var unifiedPlanSections = []productionDocumentSection{{"story", "故事总纲与世界规则"}, {"visual", "视觉与美术规范"}, {"direction", "导演与视听规范"}, {"generation", "生成与一致性规范"}}

const independentPlanPolicy = `只完成当前明确指定的一项文稿并提交一次工具调用，不查询、不检查、不修复、不分析问题、不创建其他产物。故事总纲阶段仅依据本次任务绑定的当前已采用选题和全局参数；严禁读取、引用或复用其他版本故事总纲、旧资产、历史任务结果、历史节点或其他并发方案。其他制作方案各自独立依据已经保存的本版故事总纲与全局参数，不能依赖或声称读取其他并发方案。地区、语言、人物身份、类型、形式和风格严格沿用来源，不预设中国背景或任何特定题材。未知信息明确说明，不虚构已完成的资产或媒体。若当前 key=story，提交前按固定创作链推演：拆解选题的观众承诺与类型机制，确立主角目标/对手力量/主线因果和必要支线，定义时代地域、关系、规则/限制/代价；先画完整季弧线和结局，再按集数分配阶段目标；最后按单集时长逐集填写时地、在场人物、目标阻力、选择行动、结果代价、关系/信息/资产状态和集尾承接。支线须有进展与回收，不以背景设定、人物名单或反复寻找代替剧情推进。时长不足以承载的事件要合并或重排，不能靠一句概述填满集数。资产清单只能在逐集规划完成后提取，并逐集映射人物、地点、实体道具、重复声音及规则效果；同一实体跨集复用身份，漏项必须在完成前补齐。使用本次工具模板完整填写全部适用字段；各类确无内容时逐类给出与故事相符的理由，由系统分配编码，不编造编码。输出是创作方案，结构保存不代表语义质量或人工验收通过。`

func planSection(key string) (productionDocumentSection, bool) {
	if key == "inventory" {
		return productionDocumentSection{"inventory", "资产总表与编码"}, true
	}
	for _, section := range unifiedPlanSections {
		if section.Key == key {
			return section, true
		}
	}
	return productionDocumentSection{}, false
}

func planKinds(m productionManifest) []string {
	if m.Plan != nil && m.Plan.Version >= 3 {
		return append([]string{}, productionCurrentPlanKinds...)
	}
	if m.Plan != nil && m.Plan.Version >= 2 {
		return append(append([]string{}, productionPlanKinds...), "sound")
	}
	return productionPlanKinds
}

const unifiedPlanPolicy = `本轮是制作长任务。只能使用 production_* 工具。当前为前置制作方案，不从尚不存在的正文提取事实，不调用分镜工具或 production_facts。用户已授权自动完成，不需要逐步审核确认；调用及扣费照常统计，任务不按累计次数或积分预算停止。
必须将故事发生地、发行方向、正文语言和人物身份分开解释：全局设定中的故事发生地是故事世界的权威来源，正文语言只决定输出文字语言，发行方向和目标市场只决定发行受众与区域偏好，不能互相替换。严格沿用用户明确选择的地区、社会制度、机构、职业环境、生活细节和世界规则；故事发生地不在中国时，未被选题或原文明确指定为中国籍、华裔、华人或移民的角色，不得仅因为中文输出而自动改成这些身份，也不得自动套用中国式家庭、机构、法律、货币、节日或城市称谓。中文输出可以对当地姓名进行中文音译或译写，但不能改变其故事身份。
必须按当前持久检查点 nextAction 推进：读取已采用选题和全局设定 → story 故事总纲与世界规则 → production_plan_inventory 登记全剧计划资产并完成清单 → visual 视觉美术规范、direction 导演视听规范并行 → generation 生成与连续性规范 → production_check 检查并结束制作方案。资产总表属于方案内容，不是已创建资产。用户手动点击生成资产后，才按依赖并行完成资产档案并单独检查；全部前置规范完成且版本有效且用户已经启动后才允许制作资产档案，规范失败或缺失时不跳过。不要反复检查代替创作。inventory 总表由系统维护，不手工 production_submit。
全局设定是本轮约束；开放结局写明本季解决的主线与留下的悬念，不能强改为封闭结局。故事先完成类型/受众承诺、主线与必要支线、人物目标和对抗力量、世界边界与规则代价，再确定全季起承转合/阶段转折/结局和支线回收，最后严格按项目总集数及单集时长逐集填充。逐集必须给出时地、人物、目标、阻力、选择、行动、因果结果与代价、关系/信息/资产状态变化、阶段收束及下一集承接；节奏需有符合本项目时长的时间预算，不能用“符合时长”或篇章摘要代替。只有这条故事骨架可执行后才进入资产提取。资产总表逐项核对总纲各章和每一集的具体需求，覆盖行动者/有台词或被提及角色、实际地点、出现/转移/使用的实体道具、重复声音和规则效果，逐条给出原文证据及独立登记/并入状态/排除理由；总纲明确写到的底片、照片、账本等实体不能在类别缺省时消失。类别覆盖和字段完整不代表语义完整。清单逐篇章核对覆盖人物（含配角和画外音）、场景、道具、特殊资产、独立声音五类；不存在的类别在 absent 说明原因，不凑数。每项 purpose 写剧情功能，plannedRange 写计划篇章/集段；episodes 可以为空，未确定精确集数不编造。dependsOn 仅填必须先完成设计的资产 key，不把普通人物关系写成循环依赖。全部类别均需填写类别内 priority，从1开始连续且唯一，1为主线重要性最高；人物先主线驱动者和核心对手/共同主角，再主要配角、次要角色、群演/画外人物；场景先核心反复空间及高潮空间，再主要、次要空间；道具先主线关键物件、线索/目标物，再反复使用和一般功能道具；声音与特殊资产按主线作用排序。总表固定按人物、场景、道具、特殊资产、声音分组，组内按 priority 升序，禁止按姓名、出场顺序、提交批次或任务完成时间随机排列。
 登记支持分批，每批 complete=false；覆盖全部篇章和五类后 complete=true 固定本版清单。storyHash 使用当前保存回执。资产 key 为稳定临时标识，系统分配 CHR/SCN/PRP/SPC/AUD 编码；后续沿用 key、name 和返回的编码，不能自行编造编码。重大形态、结构或身份变化需要独立参考图/资产码时，在总清单中新增独立资产条目，kind 沿用 character/environment/prop/special，填写 baseKey 指向基础资产、stateName 写重大形态名称；每个形态有独立节点和基础资产码。普通情绪、伤势、污渍、天气灯光与日常换装写连续性，不另建条目。声音档案只管理独立复用的声音，个人声线以人物档案为权威，相关声音引用人物编码。
每次 production_submit 只保存当前 nextAction 的文稿，document 必须逐字段填写当前 documentSchema；模板会按文稿/资产类型切换，不能套用通用摘要。无适用内容明确说明原因，人物声音和性格不得省略或统一写待确认。facts 区分已定信息与创作设计，计划出场不是正文证据，factIds=[]。提示词使用 @编码。公共规范不重复逐资产设定；生成规范依据总纲、清单、美术与导演规范先定义执行和一致性规则，后续资产设计遵循这些规则，不依赖尚未制作的资产档案或媒体，不展开镜头和首尾帧。
共用规范完整覆盖世界规则、人物关系时间线、全局视觉、美术服化道、摄影剪辑、表演配音、音乐环境声音、生成一致性八个领域，整合进现有四份文稿，不另增八份。人物关系必须在 story.relationships 中追加结构化关系登记表：每条使用 REL-编号、主体、客体、固定关系类型、方向枚举、规范称呼、来源和适用范围。后续按已登记的同一主体、客体、关系及方向核对，保留双方原文证据与适用范围；简称、语言差异、对白称呼及其他人物用词不单独构成冲突，关键词只作待核候选，不能凭词面改事实。按当前 production_submit 各字段 description 的具体要求写设计：规则应明确不变项、允许变化的条件及检查方法，不能只复述全局设定或堆砌电影感等形容词。旧制作规范仅作职责和结构参考，不得从其他项目复制正文事实、资产身份或具体风格。visual 与 direction 可并行，分别依据总纲、清单和当前全局参数，不互相等待或宣称已读取尚未完成的另一份规范；公共职责边界明确，个人声线仍以人物档案为准。
每份及时保存。修订必须保留原内容、编码和已有人工编辑边界，使用当前 expectedHash；读取当前检查点提供的前置成果和必要关联档案，不搬入全部历史。只补缺项或受版本变化影响的文稿。关键内容冲突局部修复，不重做全剧；工具不可用等系统错误应停止并保留进度，不能用连续解释替代执行。检查通过后结束；结构校验不等于语义质量或人工验收通过。`

const productionPlanPolicy = `本轮是制作长任务。只能使用 production_* 工具。当前任务是基于本次任务绑定的当前已采用选题和全局参数，重新创作完整制作方案，不是从尚不存在的正文提取事实，不调用 production_facts。严禁读取、引用或复用其他版本故事总纲、旧资产、历史任务结果、历史节点或旧方案；本次剧情必须从当前选题自行解析和推演。
先 production_status / production_read 读取选题和制作参数。写总纲之前先从选题确定题材承诺、主角目标、对抗力量、核心代价与主线因果；再确定必要支线、人物关系和世界规则；先排全季阶段弧线、转折与结局，然后依据总集数和单集时长逐集填写时间地点、在场人物、目标阻力、选择行动、结果代价、关系/信息/资产状态和下集承接，并给出对应时长的节奏预算。仅在逐集故事骨架成立后，才用 production_submit 保存 key=story、name=故事总纲 的完整故事：document.facts 写选题依据与定位、总集数和时长；design 写世界规则、完整起承转合与明确结局、逐篇章集数分配、人物关系弧光；continuity 写伏笔回收、视听基准和连续性；uncertainties 区分选题已定信息和创作设计。不要用梗概或篇章摘要代替主支线及逐集规划，也不要提前扩写对白正文。
再 production_plan_inventory 登记全剧预计出现的所有人物、独立场景、剧情道具和特殊资产，含配角、群演类别及画外音人物。逐条审阅总纲各章和每一集的原文依据，逐集映射人物、地点、实体道具、声音及规则效果，标记独立登记、并入既有身份/状态或排除及理由；总纲明确出现的底片、照片、账本等实体不能因类别缺省、只出现少量镜头或清单已够数量而漏掉。当前模板要求 inventoryReview 时必须提交完整来源核对。key 使用稳定编号 C001/E001/P001/S001，kind 为 character/environment/prop/special，name 唯一，episodes 为预计出场集数，不能为空。priority 是同类别内从1开始连续唯一的主次排名，1最重要：人物依主线驱动者、核心对手/共同主角、主要配角、次要角色、群演/画外人物排序；场景依核心反复/高潮空间、主要空间、次要空间排序；道具依关键物件/线索目标物、反复使用物、一般功能物排序；其他资产按主线作用排序。总表固定按人物、场景、道具、特殊资产、声音分组，组内按 priority 升序；不能按姓名、首次出场、提交批次或生成完成顺序随机排列。重大变身、兽化、机械化、显著年龄/体型改变、场景拓扑重构、道具结构完全改变，若需要独立参考图，应作为独立资产条目登记，沿用相同 kind，增加 baseKey 指向基础资产并填写 stateName；不要塞进人物/场景/道具节点的 variants。日常状态仍写连续性。每类必须列全，确无该类时在 absent 中写明理由；禁止用“其他人物/其他场景略”代替清单。storyHash 使用 story 的保存回执 hash。超过单次参数容量时可逐批登记，服务端按 key 合并，不删除旧项；完成全部登记后再生成详情。计划完整性仍须自行逐篇章核对。
 接着逐资产 production_submit，key/name 与清单一致，factIds=[]。每个资产一个完整文本节点，自动进入同一制作方案容器。document.facts 写稳定编号、别名、剧情功能和预计出场集数（计划不是正文证据）；design 写完整可执行设定：人物必须包含性格、欲望/恐惧、关系弧光、外貌、服装妆发；场景含布局、出入口、时代材质及空间关系；道具含外观、归属、用途；特殊资产含触发条件、能力边界、代价和形态。variants 只写需要独立参考图/独立资产码的重大形态、结构或身份变化，没有则写 []；疲惫、受伤、污渍、湿润、日夜天气、开关灯、持物、开合、运行、位置和普通换装写入 design/continuity 或镜头状态。sound 对人物必须给音色、音域、语速、口音、表演边界和配音提示词，场景给环境声，道具/特殊资产给标志音。prompt/negativePrompt 给可复用制作描述及禁止变化；continuity 写跨集不变项和变化条件；uncertainties 标明创作设计及未定事项。声音和性格不能省略或一律待确认。
一项太长时按可独立复用的资产或状态拆分清单，禁止截断、概括省略或把全部资产挤入单个文稿。生成途中立即保存，每次只处理缺项；修订先 production_query(assetKey) 取得原稿和 expectedHash，保留旧内容和编号。以 production_check 返回的缺项继续补齐。清单与总纲版本一致、每项完整保存并通过检查后结束，不按调用次数或积分预算停止。无需另行审核确认；用户会审阅调整。不得宣称参考图、音频或人工验收已完成。`

func productionPlanTools(versions ...int) []map[string]any {
	kinds := append(append([]string{}, productionPlanKinds...), "sound")
	if len(versions) > 0 && versions[0] >= 3 {
		kinds = append([]string{}, productionCurrentPlanKinds...)
	}
	str := map[string]any{"type": "string"}
	absent := map[string]any{}
	for _, kind := range kinds {
		absent[kind] = str
	}
	return []map[string]any{{"type": "function", "function": map[string]any{
		"name": "production_plan_inventory", "description": "登记制作方案预计资产。按 key 合并；complete=true 表示全篇章所需类别核对完成，系统保存总表。priority 为同类别内从1开始连续唯一的剧情重要性排名，1最重要，按角色/空间/道具/声音的主线作用排序，不按名字或出场顺序排列。重大变形若需独立参考图，新增同 kind 的资产条目，并提供 baseKey 和 stateName；普通状态不新增条目。plannedRange 可用篇章/集段，不确定的 episodes 留空。dependsOn 只填设计前置资产 key。storyHash 使用当前总纲回执。",
		"parameters": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"storyHash", "assets", "absent"}, "properties": map[string]any{
			"storyHash": str, "absent": map[string]any{"type": "object", "properties": absent, "additionalProperties": false},
			"complete": map[string]any{"type": "boolean"},
			"assets": map[string]any{"type": "array", "maxItems": 100, "items": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"key", "kind", "name", "episodes"}, "properties": map[string]any{
				"key": str, "kind": map[string]any{"type": "string", "enum": kinds}, "name": str, "baseKey": str, "stateName": str,
				"episodes": map[string]any{"type": "array", "items": map[string]any{"type": "integer", "minimum": 1}, "maxItems": 200},
				"priority": map[string]any{"type": "integer", "minimum": 1, "maximum": 100, "description": "类别内剧情重要性排名；1最重要，必须连续唯一"},
				"purpose":  str, "plannedRange": str, "dependsOn": map[string]any{"type": "array", "items": str, "maxItems": 100},
			}}},
		}},
	}}}
}

func productionPlanItem(m productionManifest, key string) *productionPlanAsset {
	if m.Plan != nil {
		for i := range m.Plan.Assets {
			if m.Plan.Assets[i].Key == key {
				return &m.Plan.Assets[i]
			}
		}
	}
	return nil
}

func productionPlanInventory(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, m productionManifest, doc map[string]any, call cloudAgentCall, policy RuntimePolicySetting) (any, error) {
	if m.Plan == nil {
		return nil, BadAuthRequest("当前任务不是制作方案")
	}
	var input productionPlan
	if err := decodeCloudAgentJSONObject(call.Function.Arguments, &input); err != nil {
		return nil, cloudAgentJSONArgumentError(err)
	}
	if m.Plan.Version >= 5 && !input.Complete {
		return nil, BadAuthRequest("完整资产总表需在本次调用一次提交，并明确 complete=true")
	}
	artifacts, err := repo.ProductionAgentArtifacts(run.UserID, run.ID)
	if err != nil {
		return nil, err
	}
	storyValid := false
	for _, a := range artifacts {
		if a.Key == "story" && input.StoryHash == a.ContentHash && productionArtifactMatches(productionNode(doc, a.NodeID), a.ContentHash) {
			storyValid = true
		}
	}
	if len(m.Plan.SelectedAssetKinds) > 0 && productionPlanStoryPresent(m, doc, artifacts) {
		storyValid = true
	}
	if !storyValid {
		return nil, BadAuthRequest("请先保存故事总纲，再使用当前 storyHash 登记资产清单")
	}
	if m.Plan.Version >= 2 && len(m.Plan.SelectedAssetKinds) == 0 && !productionPlanArtifactValid(m, doc, artifacts, "story") {
		return nil, BadAuthRequest("请先补齐当前模板的故事总纲并读取全部选题来源")
	}
	if len(m.Plan.SelectedAssetKinds) > 0 && !productionPlanStoryPresent(m, doc, artifacts) {
		return nil, BadAuthRequest("请先保存当前制作方案的故事总纲")
	}
	if len(input.Assets) > 100 {
		return nil, BadAuthRequest("单批最多登记100项，请分批追加")
	}
	next := *m.Plan
	next.Assets = append([]productionPlanAsset{}, next.Assets...)
	for i := range next.Assets {
		next.Assets[i].Episodes = append([]int{}, next.Assets[i].Episodes...)
		next.Assets[i].DependsOn = append([]string{}, next.Assets[i].DependsOn...)
		next.Assets[i].SubjectKeys = append([]string{}, next.Assets[i].SubjectKeys...)
	}
	next.Absent = map[string]string{}
	for kind, reason := range m.Plan.Absent {
		next.Absent[kind] = reason
	}
	var validationFailures []error
	absentKinds := make([]string, 0, len(input.Absent))
	for kind := range input.Absent {
		absentKinds = append(absentKinds, kind)
	}
	sort.Strings(absentKinds)
	for _, kind := range absentKinds {
		reason := input.Absent[kind]
		if !cloudAgentContainsString(planKinds(m), kind) || strings.TrimSpace(reason) == "" {
			validationFailures = append(validationFailures, cloudAgentFieldError("absent."+kind, "invalid_absence", "缺省分类必须有有效类型和理由；只传确实缺省的类别及非空理由，有资产的类别不要传空字符串占位"))
			continue
		}
		next.Absent[kind] = reason
	}
	frame := productionNode(doc, m.FrameID)
	parameters, _ := productionWorkflow(frame)["parameters"].(map[string]any)
	count, _ := parameters["episodeCount"].(float64)
	seen := map[string]bool{}
	for assetIndex, item := range input.Assets {
		path := fmt.Sprintf("assets[%d]", assetIndex)
		item.Episodes = append([]int{}, item.Episodes...)
		item.DependsOn = append([]string{}, item.DependsOn...)
		item.SubjectKeys = append([]string{}, item.SubjectKeys...)
		item.Purpose, item.PlannedRange = strings.TrimSpace(item.Purpose), strings.TrimSpace(item.PlannedRange)
		_, reserved := planSection(item.Key)
		if reserved || strings.HasPrefix(item.Key, "$") || strings.TrimSpace(item.Key) == "" || item.Key != strings.TrimSpace(item.Key) || len(item.Key) > 120 || strings.TrimSpace(item.Name) == "" || item.Name != strings.TrimSpace(item.Name) || utf8.RuneCountInString(item.Name) > 120 || !cloudAgentContainsString(planKinds(m), item.Kind) || (m.Plan.Version < 2 && len(item.Episodes) == 0) || seen[item.Key] {
			validationFailures = append(validationFailures, cloudAgentFieldError(path, "invalid_identity", "资产清单需要唯一 key、名称、有效类型及预计出场集数；key 不得使用共用文稿名或保留前缀"))
		}
		if m.Plan.Version >= 2 && (strings.TrimSpace(item.Purpose) == "" || strings.TrimSpace(item.PlannedRange) == "" || len(item.Purpose) > 4000 || len(item.PlannedRange) > 2000 || len(item.DependsOn) > 100) {
			validationFailures = append(validationFailures, cloudAgentFieldError(path, "invalid_asset_plan", "每项资产需要剧情功能 purpose、计划篇章或集段 plannedRange；精确 episodes 未定时可以留空，字段长度及前置数量须符合当前契约"))
		}
		if (item.BaseKey == "") != (item.StateName == "") || (item.BaseKey != "" && (item.BaseKey == item.Key || strings.TrimSpace(item.BaseKey) != item.BaseKey || strings.TrimSpace(item.StateName) != item.StateName)) {
			validationFailures = append(validationFailures, cloudAgentFieldError(path, "invalid_asset_state", "独立重大形态需同时提供 baseKey 和 stateName；baseKey 指向基础资产，kind 与基础资产一致"))
		}
		seen[item.Key] = true
		episodes := map[int]bool{}
		for episodeIndex, episode := range item.Episodes {
			if episode < 1 || episode > int(count) || episodes[episode] {
				validationFailures = append(validationFailures, cloudAgentFieldError(fmt.Sprintf("%s.episodes[%d]", path, episodeIndex), "invalid_episode", "预计出场集数重复或超出计划集数"))
			}
			episodes[episode] = true
		}
		found := false
		for i, prior := range next.Assets {
			if prior.Key == item.Key {
				item.Identity = prior.Identity
				item.GroupKind = prior.GroupKind
				if prior.Kind != item.Kind || prior.Name != item.Name {
					validationFailures = append(validationFailures, cloudAgentFieldError(path, "registered_identity_changed", fmt.Sprintf("资产 %s 的身份已登记：kind=%s，name=%s；请逐字沿用 registeredAssets 的 key、kind、name，只提交未登记项或允许更新的计划字段", prior.Key, prior.Kind, prior.Name)))
				}
				if prior.BaseKey != item.BaseKey || prior.StateName != item.StateName {
					validationFailures = append(validationFailures, cloudAgentFieldError(path, "registered_state_changed", "已登记独立形态的基础资产和形态身份不可变；请沿用 registeredAssets 中的 baseKey/stateName"))
				}
				if m.Plan.Version < 2 && productionHash(prior) != productionHash(item) {
					validationFailures = append(validationFailures, cloudAgentFieldError(path, "registered_asset_changed", "已登记资产不允许更换身份或出场范围，请保留原清单并在文稿中说明修订"))
				}
				next.Assets[i], found = item, true
			} else if strings.EqualFold(strings.TrimSpace(prior.Name), strings.TrimSpace(item.Name)) {
				validationFailures = append(validationFailures, cloudAgentFieldError(path+".key", "registered_name_exists", "同名资产应复用原 key："+truncateRunes(prior.Key, 80)))
			}
		}
		if !found {
			item.Identity = nil
			item.GroupKind = ""
			if m.Plan.Version >= 2 {
				for _, node := range creationMaps(doc["nodes"]) {
					wd := productionWorkflow(node)
					value, _ := wd["assetIdentity"].(map[string]any)
					if wd["pipelineId"] == productionWorkflow(frame)["pipelineId"] && value != nil && value["code"] == item.Key && value["kind"] == item.Kind {
						item.Identity = &productionAssetIdentity{ID: stringValue(value["id"]), Code: stringValue(value["code"]), Kind: item.Kind}
					}
				}
			}
			next.Assets = append(next.Assets, item)
		}
		delete(next.Absent, item.Kind)
	}
	// Props and scenes may be associated, but neither category needs the other
	// category's dossier before it can be generated.
	for i := range next.Assets {
		item := &next.Assets[i]
		filtered := item.DependsOn[:0]
		for _, dependencyKey := range item.DependsOn {
			dependency := productionPlanItem(productionManifest{Plan: &next}, dependencyKey)
			crossesPropSceneCategories := dependency != nil && ((item.Kind == "prop" && dependency.Kind == "environment") || (item.Kind == "environment" && dependency.Kind == "prop"))
			if !crossesPropSceneCategories {
				filtered = append(filtered, dependencyKey)
			}
		}
		item.DependsOn = filtered
	}
	for i, item := range next.Assets {
		if item.BaseKey == "" {
			continue
		}
		base := productionPlanItem(productionManifest{Plan: &next}, item.BaseKey)
		if (input.Complete && base == nil) || (base != nil && (base.Kind != item.Kind || base.BaseKey != "")) {
			validationFailures = append(validationFailures, cloudAgentFieldError(fmt.Sprintf("assets[%d].baseKey", i), "invalid_base_asset", "baseKey 必须指向同类基础资产，不能指向另一独立形态"))
		}
		if base != nil && !cloudAgentContainsString(item.DependsOn, base.Key) {
			item.DependsOn = append(item.DependsOn, base.Key)
			sort.Strings(item.DependsOn)
			next.Assets[i] = item
		}
	}
	for _, item := range next.Assets {
		delete(next.Absent, item.Kind)
	}
	if input.Complete && m.Plan.Version >= 5 {
		priorities := map[string]map[int]bool{}
		for index, item := range next.Assets {
			if item.Priority < 1 || item.Priority > 100 {
				validationFailures = append(validationFailures, cloudAgentFieldError(fmt.Sprintf("assets[%d].priority", index), "invalid_priority", "每项资产必须有1至100的类别内主次序号，1最重要"))
				continue
			}
			if priorities[item.Kind] == nil {
				priorities[item.Kind] = map[int]bool{}
			}
			if priorities[item.Kind][item.Priority] {
				validationFailures = append(validationFailures, cloudAgentFieldError(fmt.Sprintf("assets[%d].priority", index), "duplicate_priority", "同类别 priority 必须连续且唯一；按剧情重要性从1开始排序"))
			}
			priorities[item.Kind][item.Priority] = true
		}
		for kind, ranks := range priorities {
			for rank := 1; rank <= len(ranks); rank++ {
				if !ranks[rank] {
					validationFailures = append(validationFailures, cloudAgentFieldError("assets.priority", "non_contiguous_priority", fmt.Sprintf("%s 类别 priority 必须从1开始连续编号", productionPlanGroupLabels[kind])))
					break
				}
			}
		}
	}
	sortProductionPlanAssets(next.Assets)
	if next.StoryHash != input.StoryHash {
		next.InventoryReview = nil
	}
	next.StoryHash = input.StoryHash
	if next.InventoryReviewVersion > 0 {
		review, reviewErr := productionPreviewInventoryReview(next, input.InventoryReview)
		validationFailures = append(validationFailures, reviewErr)
		if review != nil {
			next.InventoryReview = review
			validationFailures = append(validationFailures, productionValidateInventoryReview(next, doc, m.FrameID, artifacts, input.Complete))
		}
	}
	if m.Plan.Version >= 2 {
		next.Complete = input.Complete
		if next.Complete {
			validationFailures = append(validationFailures, productionValidatePlanInventory(next), productionValidateRelationshipParticipants(next))
		}
	}
	if !(m.Plan.Version >= 5 && !input.Complete) {
		if err := cloudAgentValidationErrors(validationFailures...); err != nil {
			return nil, err
		}
	}
	for i := range next.Assets {
		sort.Ints(next.Assets[i].Episodes)
		sort.Strings(next.Assets[i].DependsOn)
		sort.Strings(next.Assets[i].SubjectKeys)
	}
	if m.Plan.Version >= 2 {
		if m.Plan.Complete && m.Plan.StoryHash == input.StoryHash {
			if productionPlanInventoryHash(*m.Plan) != productionPlanInventoryHash(next) {
				if len(next.SelectedAssetKinds) == 0 && (len(m.Plan.Assets) != 0 || len(next.Assets) == 0) {
					return nil, BadAuthRequest("本版资产清单已完成登记，不能在详情生成中扩大或改变范围；请创建新方案版本")
				}
			}
			next.Complete = true
		}
	}
	// Validation is read-only. Reserve identities only after the entire proposal
	// passes, so collecting diagnostics cannot consume codes for rejected drafts.
	if m.Plan.Version >= 2 {
		for _, kind := range planKinds(m) {
			var indices []int
			for i, item := range next.Assets {
				if item.Kind == kind && item.Identity == nil {
					indices = append(indices, i)
				}
			}
			if len(indices) == 0 {
				continue
			}
			identities, err := newProductionAssetIdentities(repo, state.Request.CanvasID, stringValue(productionWorkflow(frame)["pipelineId"]), kind, len(indices))
			if err != nil {
				return nil, err
			}
			for i, index := range indices {
				next.Assets[index].Identity = identities[i]
			}
		}
	}
	if input.Complete && len(next.SelectedAssetKinds) > 0 {
		selectedKinds := make(map[string]bool, len(next.SelectedAssetKinds))
		for _, kind := range next.SelectedAssetKinds {
			selectedKinds[kind] = true
		}
		next.SelectedAssetKeys = nil
		for _, asset := range next.Assets {
			if selectedKinds[asset.Kind] {
				next.SelectedAssetKeys = append(next.SelectedAssetKeys, asset.Key)
			}
		}
		if len(next.SelectedAssetKeys) == 0 {
			return nil, BadAuthRequest("当前制作方案没有可从总纲提取的所选类别资产")
		}
		next.AssetsStarted = true
		next.PlansStarted = false
		next.SelectedPlanKeys = nil
		next.SelectedAssetKinds = nil
	}
	m.Plan = &next
	encoded, _ := json.Marshal(m)
	if err = repo.UpdateProductionAgentManifest(run.UserID, run.ID, string(encoded)); err != nil {
		return nil, err
	}
	if err = repo.ValidateProductionAgentJob(run.UserID, run.ID, false); err != nil {
		return nil, err
	}
	if m.Plan.Version >= 2 && next.Complete {
		if err := productionSavePlanInventory(repo, run, state, m, doc, artifacts, policy); err != nil {
			return nil, err
		}
		artifacts, err = repo.ProductionAgentArtifacts(run.UserID, run.ID)
		if err != nil {
			return nil, err
		}
	}
	report := productionPlanCoverage(m, doc, artifacts)
	report["registeredAssets"] = next.Assets
	if m.Plan.Version >= 2 {
		report["nextAction"] = productionPlanNextAction(m, doc, artifacts)
	}
	return report, nil
}

func productionPlanCoverage(m productionManifest, doc map[string]any, artifacts []model.ProductionAgentArtifact) map[string]any {
	if m.Plan.Version >= 2 {
		return productionOrderedPlanCoverage(m, doc, artifacts)
	}
	issues := []string{}
	missing := []productionPlanAsset{}
	valid := map[string]bool{}
	for _, source := range m.Sources {
		for _, id := range source.Pages {
			if !m.Read[id] {
				issues = append(issues, "选题来源尚未读取")
			}
		}
	}
	for _, a := range artifacts {
		node := productionNode(doc, a.NodeID)
		meta, _ := node["metadata"].(map[string]any)
		if node == nil || node["parentId"] != m.FrameID || !productionArtifactMatches(node, a.ContentHash) || len(productionDocumentMissing("plan", a.Key, stringValue(meta["content"]))) > 0 {
			issues = append(issues, "文稿已变更、缺失或不完整："+a.Key)
			continue
		}
		valid[a.Key] = true
		if a.Key == "story" && a.ContentHash != m.Plan.StoryHash {
			issues = append(issues, "资产清单尚未对应当前故事总纲版本")
		}
	}
	if !valid["story"] {
		issues = append(issues, "缺少故事总纲")
	}
	if m.Plan.Version >= 2 {
		for _, section := range unifiedPlanSections {
			if !valid[section.Key] && section.Key != "story" {
				issues = append(issues, "缺少前置制作规范："+section.Title)
			}
		}
	}
	if m.Plan.StoryHash == "" {
		issues = append(issues, "尚未登记完整资产清单")
	}
	for _, kind := range planKinds(m) {
		found := false
		for _, item := range m.Plan.Assets {
			if item.Kind == kind {
				found = true
			}
		}
		if !found && m.Plan.Absent[kind] == "" {
			issues = append(issues, "尚未核对资产类别："+kind)
		}
	}
	for _, item := range m.Plan.Assets {
		if !valid[item.Key] {
			missing = append(missing, item)
		}
	}
	if len(missing) > 0 {
		issues = append(issues, fmt.Sprintf("还有%d项资产设定未完成", len(missing)))
	}
	return map[string]any{"valid": len(issues) == 0, "issues": issues, "missingAssets": missing[:min(12, len(missing))], "missingCount": len(missing), "artifactCount": len(artifacts), "plannedAssets": len(m.Plan.Assets), "absent": m.Plan.Absent, "semanticReview": "计划清单覆盖已核对；剧情与资产语义完整性待人工验收"}
}

func productionPlanContext(repo *repository.Repository, run *model.CloudAgentExecution, m productionManifest, doc map[string]any) (map[string]any, error) {
	artifacts, err := repo.ProductionAgentArtifacts(run.UserID, run.ID)
	if err != nil {
		return nil, err
	}
	context := map[string]any{"progress": productionPlanCoverage(m, doc, artifacts), "instruction": "按 nextAction 补齐当前缺项；只处理当前版本的未完成工作。"}
	if m.Plan.Version >= 2 {
		action := productionPlanNextAction(m, doc, artifacts)
		context["nextAction"] = action
		context["requiredDocuments"] = productionPlanRequiredContext(m, doc, artifacts, stringValue(action["key"]))
		context["projectParameters"] = productionWorkflow(productionNode(doc, m.FrameID))["parameters"]
		if stringValue(action["key"]) == "inventory" && len(m.Plan.SelectedAssetKinds) > 0 {
			context["selectedAssetKinds"] = m.Plan.SelectedAssetKinds
			context["instruction"] = "用户正在生成指定类别资产。只依据本版故事总纲和已登记资产总表，从总纲提取完整资产清单；不读取或引用选题来源、项目参数、其他方案文稿或历史资产。完成清单后系统会自动继续生成所选类别。"
			delete(context, "projectParameters")
		}
		// Reads are durable prerequisites, but their bodies used to disappear
		// whenever a status call became the latest runtime tool group.
		// Keep only this plan's already-read inputs until its story is saved.
		if action["phase"] == string(planPhaseInput) || action["phase"] == string(planPhaseStory) {
			sources := []map[string]any{}
			for _, source := range m.Sources {
				for _, id := range source.Pages {
					if !m.Read[id] {
						continue
					}
					page, err := repo.ProductionAgentPage(run.UserID, id)
					if err != nil {
						return nil, err
					}
					sources = append(sources, map[string]any{"pageId": id, "sourceId": source.NodeID, "step": source.Step, "text": page.Text})
				}
			}
			context["sourceInputs"] = sources
			context["instruction"] = "sourceInputs 是本任务当前版本已读取的原始材料，不需要重新读取。结合 projectParameters 按 nextAction 推进；总纲保存后后续阶段使用 requiredDocuments，不反复说明启动计划或查询未变化的进度。"
		}
	}
	index := []map[string]any{}
	for _, asset := range m.Plan.Assets {
		index = append(index, map[string]any{"key": asset.Key, "name": asset.Name, "kind": asset.Kind, "identity": asset.Identity, "episodes": asset.Episodes, "purpose": asset.Purpose, "plannedRange": asset.PlannedRange, "dependsOn": asset.DependsOn, "subjectKeys": asset.SubjectKeys, "baseKey": asset.BaseKey, "stateName": asset.StateName})
	}
	context["registeredAssets"] = index
	context["selectedAssetKeys"] = m.Plan.SelectedAssetKeys
	if m.Plan.Version >= 2 {
		if next, ok := context["nextAction"].(map[string]any); ok {
			if sections, exists := next["sourceSections"]; exists {
				context["sourceSections"] = sections
			}
		}
		existing := map[string]map[string]any{}
		for _, node := range creationMaps(doc["nodes"]) {
			wd := productionWorkflow(node)
			identity, _ := wd["assetIdentity"].(map[string]any)
			if wd["pipelineId"] == productionWorkflow(productionNode(doc, m.FrameID))["pipelineId"] && identity != nil && node["type"] == "text" {
				existing[stringValue(identity["code"])] = map[string]any{"identity": identity, "name": node["title"]}
			}
		}
		context["existingAssets"] = existing
		context["reuseInstruction"] = "同一资产的新方案版本使用 existingAssets 中的编码作为登记 key 复用身份。不要仅因同名合并不同主体；新主体用新的临时 key。"
	}
	if m.Plan.Version >= 2 {
		context["sections"] = unifiedPlanSections
	}
	for _, a := range artifacts {
		if a.Key == "story" && m.Plan.Version < 2 {
			meta, _ := productionNode(doc, a.NodeID)["metadata"].(map[string]any)
			context["story"] = map[string]any{"content": meta["content"], "hash": a.ContentHash}
		}
	}
	return context, nil
}
