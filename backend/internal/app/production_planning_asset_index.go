package app

import "strings"

type productionPlanningAssetIndex struct {
	byKey  map[string]productionPlanningAsset
	labels map[string]map[string]bool
}

func productionPlanningLabel(kind, name string) string {
	return kind + ":" + strings.ToLower(strings.Join(strings.Fields(name), ""))
}

func productionPlanningSameContext(a, b productionPlanningAsset) bool {
	return a.Kind == b.Kind && a.BaseKey == b.BaseKey && a.StateName == b.StateName && a.ParentKey == b.ParentKey
}

func newProductionPlanningAssetIndex(assets []productionPlanningAsset) *productionPlanningAssetIndex {
	index := &productionPlanningAssetIndex{byKey: map[string]productionPlanningAsset{}, labels: map[string]map[string]bool{}}
	for _, asset := range assets {
		index.add(asset)
	}
	return index
}

func (index *productionPlanningAssetIndex) add(asset productionPlanningAsset) {
	index.byKey[asset.Key] = asset
	for _, name := range append([]string{asset.Name}, asset.Aliases...) {
		label := productionPlanningLabel(asset.Kind, name)
		if index.labels[label] == nil {
			index.labels[label] = map[string]bool{}
		}
		index.labels[label][asset.Key] = true
	}
}

func (index *productionPlanningAssetIndex) match(asset productionPlanningAsset) (productionPlanningAsset, bool) {
	// Shared generic aliases are not proof. Match a primary name against the
	// index, or an explicit incoming alias against an existing primary name.
	keys := map[string]bool{}
	for key := range index.labels[productionPlanningLabel(asset.Kind, asset.Name)] {
		keys[key] = true
	}
	for _, alias := range asset.Aliases {
		for key := range index.labels[productionPlanningLabel(asset.Kind, alias)] {
			prior := index.byKey[key]
			if productionPlanningLabel(prior.Kind, prior.Name) == productionPlanningLabel(asset.Kind, alias) {
				keys[key] = true
			}
		}
	}
	if len(keys) != 1 {
		return productionPlanningAsset{}, false
	}
	for key := range keys {
		prior := index.byKey[key]
		if !productionPlanningSameContext(prior, asset) {
			return productionPlanningAsset{}, false
		}
		return prior, true
	}
	return productionPlanningAsset{}, false
}

func productionPlanningRedirectKeys(keys []string, redirects map[string]string) []string {
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		if canonical := redirects[key]; canonical != "" {
			key = canonical
		}
		result = append(result, key)
	}
	return productionFlowUnique(result)
}

func productionValidatePlanningLinks(assets []productionPlanAsset) error {
	known := make(map[string]productionPlanAsset, len(assets))
	for _, asset := range assets {
		if asset.Quantity < 0 {
			return cloudAgentFieldError("assets."+asset.Key, "asset_quantity", "实物数量不能为负数")
		}
		known[asset.Key] = asset
	}
	for _, asset := range assets {
		for _, key := range append(append(append([]string{}, asset.SubjectKeys...), asset.DependsOn...), asset.ParentKey, asset.BaseKey) {
			if key == "" {
				continue
			}
			if _, ok := known[key]; !ok || key == asset.Key {
				return cloudAgentFieldError("assets."+asset.Key, "asset_link", "资产关联不存在或引用自身："+key)
			}
		}
		if (asset.BaseKey == "") != (asset.StateName == "") {
			return cloudAgentFieldError("assets."+asset.Key, "asset_state", "重大形态需要基础资产及形态名称")
		}
		if base, exists := known[asset.BaseKey]; exists && (base.Kind != asset.Kind || base.BaseKey != "") {
			return cloudAgentFieldError("assets."+asset.Key, "asset_state", "重大形态只能继承同类基础资产")
		}
	}
	// Only production prerequisites and containment form directed graphs.
	// Subject associations may legitimately point both ways.
	for _, dependency := range []bool{false, true} {
		state := map[string]int{}
		var visit func(string) bool
		visit = func(key string) bool {
			if state[key] == 1 {
				return false
			}
			if state[key] == 2 {
				return true
			}
			state[key] = 1
			asset := known[key]
			links := asset.DependsOn
			if !dependency {
				links = []string{asset.ParentKey}
			}
			for _, target := range links {
				if target != "" && !visit(target) {
					return false
				}
			}
			state[key] = 2
			return true
		}
		for key := range known {
			if !visit(key) {
				return cloudAgentFieldError("assets."+key, "asset_cycle", "资产归属或设计前置形成循环，请仅保留实际的单向关系")
			}
		}
	}
	return nil
}
