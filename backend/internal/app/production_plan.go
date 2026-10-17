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
	Key          string                   `json:"key"`
	Kind         string                   `json:"kind"`
	Name         string                   `json:"name"`
	Episodes     []int                    `json:"episodes"`
	Purpose      string                   `json:"purpose,omitempty"`
	PlannedRange string                   `json:"plannedRange,omitempty"`
	DependsOn    []string                 `json:"dependsOn,omitempty"`
	GroupKind    string                   `json:"groupKind,omitempty"`
}

type productionPlan struct {
	Groups    map[string]string     `json:"groups,omitempty"`
	Version   int                   `json:"version,omitempty"`
	Assets    []productionPlanAsset `json:"assets"`
	Absent    map[string]string     `json:"absent"`
	StoryHash string                `json:"storyHash"`
	Complete  bool                  `json:"complete,omitempty"`
}

var productionPlanKinds = []string{"character", "environment", "prop", "special"}
var productionCurrentPlanKinds = []string{"character", "environment", "prop", "sound"}

var unifiedPlanSections = []productionDocumentSection{{"story", "故事总纲与世界规则"}, {"visual", "视觉与美术规范"}, {"direction", "导演与视听规范"}, {"generation", "生成与一致性规范"}}

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
必须按当前持久检查点 nextAction 推进：读取已采用选题和全局设定 → story 故事总纲与世界规则 → production_plan_inventory 登记全剧计划资产并完成清单 → visual 视觉美术规范、direction 导演视听规范 → 按依赖逐项完成资产档案 → generation 生成与连续性规范 → production_check 检查完成。不可跳过前置成果；不要反复检查代替创作。inventory 总表由系统维护，不手工 production_submit。
全局设定是本轮约束；开放结局写明本季解决的主线与留下的悬念，不能强改为封闭结局。总纲先确定人物戏剧功能、关系、世界边界、篇章集段和因果链，不展开逐集正文。清单逐篇章核对覆盖人物（含配角和画外音）、场景、道具、特殊资产、独立声音五类；不存在的类别在 absent 说明原因，不凑数。每项 purpose 写剧情功能，plannedRange 写计划篇章/集段；episodes 可以为空，未确定精确集数不编造。dependsOn 仅填必须先完成设计的资产 key，不把普通人物关系写成循环依赖。
登记支持分批，每批 complete=false；覆盖全部篇章和五类后 complete=true 固定本版清单。storyHash 使用当前保存回执。资产 key 为稳定临时标识，系统分配 CHR/SCN/PRP/SPC/AUD 编码；后续沿用 key、name 和返回的编码，不能自行编造编码。服装与状态作为 variants，不另建人物。声音档案只管理独立复用的声音，个人声线以人物档案为权威，相关声音引用人物编码。
每次 production_submit 只保存当前 nextAction 的文稿，document 必须逐字段填写当前 documentSchema；模板会按文稿/资产类型切换，不能套用通用摘要。无适用内容明确说明原因，人物声音和性格不得省略或统一写待确认。facts 区分已定信息与创作设计，计划出场不是正文证据，factIds=[]。提示词使用 @编码。公共规范不重复逐资产设定，生成规范最后归纳已完成的设计，不展开镜头和首尾帧。
共用规范完整覆盖世界规则、人物关系时间线、全局视觉、美术服化道、摄影剪辑、表演配音、音乐环境声音、生成一致性八个领域，整合进现有四份文稿，不另增八份。按当前 production_submit 各字段 description 的具体要求写设计：规则应明确不变项、允许变化的条件及检查方法，不能只复述全局设定或堆砌电影感等形容词。旧制作规范仅作职责和结构参考，不得从其他项目复制正文事实、资产身份或具体风格。visual 与 direction 可并行，分别依据总纲、清单和当前全局参数，不互相等待或宣称已读取尚未完成的另一份规范；公共职责边界明确，个人声线仍以人物档案为准。
每份及时保存。修订必须保留原内容、编码和已有人工编辑边界，使用当前 expectedHash；读取当前检查点提供的前置成果和必要关联档案，不搬入全部历史。只补缺项或受版本变化影响的文稿。关键内容冲突局部修复，不重做全剧；工具不可用等系统错误应停止并保留进度，不能用连续解释替代执行。检查通过后结束；结构校验不等于语义质量或人工验收通过。`

const productionPlanPolicy = `本轮是制作长任务。只能使用 production_* 工具。当前任务是基于已采用选题创作完整制作方案，不是从尚不存在的正文提取事实，不调用 production_facts。
先 production_status / production_read 读取选题和制作参数。先用 production_submit 保存 key=story、name=故事总纲 的完整故事：document.facts 写选题依据与定位、总集数和时长；design 写世界规则、完整起承转合与明确结局、逐篇章集数分配、人物关系弧光；continuity 写伏笔回收、视听基准和连续性；uncertainties 区分选题已定信息和创作设计。不要提前展开逐集正文。
再 production_plan_inventory 登记全剧预计出现的所有人物、独立场景、剧情道具和特殊资产，含配角、群演类别及画外音人物。key 使用稳定编号 C001/E001/P001/S001，kind 为 character/environment/prop/special，name 唯一，episodes 为预计出场集数，不能为空。每类必须列全，确无该类时在 absent 中写明理由；禁止用“其他人物/其他场景略”代替清单。storyHash 使用 story 的保存回执 hash。超过单次参数容量时可逐批登记，服务端按 key 合并，不删除旧项；完成全部登记后再生成详情。计划完整性仍须自行逐篇章核对。
接着逐资产 production_submit，key/name 与清单一致，factIds=[]。每个资产一个完整文本节点，自动进入同一制作方案容器。document.facts 写稳定编号、别名、剧情功能和预计出场集数（计划不是正文证据）；design 写完整可执行设定：人物必须包含性格、欲望/恐惧、关系弧光、外貌、服装妆发；场景含布局、出入口、时代材质及空间关系；道具含外观、归属、用途；特殊资产含触发条件、能力边界、代价和形态。variants 写服化、日夜、损坏等状态；sound 对人物必须给音色、音域、语速、口音、表演边界和配音提示词，场景给环境声，道具/特殊资产给标志音。prompt/negativePrompt 给可复用制作描述及禁止变化；continuity 写跨集不变项和变化条件；uncertainties 标明创作设计及未定事项。声音和性格不能省略或一律待确认。
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
		"name": "production_plan_inventory", "description": "登记制作方案预计资产。按 key 合并；complete=true 表示全篇章所需类别核对完成，系统保存总表。按当前 kind 枚举登记，不新增独立特殊资产。plannedRange 可用篇章/集段，不确定的 episodes 留空。dependsOn 只填设计前置资产 key。storyHash 使用当前总纲回执。",
		"parameters": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"storyHash", "assets", "absent"}, "properties": map[string]any{
			"storyHash": str, "absent": map[string]any{"type": "object", "properties": absent, "additionalProperties": false},
			"complete": map[string]any{"type": "boolean"},
			"assets": map[string]any{"type": "array", "maxItems": 100, "items": map[string]any{"type": "object", "additionalProperties": false, "required": []string{"key", "kind", "name", "episodes"}, "properties": map[string]any{
				"key": str, "kind": map[string]any{"type": "string", "enum": kinds}, "name": str,
				"episodes": map[string]any{"type": "array", "items": map[string]any{"type": "integer", "minimum": 1}, "maxItems": 200},
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
	if !storyValid {
		return nil, BadAuthRequest("请先保存故事总纲，再使用当前 storyHash 登记资产清单")
	}
	if m.Plan.Version >= 2 && !productionPlanArtifactValid(m, doc, artifacts, "story") {
		return nil, BadAuthRequest("请先补齐当前模板的故事总纲并读取全部选题来源")
	}
	if len(input.Assets) > 100 {
		return nil, BadAuthRequest("单批最多登记100项，请分批追加")
	}
	next := *m.Plan
	next.Assets = append([]productionPlanAsset{}, next.Assets...)
	next.Absent = map[string]string{}
	for kind, reason := range m.Plan.Absent {
		next.Absent[kind] = reason
	}
	for kind, reason := range input.Absent {
		if !cloudAgentContainsString(planKinds(m), kind) || strings.TrimSpace(reason) == "" {
			return nil, BadAuthRequest("缺省分类必须有有效类型和理由")
		}
		next.Absent[kind] = reason
	}
	frame := productionNode(doc, m.FrameID)
	parameters, _ := productionWorkflow(frame)["parameters"].(map[string]any)
	count, _ := parameters["episodeCount"].(float64)
	seen := map[string]bool{}
	for _, item := range input.Assets {
		item.Episodes = append([]int{}, item.Episodes...)
		sort.Ints(item.Episodes)
		item.DependsOn = append([]string{}, item.DependsOn...)
		sort.Strings(item.DependsOn)
		item.Purpose, item.PlannedRange = strings.TrimSpace(item.Purpose), strings.TrimSpace(item.PlannedRange)
		_, reserved := planSection(item.Key)
		if reserved || strings.HasPrefix(item.Key, "$") || strings.TrimSpace(item.Key) == "" || item.Key != strings.TrimSpace(item.Key) || len(item.Key) > 120 || strings.TrimSpace(item.Name) == "" || item.Name != strings.TrimSpace(item.Name) || utf8.RuneCountInString(item.Name) > 120 || !cloudAgentContainsString(planKinds(m), item.Kind) || (m.Plan.Version < 2 && len(item.Episodes) == 0) || seen[item.Key] {
			return nil, BadAuthRequest("资产清单需要唯一 key、名称、有效类型及预计出场集数")
		}
		if m.Plan.Version >= 2 && (strings.TrimSpace(item.Purpose) == "" || strings.TrimSpace(item.PlannedRange) == "" || len(item.Purpose) > 4000 || len(item.PlannedRange) > 2000 || len(item.DependsOn) > 100) {
			return nil, BadAuthRequest("每项资产需要剧情功能 purpose、计划篇章或集段 plannedRange；精确 episodes 未定时可以留空")
		}
		seen[item.Key] = true
		episodes := map[int]bool{}
		for _, episode := range item.Episodes {
			if episode < 1 || episode > int(count) || episodes[episode] {
				return nil, BadAuthRequest("预计出场集数重复或超出计划集数")
			}
			episodes[episode] = true
		}
		found := false
		for i, prior := range next.Assets {
			if prior.Key == item.Key {
				item.Identity = prior.Identity
				item.GroupKind = prior.GroupKind
				if (m.Plan.Version < 2 && productionHash(prior) != productionHash(item)) || prior.Kind != item.Kind || prior.Name != item.Name {
					return nil, BadAuthRequest("已登记资产不允许更换身份或出场范围，请保留原清单并在文稿中说明修订")
				}
				next.Assets[i], found = item, true
			} else if strings.EqualFold(strings.TrimSpace(prior.Name), strings.TrimSpace(item.Name)) {
				return nil, BadAuthRequest("同名资产应复用原 key")
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
				job, jobErr := repo.ProductionAgentJob(run.UserID, run.ID)
				if jobErr != nil {
					return nil, jobErr
				}
				if item.Identity == nil {
					item.Identity, err = newProductionAssetIdentity(repo, run, job.CanvasID, item.Kind)
				}
				if err != nil {
					return nil, err
				}
			}
			next.Assets = append(next.Assets, item)
		}
		delete(next.Absent, item.Kind)
	}
	for _, item := range next.Assets {
		delete(next.Absent, item.Kind)
	}
	next.StoryHash = input.StoryHash
	if m.Plan.Version >= 2 {
		next.Complete = input.Complete
		if next.Complete {
			if err := productionValidatePlanInventory(next); err != nil {
				return nil, err
			}
		}
		if m.Plan.Complete && m.Plan.StoryHash == input.StoryHash {
			if productionPlanInventoryHash(*m.Plan) != productionPlanInventoryHash(next) {
				return nil, BadAuthRequest("本版资产清单已完成登记，不能在详情生成中扩大或改变范围；请创建新方案版本")
			}
			next.Complete = true
		}
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
		index = append(index, map[string]any{"key": asset.Key, "name": asset.Name, "kind": asset.Kind, "identity": asset.Identity, "purpose": asset.Purpose, "plannedRange": asset.PlannedRange, "dependsOn": asset.DependsOn})
	}
	context["registeredAssets"] = index
	if m.Plan.Version >= 2 {
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
