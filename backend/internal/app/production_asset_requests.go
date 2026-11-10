package app

import "slices"

func productionAssetRequestHash(selection ProductionAssetModelSelection, scope []string, byKind bool) string {
	selection.RequestID = ""
	keys := slices.Clone(scope)
	slices.Sort(keys)
	return productionHash([]any{byKind, slices.Compact(keys), selection})
}

func productionAssetRequestSeen(plan *productionPlan, selection ProductionAssetModelSelection, scope []string, byKind bool) (bool, error) {
	if len(selection.RequestID) > 128 {
		return false, BadAuthRequest("资产请求编码过长")
	}
	if selection.RequestID == "" || plan.AssetRequests[selection.RequestID] == "" {
		return false, nil
	}
	if plan.AssetRequests[selection.RequestID] != productionAssetRequestHash(selection, scope, byKind) {
		return false, productionPlanConflict("同一请求编码对应不同的资产要求，请重新提交")
	}
	return true, nil
}

// Bounded receipts survive restarts without growing the manifest indefinitely.
func productionRecordAssetRequest(plan *productionPlan, selection ProductionAssetModelSelection, scope []string, byKind bool) {
	if selection.RequestID == "" {
		return
	}
	if plan.AssetRequests == nil {
		plan.AssetRequests = map[string]string{}
	}
	if _, exists := plan.AssetRequests[selection.RequestID]; !exists {
		plan.AssetRequestOrder = append(plan.AssetRequestOrder, selection.RequestID)
	}
	plan.AssetRequests[selection.RequestID] = productionAssetRequestHash(selection, scope, byKind)
	for len(plan.AssetRequestOrder) > 32 {
		delete(plan.AssetRequests, plan.AssetRequestOrder[0])
		plan.AssetRequestOrder = plan.AssetRequestOrder[1:]
	}
}
