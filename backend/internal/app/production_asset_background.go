package app

// Background is shared design context, not a new prerequisite or a semantic
// validator. Keep only direct registry links; never copy every related dossier.
const productionAssetBackgroundPolicy = "人物、场景、道具和声音须符合相同时代地域与生活背景。先沿用总纲及登记简介中的身份、职业、成长经历、经济条件、实际权力与当前处境；财富、收入、可支配资源和职务权限分开，不由头衔自动推导豪宅或奢侈品。将背景落实为可见外观、合身程度、材质工艺、保养磨损、仪表妆发、举止谈吐及空间陈设。区分所有者、使用者、访客、租借和赠与，进入富裕场所不代表本人富有。反差、伪装、落魄或身份变化写明原因与适用阶段，普通换装不新建身份或变体。已定事实不得改写，缺失的必要细节按世界规则补为制作设定并注明来源，不伪称原文事实；不凭职业或阶层推断善恶、智力、卫生或口音。相关资产只提供本项设计依据，不扩写其档案或自动增加生成依赖。"

func productionAssetBackgroundContext(m productionManifest, key string) map[string]any {
	item := productionPlanItem(m, key)
	if item == nil {
		return nil
	}
	linked := map[string]bool{}
	for _, ref := range append(append([]string{}, item.SubjectKeys...), item.ParentKey, item.BaseKey) {
		if ref != "" && ref != key {
			linked[ref] = true
		}
	}
	related := []map[string]any{}
	for _, candidate := range m.Plan.Assets {
		if candidate.Key == key {
			continue
		}
		// A room or possession may declare its user even when the character's
		// record does not carry the reverse link.
		if !linked[candidate.Key] && candidate.ParentKey != key && candidate.BaseKey != key && !cloudAgentContainsString(candidate.SubjectKeys, key) {
			continue
		}
		related = append(related, map[string]any{
			"key": candidate.Key, "kind": candidate.Kind, "name": candidate.Name,
			"coreFacts": candidate.CoreFacts, "purpose": candidate.Purpose,
			"plannedRange": candidate.PlannedRange, "subjectKeys": candidate.SubjectKeys,
			"parentKey": candidate.ParentKey, "baseKey": candidate.BaseKey, "stateName": candidate.StateName,
		})
	}
	return map[string]any{"policy": productionAssetBackgroundPolicy, "relatedAssets": related}
}
