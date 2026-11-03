package app

import (
	"sort"
	"strings"
)

const storyboardAssetInstruction = "assetIds 从 availableAssets 里选，填本镜实际出现的资产编码；必须包含本镜所在场景的 SCN 编码，同一场次的镜头保持一致；清单里没有对应资产时留空，不要编造新编码。"

var storyboardAssetKindOrder = map[string]int{"environment": 0, "character": 1, "prop": 2, "special": 3, "sound": 4}

// storyboardAssetCatalog lists the registered assets of the body's pipeline
// that apply to the current episode, scenes first. Placeholder nodes without
// an assigned code are skipped, so a shot only receives codes that can resolve.
func storyboardAssetCatalog(m productionManifest, doc map[string]any) []map[string]any {
	pipelineID, episode := "", 0
	for _, src := range m.Sources {
		if src.Step != "story.body" {
			continue
		}
		pipelineID = stringValue(productionWorkflow(productionNode(doc, src.NodeID))["pipelineId"])
		episode = src.Episode
		break
	}
	if pipelineID == "" {
		return nil
	}
	type entry struct {
		code, name, kind string
	}
	entries := []entry{}
	seen := map[string]bool{}
	for _, node := range creationMaps(doc["nodes"]) {
		wd := productionWorkflow(node)
		if wd == nil || stringValue(wd["pipelineId"]) != pipelineID {
			continue
		}
		plan, _ := wd["planAsset"].(map[string]any)
		identity, _ := wd["assetIdentity"].(map[string]any)
		if plan == nil || identity == nil {
			continue
		}
		code := strings.TrimSpace(stringValue(identity["code"]))
		if code == "" || seen[code] {
			continue
		}
		if episodes, _ := plan["episodes"].([]any); episode > 0 && len(episodes) > 0 {
			applies := false
			for _, item := range episodes {
				if number, ok := item.(float64); ok && int(number) == episode {
					applies = true
				}
			}
			if !applies {
				continue
			}
		}
		kind := stringValue(plan["kind"])
		if kind == "" {
			kind = stringValue(identity["kind"])
		}
		seen[code] = true
		entries = append(entries, entry{code: code, name: stringValue(plan["name"]), kind: kind})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		a, aok := storyboardAssetKindOrder[entries[i].kind]
		b, bok := storyboardAssetKindOrder[entries[j].kind]
		if !aok {
			a = len(storyboardAssetKindOrder)
		}
		if !bok {
			b = len(storyboardAssetKindOrder)
		}
		return a < b
	})
	items := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		items = append(items, map[string]any{"code": e.code, "name": e.name, "kind": e.kind})
	}
	return items
}

func storyboardAttachAssets(context map[string]any, m productionManifest, doc map[string]any) {
	if assets := storyboardAssetCatalog(m, doc); len(assets) > 0 {
		context["availableAssets"] = assets
		context["assetInstruction"] = storyboardAssetInstruction
	}
}

// storyboardSceneAssetCode returns the scene code that the shots of one
// scene agree on, or "" when there is none or the shots name several.
func storyboardSceneAssetCode(shots []productionShot) string {
	code := ""
	for _, shot := range shots {
		for _, item := range shot.AssetIDs {
			if !strings.HasPrefix(item, "SCN-") {
				continue
			}
			if code != "" && code != item {
				return ""
			}
			code = item
		}
	}
	return code
}

func storyboardHasSceneCode(codes []string) bool {
	for _, code := range codes {
		if strings.HasPrefix(code, "SCN-") {
			return true
		}
	}
	return false
}
