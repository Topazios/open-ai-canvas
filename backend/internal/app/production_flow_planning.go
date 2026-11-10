package app

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/model"
)

const productionPlanningTemplate = "story-planning-v2"
const productionPlanningBatchSize = 8

const productionPlanningAssetGranularity = "登记粒度以独立制作和剧情身份为准，不按总集数凑数量，也不把所有同职业者并成一个人。具名人物、持续参与行动或对白的特定匿名人物单列，已有姓名沿用姓名；群体仅用于不需区分个体的背景或集体行动，不能吸收需要辨认的证人、商户或执行者。场景按有独立布局和行动用途的空间区分；道具按可独立辨认、使用、交接或留存线索的实物区分，不把多件独立道具统写成材料或证据。声音按可独立复用的声源和功能区分，不把整场所有音效打包为一个名字。必要变体仅记需独立设计的明显年龄阶段、重大形态、身份造型或结构变化及适用条件；情绪、普通动作、常规换装、日夜和一般污损留给正文连续性，不冒充独立变体。每个名称配可独立理解的简介、剧情用途和计划范围，不能只有名称或以详见正文代替。"

// A planning asset is an identity, not an appearance occurrence or a finished
// design dossier. Keys are assigned locally and reused by every episode card.
type productionPlanningAsset struct {
	Key          string                 `json:"key,omitempty"`
	Kind         string                 `json:"kind"`
	Name         string                 `json:"name"`
	Aliases      []string               `json:"aliases"`
	Purpose      string                 `json:"purpose"`
	CoreFacts    string                 `json:"coreFacts"`
	PlannedRange string                 `json:"plannedRange"`
	Variants     string                 `json:"variants"`
	SubjectKeys  []string               `json:"subjectKeys,omitempty"`
	DependsOn    []string               `json:"dependsOn,omitempty"`
	ParentKey    string                 `json:"parentKey,omitempty"`
	BaseKey      string                 `json:"baseKey,omitempty"`
	StateName    string                 `json:"stateName,omitempty"`
	Quantity     int                    `json:"quantity,omitempty"`
	Usage        []productionAssetUsage `json:"usage,omitempty"`
}

type productionPlanningCard struct {
	Episode   int                       `json:"episode"`
	Event     string                    `json:"event"`
	Outcome   string                    `json:"outcome"`
	Threads   string                    `json:"threads"`
	AssetKeys []string                  `json:"assetKeys"`
	NewAssets []productionPlanningAsset `json:"newAssets"`
}

type productionPlanningField struct{ Key, Title, Description string }

var productionPlanningGlobalDescriptions = map[string]string{
	"premise":       "全剧唯一的主线与结局摘要：开场事件、主角目标及代价、关键因果转折、最终选择与结局；不逐单元逐集复述，不另立重复剧情章节",
	"worldRules":    "仅写时代地域、身份背景、时间跨度、世界或能力规则、限制与代价，以及明确的未定边界；不重复故事梗概",
	"relationships": "仅写主要人物身份、目标、关系起点与变化原因；简明锁定影响剧情的职业、生活背景、经济条件与实际权力边界，财富、收入、使用权和职务权限不混同；按人物或关系列简表，不写逐集经历，不另写人物弧光复述",
	"foreshadowing": "仅列跨单元的线索、首次埋设阶段、误解或推进、回收阶段及真实含义；不复述全剧与单元剧情",
}

// This definition drives model contracts, validation and reading projections.
var productionPlanningCardFields = []productionPlanningField{
	{"event", "剧情推进", "用一至两句交代本集独有的具体事件、阻力、选择和行动；不复述全剧设定、前集经过或整个单元故事"},
	{"outcome", "结果变化", "用一句交代行动导致的结果、代价或信息与情感变化；只写变化，不重复事件或逐项盘点状态"},
	{"threads", "伏笔衔接", "仅记本集埋设、推进或回收的具体线索及因果衔接；无新线索说明实际承接，终集说明收束；不再概述剧情"},
}

func productionPlanningAssetKey(kind, name string) string {
	return "plan-" + kind + "-" + productionHash([]string{kind, strings.ToLower(strings.Join(strings.Fields(name), " "))})[:16]
}

func productionPlanningObject(properties map[string]any, required []string) map[string]any {
	return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
}

func productionPlanningAssetSchema(kind string) map[string]any {
	p := map[string]any{}
	for field, description := range map[string]string{
		"name":         "单个可独立辨认制作的主体名称，沿用既定姓名；匿名者用稳定的身份称呼，禁止将不同主体泛称为相关人员或所有道具",
		"purpose":      "该主体在本故事中具体承担的行动、线索、关系或声画功能，不能只有推动剧情等空泛标签",
		"coreFacts":    "可独立理解的简短简介：人物写已定身份、职业、生活背景、经济条件及实际权力边界；场景写空间性质、长期使用者与公私/租用属性；物件写实物特征、用途、所有者与取得方式；声音写声源和功能。只保留来源已定信息，未定不捏造金额、产权或履历，不在清单中扩写完整设计档案",
		"plannedRange": "预计使用的故事单元或集段，复用同一主体时注明后续用途，不重复登记新身份",
		"variants":     "仅写必须独立设计的明显年龄阶段、重大形态、身份造型或结构变化及适用阶段；情绪、普通动作、常规换装、日夜与一般污损不是独立变体；没有必要变体写无独立变体",
	} {
		p[field] = map[string]any{"type": "string", "minLength": 1, "description": description}
	}
	p["kind"] = map[string]any{"type": "string", "enum": productionCurrentPlanKinds}
	if kind != "" {
		p["kind"] = map[string]any{"type": "string", "enum": []string{kind}}
	}
	p["aliases"] = map[string]any{"type": "array", "items": map[string]any{"type": "string"}}
	for field, description := range map[string]string{
		"subjectKeys": "关联声源、人物、空间或道具的已登记key，包括场所长期使用者和物件所有者/使用者；具体关系写coreFacts或purpose，不把路过或同场出现当归属。只是关联，不构成生成依赖",
		"dependsOn":   "确实必须先设计的资产key；普通归属、摆放和关联不填此项",
	} {
		p[field] = map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": description}
	}
	for field, description := range map[string]string{
		"parentKey": "所属场景或组成物的已登记key；例如船甲板关联盐船，不重复设计船体",
		"baseKey":   "重大形态所属基础资产的key；修订版、普通服化、湿润、光照不创建形态",
		"stateName": "与baseKey配套的重大形态名称；必须独立制作时填写",
	} {
		p[field] = map[string]any{"type": "string", "description": description}
	}
	p["quantity"] = map[string]any{"type": "integer", "minimum": 1, "description": "同款实物初始数量；数量不等于设计资产数，未涉及数量时可省略"}
	return productionPlanningObject(p, []string{"kind", "name", "aliases", "purpose", "coreFacts", "plannedRange", "variants"})
}

func productionPlanningSchema(unit model.ProductionFlowUnit) map[string]any {
	input := productionFlowInput(unit)
	if unit.Stage == "registry" {
		return productionPlanningObject(map[string]any{
			"assets":       map[string]any{"type": "array", "items": productionPlanningAssetSchema(stringValue(input["kind"]))},
			"absentReason": map[string]any{"type": "string"},
		}, []string{"assets", "absentReason"})
	}
	properties := map[string]any{"episode": map[string]any{"type": "integer", "minimum": input["start"], "maximum": input["end"]}}
	required := []string{"episode"}
	for _, f := range productionPlanningCardFields {
		properties[f.Key] = map[string]any{"type": "string", "minLength": 1, "description": f.Description}
		required = append(required, f.Key)
	}
	var assets []productionPlanningAsset
	_ = decodeFlowValue(input["registry"], &assets)
	keys := make([]string, 0, len(assets))
	for _, a := range assets {
		keys = append(keys, a.Key)
	}
	keySchema := map[string]any{"type": "string"}
	if len(keys) > 0 {
		keySchema["enum"] = keys
	}
	properties["assetKeys"] = map[string]any{"type": "array", "items": keySchema, "description": "仅选择本集实际需要的已有资产key；没有已有资产填[]，必要新身份填newAssets；不重复填写资产全文"}
	properties["newAssets"] = map[string]any{"type": "array", "items": productionPlanningAssetSchema(""), "description": "仅登记主要与本单元资产表尚未覆盖的必要新主体；已有名称或别名必须复用assetKeys；无新增填[]"}
	required = append(required, "assetKeys", "newAssets")
	return productionPlanningObject(map[string]any{"episodes": map[string]any{"type": "array", "items": productionPlanningObject(properties, required)}}, []string{"episodes"})
}

func productionPlanningInstructions(stage string) string {
	switch stage {
	case "registry":
		return productionPlanningAssetGranularity + "scope=core时按当前kind登记全剧主要资产；scope=unit时根据指定arc及全剧约束，一次核对人物、场景、道具、特殊资产、声音五类，补齐本单元必要制作身份，不限主角和核心物件。registry已有主体不重复新增，跨单元复用同一身份；普通服装、表情和损毁程度写variants与连续性，需独立制作的重大形态使用baseKey和stateName关联基础身份，名称增加阶段限定。每项只给名称、别名、简介、用途、范围及必要变体，不扩写经历、服装材质、机位或提示词。普通台词声线归人物，动作声和环境声归sound；可独立制作复用的能力效果归special，触发音归sound。subjectKeys记录关联声源与主体，parentKey记录所属空间或整体，dependsOn只记录必须等待设计完成的前置，不把普通关联写成前置。不输出key或正式资产码。无需新增时assets=[]且absentReason说明五类如何由已有登记覆盖。"
	case "cards":
		return "仅编排start至end每集叙事要点，严格区分三栏：event写本集具体事件和选择，outcome只写造成的变化，threads只记线索与因果衔接。建议每集三栏合计约100至180字，按实际时长与事件复杂度调整，不用凑字数，也不逐栏重复同一事件。遵守本单元起止、全剧结局、相邻单元及总集数，不重写全剧或前情。这里只明确本集必须表达和交代什么，不写完整分集大纲、小说正文、对白、场次或摄影细节。assetKeys必须包含本集实际参与行动的已登记人物、群体、空间、关键操作物件和必要声音；不是只选主角便算覆盖。必要新身份填newAssets，不因没有姓名漏掉配角，也不重复创建registry中的名称或别名。不能编造key，不按每次出场建档。adopted.episodes已保存的集保留，只补缺失或repairIssues要求修改的集。"
	}
	return ""
}

func productionPlanningValidateAsset(a productionPlanningAsset, kind string) string {
	if !cloudAgentContainsString(productionCurrentPlanKinds, a.Kind) || kind != "" && a.Kind != kind {
		return "资产类别不属于当前登记范围"
	}
	if a.Quantity < 0 || (a.BaseKey == "") != (a.StateName == "") {
		return "数量不得为负；重大形态必须同时给出baseKey和stateName，普通修订不创建形态"
	}
	for _, text := range []string{a.Name, a.Purpose, a.CoreFacts, a.PlannedRange, a.Variants} {
		if strings.TrimSpace(text) == "" || productionPlanPlaceholder(text) {
			return "资产需明确名称、剧情用途、身份事实、计划范围与变体说明（无变体说明无即可）"
		}
	}
	return ""
}

func productionPlanningValidate(unit model.ProductionFlowUnit, raw string) (string, []productionFlowIssue) {
	input := productionFlowInput(unit)
	issues := []productionFlowIssue{}
	add := func(target, message string) {
		issues = append(issues, productionFlowIssueAt("schema", "planning_template", target, message))
	}
	normalized := productionFlowNormalizeJSON(raw)
	if !json.Valid([]byte(normalized)) || !strings.HasPrefix(strings.TrimSpace(normalized), "{") {
		if unit.Stage == "cards" {
			if rows := productionFlowCompleteArrayItems(raw, "episodes"); len(rows) > 0 {
				// Adopt only closed, independently validated records. Never infer
				// a missing card, string or trailing object from truncated output.
				return productionPlanningValidate(unit, productionFlowJSON(map[string]any{"episodes": rows}))
			}
		}
		add(unit.Key, "未收到完整对象，已保存成果保留；仅补未完成的模板内容")
		return unit.ResultJSON, issues
	}
	object := productionFlowObject(normalized)
	for key := range object {
		if _, ok := productionPlanningSchema(unit)["properties"].(map[string]any)[key]; !ok {
			add(key, "当前模板未声明此字段，请放回对应字段")
		}
	}
	if unit.Stage == "registry" {
		var assets []productionPlanningAsset
		if json.Unmarshal(object["assets"], &assets) != nil || string(object["assets"]) == "null" {
			add("assets", "资产登记需使用数组")
			return unit.ResultJSON, issues
		}
		seen := map[string]bool{}
		var registered []productionPlanningAsset
		_ = decodeFlowValue(input["registry"], &registered)
		registeredIndex := newProductionPlanningAssetIndex(registered)
		for i := range assets {
			a := &assets[i]
			a.Name = strings.TrimSpace(a.Name)
			if problem := productionPlanningValidateAsset(*a, stringValue(input["kind"])); problem != "" {
				add(fmt.Sprintf("assets[%d]", i), problem)
			}
			a.Key = productionPlanningAssetKey(a.Kind, a.Name)
			if prior, exists := registeredIndex.byKey[a.Key]; exists && !productionPlanningSameContext(prior, *a) {
				add(a.Name, "同名资产的归属或形态不同，请在名称中增加身份或位置限定")
			}
			if existing, ok := registeredIndex.match(*a); ok {
				a.Aliases = productionFlowUnique(append(append(a.Aliases, a.Name), existing.Aliases...))
				a.Key, a.Name, a.CoreFacts = existing.Key, existing.Name, existing.CoreFacts
			}
			if seen[a.Key] {
				add(a.Name, "同类同名身份重复；复用已有项，同名异人需在名称中区分身份")
			}
			seen[a.Key] = true
			registeredIndex.add(*a)
		}
		reason := productionFlowString(object["absentReason"])
		if len(assets) == 0 && strings.TrimSpace(reason) == "" {
			add("absentReason", "无此类资产时需说明与故事相符的原因")
		}
		if len(issues) > 0 {
			return unit.ResultJSON, issues
		}
		return productionFlowJSON(map[string]any{"assets": assets, "absentReason": reason}), nil
	}
	var incoming, prior []productionPlanningCard
	_ = decodeFlowValue(productionFlowValue(unit)["episodes"], &prior)
	if json.Unmarshal(object["episodes"], &incoming) != nil || string(object["episodes"]) == "null" {
		add("episodes", "每集任务卡需使用对象数组")
		return unit.ResultJSON, issues
	}
	known := map[string]productionPlanningAsset{}
	var registry []productionPlanningAsset
	_ = decodeFlowValue(input["registry"], &registry)
	registryIndex := newProductionPlanningAssetIndex(registry)
	for _, a := range registry {
		known[a.Key] = a
	}
	byEpisode, seen := map[int]productionPlanningCard{}, map[int]bool{}
	semanticRepair := false
	var priorIssues []productionFlowIssue
	_ = json.Unmarshal([]byte(unit.IssuesJSON), &priorIssues)
	for _, issue := range priorIssues {
		semanticRepair = semanticRepair || issue.Layer == "semantic"
	}
	for _, c := range prior {
		byEpisode[c.Episode] = c
	}
	start, end := int(numberValue(input["start"], 0)), int(numberValue(input["end"], 0))
	for _, c := range incoming {
		if c.NewAssets == nil {
			c.NewAssets = []productionPlanningAsset{}
		}
		if c.Episode < start || c.Episode > end || seen[c.Episode] {
			add(fmt.Sprint(c.Episode), "集号越界或重复，不覆盖已保存成果")
			continue
		}
		seen[c.Episode] = true
		if _, saved := byEpisode[c.Episode]; saved && !semanticRepair {
			continue
		}
		before := len(issues)
		var fields map[string]any
		_ = decodeFlowValue(c, &fields)
		for _, f := range productionPlanningCardFields {
			if text := strings.TrimSpace(stringValue(fields[f.Key])); text == "" || productionPlanPlaceholder(text) {
				add(fmt.Sprintf("episodes[%d].%s", c.Episode, f.Key), "需交代具体的"+f.Title)
			}
		}
		newKeys := map[string]bool{}
		for i := range c.NewAssets {
			a := &c.NewAssets[i]
			a.Name = strings.TrimSpace(a.Name)
			if a.Aliases == nil {
				a.Aliases = []string{}
			}
			if problem := productionPlanningValidateAsset(*a, ""); problem != "" {
				add(fmt.Sprintf("episodes[%d].newAssets[%d]", c.Episode, i), problem)
			}
			a.Key = productionPlanningAssetKey(a.Kind, a.Name)
			if prior, exists := registryIndex.byKey[a.Key]; exists && !productionPlanningSameContext(prior, *a) {
				add(a.Name, "同名资产的归属或形态不同，请在名称中增加身份或位置限定")
			}
			if existing, ok := registryIndex.match(*a); ok {
				a.Key, a.Name, a.CoreFacts = existing.Key, existing.Name, existing.CoreFacts
			}
			newKeys[a.Key] = true
			c.AssetKeys = append(c.AssetKeys, a.Key)
		}
		for _, key := range c.AssetKeys {
			if _, ok := known[key]; !ok && !newKeys[key] {
				add(fmt.Sprintf("episodes[%d].assetKeys", c.Episode), "引用未登记的资产："+key+"；新增需求请填newAssets")
			}
		}
		c.AssetKeys = productionFlowUnique(c.AssetKeys)
		if len(c.AssetKeys) == 0 {
			add(fmt.Sprintf("episodes[%d].assetKeys", c.Episode), "本集需关联实际叙事主体或必要空间，不能完全无资产")
		}
		if len(issues) == before {
			byEpisode[c.Episode] = c
		}
	}
	ordered := []productionPlanningCard{}
	for n := start; n <= end; n++ {
		if c, ok := byEpisode[n]; ok {
			ordered = append(ordered, c)
		} else {
			add(fmt.Sprint(n), "此集任务卡尚未保存，仅补充此集")
		}
	}
	return productionFlowJSON(map[string]any{"episodes": ordered}), issues
}

func productionPlanningRegistry(units []model.ProductionFlowUnit) ([]productionPlanningAsset, map[string]string) {
	assets, absent := []productionPlanningAsset{}, map[string]string{}
	indexes := map[string]int{}
	for _, u := range units {
		if u.Stage != "registry" || u.Status != "accepted" || productionFlowInput(u)["parentUnitId"] != nil {
			continue
		}
		var rows []productionPlanningAsset
		_ = decodeFlowValue(productionFlowValue(u)["assets"], &rows)
		for _, a := range rows {
			usage := append([]productionAssetUsage{{Range: a.PlannedRange, Purpose: a.Purpose}}, a.Usage...)
			if i, exists := indexes[a.Key]; exists && productionPlanningSameContext(assets[i], a) {
				prior := &assets[i]
				prior.Aliases = productionFlowUnique(append(prior.Aliases, a.Aliases...))
				prior.Usage = append(prior.Usage, usage...)
				prior.SubjectKeys = productionFlowUnique(append(prior.SubjectKeys, a.SubjectKeys...))
				prior.DependsOn = productionFlowUnique(append(prior.DependsOn, a.DependsOn...))
				continue
			}
			a.Usage = usage
			indexes[a.Key] = len(assets)
			assets = append(assets, a)
		}
		if len(rows) == 0 && stringValue(productionFlowInput(u)["kind"]) != "" {
			absent[stringValue(productionFlowInput(u)["kind"])] = stringValue(productionFlowValue(u)["absentReason"])
		}
	}
	return assets, absent
}

func productionPlanningCards(units []model.ProductionFlowUnit) []productionPlanningCard {
	result := []productionPlanningCard{}
	for _, u := range units {
		if u.Stage != "cards" || u.Status != "accepted" || productionFlowInput(u)["parentUnitId"] != nil {
			continue
		}
		var cards []productionPlanningCard
		_ = decodeFlowValue(productionFlowValue(u)["episodes"], &cards)
		result = append(result, cards...)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Episode < result[j].Episode })
	return result
}

// Rebuild assignments from immutable results, never model conversation history.
func productionFlowStoryGraph(g *productionFlowGraph, requirements map[string]any, count int) bool {
	globals := map[string]any{}
	for _, group := range []struct {
		stage, name string
		fields      []string
	}{
		{"foundation", "确定主线、结局与世界规则", productionFlowFields("foundation")},
		{"characters", "确定人物关系与跨单元线索", productionFlowFields("characters")},
	} {
		u, ready := g.add(group.stage, group.stage, group.name, map[string]any{"requirements": requirements, "global": globals, "episodeCount": count, "selectedFields": group.fields})
		if !ready {
			return false
		}
		for key, value := range productionFlowValue(u) {
			globals[key] = value
		}
	}
	u, ready := g.add("arcs", "arcs", "规划故事单元与主线承接", map[string]any{"global": globals, "episodeCount": count})
	if !ready {
		return false
	}
	var arcs []productionFlowArc
	_ = decodeFlowValue(productionFlowValue(u)["arcs"], &arcs)
	registryReady := true
	for _, kind := range productionCurrentPlanKinds {
		_, ok := g.add("registry/"+kind, "registry", "登记全剧主要"+productionPlanGroupLabels[kind], map[string]any{"scope": "core", "global": globals, "arcs": arcs, "kind": kind})
		registryReady = registryReady && ok
	}
	if !registryReady {
		return false
	}
	coreRegistry, _ := productionPlanningRegistry(g.Units)
	complete := true
	for i, arc := range arcs {
		unitRegistry, ok := g.add(fmt.Sprintf("registry/unit/%03d", i+1), "registry", fmt.Sprintf("补齐第%d单元制作资产", i+1), map[string]any{"scope": "unit", "global": globals, "arc": arc, "registry": coreRegistry})
		if !ok {
			complete = false
			continue
		}
		registry, _ := productionPlanningRegistry(append([]model.ProductionFlowUnit{{Stage: "registry", Status: "accepted", ResultJSON: productionFlowJSON(map[string]any{"assets": coreRegistry})}}, unitRegistry))
		var previous, next any
		if i > 0 {
			previous = arcs[i-1]
		}
		if i+1 < len(arcs) {
			next = arcs[i+1]
		}
		for start := arc.Start; start <= arc.End; start += productionPlanningBatchSize {
			end := min(start+productionPlanningBatchSize-1, arc.End)
			_, ok := g.add(fmt.Sprintf("cards/%04d", start), "cards", fmt.Sprintf("编排第%d至%d集任务卡", start, end), map[string]any{"global": globals, "parameters": requirements["parameters"], "arc": arc, "previousArc": previous, "nextArc": next, "registry": registry, "start": start, "end": end, "episodeCount": count})
			complete = complete && ok
		}
	}
	if !complete {
		return false
	}
	return productionPlanningReviews(g, arcs)
}

func productionPlanningReviews(g *productionFlowGraph, arcs []productionFlowArc) bool {
	ready := true
	units := append([]model.ProductionFlowUnit(nil), g.Units...)
	globals := map[string]any{}
	registry := map[string]any{}
	for _, u := range units {
		if productionFlowInput(u)["parentUnitId"] != nil {
			continue
		}
		if u.Stage == "foundation" || u.Stage == "characters" || u.Stage == "arcs" {
			globals[u.Key] = productionFlowValue(u)
		}
		if u.Stage == "registry" {
			registry[u.Key] = productionFlowValue(u)
		}
	}
	sourcesFor := func(start, end int) map[string]any {
		sources := map[string]any{}
		for key, value := range globals {
			sources[key] = value
		}
		for _, u := range units {
			if u.Stage != "registry" || productionFlowInput(u)["parentUnitId"] != nil {
				continue
			}
			var arc productionFlowArc
			input := productionFlowInput(u)
			_ = decodeFlowValue(input["arc"], &arc)
			if input["scope"] != "unit" || arc.End >= start-1 && arc.Start <= end+1 {
				sources[u.Key] = productionFlowValue(u)
			}
		}
		for _, u := range units {
			if u.Stage != "cards" || productionFlowInput(u)["parentUnitId"] != nil {
				continue
			}
			input := productionFlowInput(u)
			if int(numberValue(input["end"], 0)) >= start-1 && int(numberValue(input["start"], 0)) <= end+1 {
				sources[u.Key] = productionFlowValue(u)
			}
		}
		return sources
	}
	for i, arc := range arcs {
		for start := arc.Start; start <= arc.End; start += 16 {
			end := min(start+15, arc.End)
			_, ok := g.add(fmt.Sprintf("review/unit/%03d/%04d", i+1, start), "review", fmt.Sprintf("核对第%d至%d集叙事与资产覆盖", start, end), map[string]any{"sources": sourcesFor(start, end), "arc": arc, "scope": "检查叙事要点与主线结局、相邻单元的明确因果矛盾，并逐集对照资产登记与assetKeys。实际事件已写出的行动配角、群体、地点、关键操作物件及功能声音必须有登记和引用，不能只引用主角掩盖遗漏。明确缺漏属rule_violation，引用目标集的实际事件作为证据，action要求该集补newAssets和引用；已登记的只补assetKeys。不凭猜测扩造角色或未写出的陈设细节；不因省略对白、场次、造型、机位报错，不因数量少报错。"})
			ready = ready && ok
		}
	}
	sources := map[string]any{}
	for key, value := range globals {
		sources[key] = value
	}
	for key, value := range registry {
		sources[key] = value
	}
	versions := map[string]string{}
	for _, u := range units {
		if u.Stage != "cards" || productionFlowInput(u)["parentUnitId"] != nil {
			continue
		}
		var cards []productionPlanningCard
		_ = decodeFlowValue(productionFlowValue(u)["episodes"], &cards)
		projection := []map[string]any{}
		for _, c := range cards {
			projection = append(projection, map[string]any{"episode": c.Episode, "threads": c.Threads, "outcome": c.Outcome, "newAssets": c.NewAssets})
		}
		sources[u.Key] = map[string]any{"episodes": projection}
		versions[u.Key] = productionHash(u.ResultJSON)
	}
	_, ok := g.add("review/mainline", "review", "核对全剧结局、远集伏笔与新增身份", map[string]any{"sources": sources, "sourceVersions": versions, "scope": "对照全剧主线结局、单元走向及各集伏笔和结果变化，检查远集回收矛盾及新增资产与主要、单元登记的身份冲突。跨登记核对同一人物别名、同一空间与其组成部分、同一物件的别称和数量、同一声音的声源与用途；有明确同一主体证据时在目标登记补对方名称为aliases，保留用途差异，由本地索引复用身份。不因同职业、相同外观或功能就合并；不同空间中的同款物件、不同父级组成和基础/重大形态不能误合并。疑似重复但无证据仅advisory；同名异人或同名不同物必须在name中加可辨身份限定。这里不是完整正文，不因索引未展示的细节报缺漏。"})
	return ready && ok
}

// Generated planning already owns an explicit registry. Publishing its index
// needs no extraction, identity agents or re-transcription of source quotes.
func productionPlanningInventory(units []model.ProductionFlowUnit, source string) (productionPlan, error) {
	plan, _, err := productionPlanningInventoryResolved(units, source)
	return plan, err
}

func productionPlanningInventoryResolved(units []model.ProductionFlowUnit, source string) (productionPlan, map[string]string, error) {
	registry, absent := productionPlanningRegistry(units)
	byKey, order := map[string]productionPlanAsset{}, []string{}
	index := newProductionPlanningAssetIndex(nil)
	redirects := map[string]string{}
	var registrationError error
	register := func(a productionPlanningAsset, origin string) {
		if registrationError != nil {
			return
		}
		originalKey := a.Key
		if existing, ok := index.match(a); ok {
			a.Key = existing.Key
		}
		redirects[originalKey] = a.Key
		if prior, exists := byKey[a.Key]; exists {
			if prior.Kind != a.Kind || prior.ParentKey != a.ParentKey || prior.BaseKey != a.BaseKey || prior.StateName != a.StateName {
				registrationError = cloudAgentFieldError("assets."+a.Key, "asset_identity_conflict", "同名资产的类别、归属或形态不同，请在名称中加入主体或位置限定并重新生成唯一key："+a.Name)
				return
			}
			prior.Aliases = productionFlowUnique(append(append(prior.Aliases, a.Name), a.Aliases...))
			prior.Usage = append(prior.Usage, append([]productionAssetUsage{{Range: a.PlannedRange, Purpose: a.Purpose}}, a.Usage...)...)
			prior.SubjectKeys = productionFlowUnique(append(prior.SubjectKeys, a.SubjectKeys...))
			prior.DependsOn = productionFlowUnique(append(prior.DependsOn, a.DependsOn...))
			byKey[a.Key] = prior
			a.Name, a.Aliases = prior.Name, prior.Aliases
			index.add(a)
			return
		}
		order = append(order, a.Key)
		byKey[a.Key] = productionPlanAsset{Key: a.Key, Kind: a.Kind, Name: a.Name, Purpose: a.Purpose, CoreFacts: a.CoreFacts, Aliases: a.Aliases, Variants: a.Variants, PlannedRange: a.PlannedRange, Origin: origin, Episodes: []int{}, DependsOn: a.DependsOn, SubjectKeys: a.SubjectKeys, ParentKey: a.ParentKey, BaseKey: a.BaseKey, StateName: a.StateName, Quantity: a.Quantity, Usage: append([]productionAssetUsage{{Range: a.PlannedRange, Purpose: a.Purpose}}, a.Usage...)}
		index.add(a)
	}
	for _, a := range registry {
		register(a, "主线与单元规划")
	}
	cards := productionPlanningCards(units)
	for _, c := range cards {
		for _, a := range c.NewAssets {
			register(a, fmt.Sprintf("第%d集任务卡补充", c.Episode))
		}
	}
	if registrationError != nil {
		return productionPlan{}, nil, registrationError
	}
	for _, c := range cards {
		for _, key := range c.AssetKeys {
			if canonical := redirects[key]; canonical != "" {
				key = canonical
			}
			a, exists := byKey[key]
			if !exists {
				return productionPlan{}, nil, BadAuthRequest("任务卡引用未登记资产：" + key)
			}
			if !containsProductionEpisode(a.Episodes, c.Episode) {
				a.Episodes = append(a.Episodes, c.Episode)
			}
			byKey[key] = a
		}
	}
	plan := productionPlan{FlowVersion: 1, StoryHash: source, Assets: []productionPlanAsset{}, Absent: absent, Complete: true}
	ranks := map[string]int{}
	for _, key := range order {
		a := byKey[key]
		seenUsage := map[productionAssetUsage]bool{}
		usage := []productionAssetUsage{}
		for _, entry := range a.Usage {
			if !seenUsage[entry] {
				seenUsage[entry] = true
				usage = append(usage, entry)
			}
		}
		a.Usage = usage
		a.SubjectKeys = productionPlanningRedirectKeys(a.SubjectKeys, redirects)
		a.DependsOn = productionPlanningRedirectKeys(a.DependsOn, redirects)
		if canonical := redirects[a.ParentKey]; canonical != "" {
			a.ParentKey = canonical
		}
		if canonical := redirects[a.BaseKey]; canonical != "" {
			a.BaseKey = canonical
		}
		ranks[a.Kind]++
		a.Priority = ranks[a.Kind]
		plan.Assets = append(plan.Assets, a)
		delete(plan.Absent, a.Kind)
	}
	if err := productionValidatePlanningLinks(plan.Assets); err != nil {
		return productionPlan{}, nil, err
	}
	return plan, redirects, nil
}
