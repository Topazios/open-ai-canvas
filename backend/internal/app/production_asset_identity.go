package app

import (
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

type productionAssetIdentity struct {
	ID   string `json:"id"`
	Code string `json:"code"`
	Kind string `json:"kind"`
}

var productionAssetPrefixes = map[string]string{"character": "CHR", "environment": "SCN", "prop": "PRP", "special": "SPC", "sound": "AUD"}

func newProductionAssetIdentity(repo *repository.Repository, run *model.CloudAgentExecution, canvasID, kind string) (*productionAssetIdentity, error) {
	prefix := productionAssetPrefixes[kind]
	if prefix == "" {
		return nil, BadAuthRequest("资产类别无效")
	}
	scope := "asset:" + productionHash([]string{run.UserID, canvasID, kind})[:32]
	code, err := repo.ReserveProductionAssetCode(scope, prefix)
	if err != nil {
		return nil, err
	}
	return &productionAssetIdentity{ID: "asset-" + productionHash([]string{run.UserID, canvasID, code})[:32], Code: code, Kind: kind}, nil
}

// Only resolve explicitly declared sources. A similarly named asset elsewhere
// in the canvas must not silently enter this version's prompt or identity.
func productionSourceAsset(m productionManifest, doc map[string]any, key string) *productionAssetIdentity {
	for _, source := range m.Sources {
		wd := productionWorkflow(productionNode(doc, source.NodeID))
		value, _ := wd["assetIdentity"].(map[string]any)
		if value != nil && (value["code"] == strings.TrimPrefix(key, "@") || wd["assetKey"] == key) {
			return &productionAssetIdentity{ID: stringValue(value["id"]), Code: stringValue(value["code"]), Kind: stringValue(value["kind"])}
		}
	}
	return nil
}

func productionCategoryKind(category string) string {
	return map[string]string{"characters": "character", "environments": "environment", "props": "prop", "special": "special", "voices": "sound"}[category]
}

func productionAssetFact(m productionManifest, kind string) bool {
	return m.Category == "bible" || (m.Category == "reconcile" && productionAssetPrefixes[kind] != "") || kind == productionCategoryKind(m.Category)
}
