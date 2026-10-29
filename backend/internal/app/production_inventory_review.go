package app

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
)

// A source ledger makes inclusion and deliberate reuse reviewable. It proves
// reference coverage, not that a model found every entity in natural language.
type productionInventoryRequirement struct {
	Subject     string `json:"subject"`
	Quote       string `json:"quote"`
	AssetKey    string `json:"assetKey"`
	Disposition string `json:"disposition"`
	Reason      string `json:"reason"`
}

type productionInventorySectionReview struct {
	Section        string                           `json:"section"`
	Requirements   []productionInventoryRequirement `json:"requirements"`
	NoAssetsReason string                           `json:"noAssetsReason"`
	Append         bool                             `json:"append,omitempty"`
}

type productionInventoryRequirementIdentity struct {
	Subject     string
	Quote       string
	AssetKey    string
	Disposition string
	Reason      string
}

const productionInventoryReviewInstruction = "逐节审读总纲并提交 inventoryReview：sourceSectionText 提供各 section 对应的当前原文，sourceSections 列明合法章节 key；episodeArchitecture 按每集单独提供，必须逐集核对，不能只审查总纲摘要。先按剧情事实识别主线、支线、每集行动者/被提及角色、具体地点、实际出现或转移的实体道具、重复声音及规则效果，再将每项判定为独立资产(asset)、并入既有身份/状态(state)或明确不制作(excluded)。每条需求须提供 subject、对应章节不超过300字符的逐字 quote、assetKey、disposition(asset/state/excluded) 和 reason；同一实体跨集复用同一 assetKey，并在总表的 plannedRange/episodes 覆盖所有相关集段。主角/配角/群演/画外人物、实际行动空间、线索/目标/交接/使用的道具都要逐项纳入；不得因名称不是专业道具、只出现一次、未被镜头放大或资产类别优先级低而遗漏。story 中明确出现底片、照片、账本、信件、手机、车辆、工具、门店陈设等实体时，须登记或逐项说明并入哪项资产/为何不制作，不能由“无道具”概括带过。不得把世界规则或普通服化、情绪、伤势误建成独立资产；确需独立参考图/身份码的重大形态另行登记。按工具参数容量在本步骤分批提交，未覆盖全部来源时 complete=false；服务端保存各批核对，最终 complete=true 对所有来源章节和资产映射统一复检，通过后才进入制作规范。已有章节需补充时 append=true，只提交新增 requirements；需替换则 append=false 并提交完整章节。每章节每批最多100项需求，超限分批追加。asset 表示独立登记；state 表示并入既有资产且必须指明所属 assetKey 和不单建原因；excluded 必须说明不是制作需求，assetKey 留空。确无资产需求的章节须列 requirements=[] 并给出与原文相符的 noAssetsReason。不得捏造引文或用类别数量冒充语义完整；每项资产至少有一条有效故事证据映射。声音 subjectKeys 是关联主体，dependsOn 仅是必须先设计的前置；人物声线留在人物档案，不另造声音身份。"

func productionInventoryReviewSources(plan productionPlan, story string) ([]string, map[string]string) {
	schema := productionPlanDocumentSchemaVersion(plan.Version)
	keys, bodies := []string{}, map[string]string{}
	for _, section := range productionPlanDocumentSectionsForSchema("story", "", schema) {
		body := productionPlanSectionBody("story", "", story, section.Key, schema)
		if section.Key == "episodeArchitecture" {
			for _, line := range strings.Split(body, "\n") {
				cells := strings.Split(strings.Trim(strings.ReplaceAll(strings.TrimSpace(line), "｜", "|"), "|"), "|")
				match := productionEpisodeArchitectureID.FindStringSubmatch(strings.TrimSpace(cells[0]))
				if match == nil {
					continue
				}
				var episode int
				fmt.Sscanf(match[1], "%d", &episode)
				key := fmt.Sprintf("episodeArchitecture/EP-%03d", episode)
				keys, bodies[key] = append(keys, key), line
			}
			continue
		}
		keys, bodies[section.Key] = append(keys, section.Key), body
	}
	return keys, bodies
}

func productionMergeInventoryReview(plan *productionPlan, incoming []productionInventorySectionReview) error {
	merged, err := productionPreviewInventoryReview(*plan, incoming)
	if err != nil {
		return err
	}
	plan.InventoryReview = merged
	return nil
}

// A diagnostic preview can inspect unambiguous first occurrences without
// accepting a conflicting batch or mutating its durable checkpoint.
func productionPreviewInventoryReview(plan productionPlan, incoming []productionInventorySectionReview) ([]productionInventorySectionReview, error) {
	merged := append([]productionInventorySectionReview{}, plan.InventoryReview...)
	seen := map[string]bool{}
	var failures []error
	for index, review := range incoming {
		if len(review.Requirements) > 100 {
			failures = append(failures, cloudAgentFieldError(fmt.Sprintf("inventoryReview[%d].requirements", index), "review_size", "单批同一章节最多提交100项需求，请留在资产总表步骤继续追加"))
			continue
		}
		if seen[review.Section] {
			failures = append(failures, cloudAgentFieldError(fmt.Sprintf("inventoryReview[%d].section", index), "duplicate_section", "同批核对章节重复："+truncateRunes(review.Section, 80)))
			continue
		}
		seen[review.Section] = true
		found := false
		for i := range merged {
			if merged[i].Section == review.Section {
				if review.Append {
					if merged[i].NoAssetsReason != "" || review.NoAssetsReason != "" || len(review.Requirements) == 0 {
						failures = append(failures, cloudAgentFieldError(fmt.Sprintf("inventoryReview[%d].append", index), "invalid_append", "追加需求需要已有的非空需求章节，且本批只提交新增 requirements"))
					} else {
						requirements := append([]productionInventoryRequirement{}, merged[i].Requirements...)
						existing := make(map[productionInventoryRequirementIdentity]struct{}, len(requirements)+len(review.Requirements))
						for _, requirement := range requirements {
							existing[productionInventoryRequirementKey(requirement)] = struct{}{}
						}
						for _, requirement := range review.Requirements {
							key := productionInventoryRequirementKey(requirement)
							if _, duplicate := existing[key]; duplicate {
								continue
							}
							existing[key] = struct{}{}
							requirements = append(requirements, requirement)
						}
						merged[i].Requirements = requirements
					}
				} else {
					review.Append = false
					merged[i] = review
				}
				found = true
				break
			}
		}
		if !found {
			if review.Append {
				failures = append(failures, cloudAgentFieldError(fmt.Sprintf("inventoryReview[%d].append", index), "invalid_append", "该章节尚未保存核对记录，请先提交首批需求"))
			} else {
				merged = append(merged, review)
			}
		}
	}
	return merged, cloudAgentValidationErrors(failures...)
}

func productionInventoryRequirementKey(requirement productionInventoryRequirement) productionInventoryRequirementIdentity {
	return productionInventoryRequirementIdentity{
		Subject:     requirement.Subject,
		Quote:       requirement.Quote,
		AssetKey:    requirement.AssetKey,
		Disposition: requirement.Disposition,
		Reason:      requirement.Reason,
	}
}

func productionValidateInventoryReview(plan productionPlan, doc map[string]any, frameID string, rows []model.ProductionAgentArtifact, complete bool) error {
	story := ""
	for _, row := range rows {
		if row.Key == "story" && row.ContentHash == plan.StoryHash {
			node := productionNode(doc, row.NodeID)
			if node == nil || node["parentId"] != frameID || !productionArtifactMatches(node, row.ContentHash) {
				return cloudAgentFieldError("inventoryReview", "source_changed", "总纲已变更，不能复用旧核对记录")
			}
			meta, _ := node["metadata"].(map[string]any)
			story = stringValue(meta["content"])
		}
	}
	if story == "" {
		return cloudAgentFieldError("inventoryReview", "source_missing", "缺少当前已保存总纲，不能核对资产来源")
	}
	sections, bodies := productionInventoryReviewSources(plan, story)
	assets := map[string]productionPlanAsset{}
	for _, item := range plan.Assets {
		assets[item.Key] = item
	}
	covered, reviewed := map[string]bool{}, map[string]bool{}
	var failures []error
	for reviewIndex, review := range plan.InventoryReview {
		path := fmt.Sprintf("inventoryReview[%d]", reviewIndex)
		body, exists := bodies[review.Section]
		sourceExists := exists
		if !exists || reviewed[review.Section] {
			failures = append(failures, cloudAgentFieldError(path+".section", "invalid_section", "核对章节无效或重复："+truncateRunes(review.Section, 80)))
		}
		if exists {
			reviewed[review.Section] = true
		}
		if (len(review.Requirements) == 0 && strings.TrimSpace(review.NoAssetsReason) == "") || (len(review.Requirements) > 0 && strings.TrimSpace(review.NoAssetsReason) != "") {
			failures = append(failures, cloudAgentFieldError(path+".noAssetsReason", "invalid_review", "章节需列需求证据或明确无需求理由，不能同时填写两者："+truncateRunes(review.Section, 80)))
		}
		for demandIndex, demand := range review.Requirements {
			demandPath := fmt.Sprintf("%s.requirements[%d]", path, demandIndex)
			valid := true
			for _, field := range []struct{ key, value string }{{"subject", demand.Subject}, {"reason", demand.Reason}} {
				if strings.TrimSpace(field.value) == "" {
					failures = append(failures, cloudAgentFieldError(demandPath+"."+field.key, "required", "需求的 subject 与 reason 均需非空，说明主体及制作或复用依据"))
					valid = false
				}
			}
			if strings.TrimSpace(demand.Quote) == "" || utf8.RuneCountInString(demand.Quote) > 300 || (exists && !productionInventoryQuoteMatches(body, demand.Quote)) {
				failures = append(failures, cloudAgentFieldError(demandPath+".quote", "invalid_source_quote", truncateRunes(review.Section, 60)+" 的需求 "+truncateRunes(demand.Subject, 60)+"：quote 必须是该 sourceSections 章节中的逐字原文且不超过300字符；保留主体和动作的原意，不改写引文"))
				valid = false
			}
			switch demand.Disposition {
			case "asset", "state":
				if _, exists := assets[demand.AssetKey]; !exists {
					failures = append(failures, cloudAgentFieldError(demandPath+".assetKey", "unregistered_requirement", "需求 "+truncateRunes(demand.Subject, 60)+" 须关联已登记主体，当前 key="+truncateRunes(demand.AssetKey, 60)+"；请补录或明确所属资产，不用未登记的 key"))
				} else if valid && sourceExists {
					covered[demand.AssetKey] = true
				}
			case "excluded":
				if demand.AssetKey != "" {
					failures = append(failures, cloudAgentFieldError(demandPath+".assetKey", "invalid_exclusion", "不制作项不能同时关联资产，请清空 assetKey 并说明排除原因"))
				}
			default:
				failures = append(failures, cloudAgentFieldError(demandPath+".disposition", "invalid_disposition", "disposition 只能为 asset/state/excluded"))
			}
		}
	}
	for assetIndex, item := range plan.Assets {
		for subjectIndex, key := range item.SubjectKeys {
			if _, exists := assets[key]; !exists || key == item.Key {
				failures = append(failures, cloudAgentFieldError(fmt.Sprintf("assets[%d].subjectKeys[%d]", assetIndex, subjectIndex), "unknown_subject", "关联主体未登记或指向自身："+truncateRunes(item.Key, 80)+" → "+truncateRunes(key, 80)))
			}
		}
	}
	if !complete {
		return cloudAgentValidationErrors(failures...)
	}
	for _, section := range sections {
		if !reviewed[section] {
			failures = append(failures, cloudAgentFieldError("inventoryReview."+section, "missing_source_sections", "完成前须逐节核对总纲，尚缺来源章节："+section))
		}
	}
	for assetIndex, item := range plan.Assets {
		if !covered[item.Key] {
			failures = append(failures, cloudAgentFieldError(fmt.Sprintf("assets[%d].key", assetIndex), "missing_asset_source", "资产尚无有效总纲需求证据映射："+truncateRunes(item.Key, 80)+"（"+truncateRunes(item.Name, 80)+"）；先修正关联需求的引文或补充映射，设计补充须说明与原文需求的关系"))
		}
	}
	return cloudAgentValidationErrors(failures...)
}

// Ignore layout-only whitespace while preserving punctuation and all source
// wording. Punctuation can change meaning, so it remains part of a verbatim
// evidence match.
func productionInventoryQuoteMatches(source, quote string) bool {
	normalize := func(value string) string {
		var normalized strings.Builder
		for _, r := range value {
			if unicode.IsSpace(r) || r == '\u200b' || r == '\u2060' || r == '\ufeff' {
				continue
			}
			normalized.WriteRune(r)
		}
		return normalized.String()
	}
	needle := normalize(quote)
	return needle != "" && strings.Contains(normalize(source), needle)
}

func productionInventoryReviewSchema(sourceSectionCount ...int) map[string]any {
	text := func() map[string]any { return map[string]any{"type": "string"} }
	maxItems := 100
	if len(sourceSectionCount) > 0 && sourceSectionCount[0] > 0 {
		maxItems = sourceSectionCount[0]
	}
	return map[string]any{"type": "array", "maxItems": maxItems, "description": productionInventoryReviewInstruction, "items": map[string]any{
		"type": "object", "additionalProperties": false, "required": []string{"section", "requirements", "noAssetsReason"}, "properties": map[string]any{
			"section": text(), "noAssetsReason": text(), "append": map[string]any{"type": "boolean"}, "requirements": map[string]any{"type": "array", "maxItems": 100, "items": map[string]any{
				"type": "object", "additionalProperties": false, "required": []string{"subject", "quote", "assetKey", "disposition", "reason"}, "properties": map[string]any{
					"subject": text(), "quote": map[string]any{"type": "string", "maxLength": 300}, "assetKey": text(), "reason": text(), "disposition": map[string]any{"type": "string", "enum": []string{"asset", "state", "excluded"}},
				},
			}},
		},
	}}
}
