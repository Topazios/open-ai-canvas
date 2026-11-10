package app

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

func productionInventoryCode(item productionPlanAsset) string {
	if item.Identity != nil && item.Identity.Code != "" {
		return item.Identity.Code
	}
	return item.Key
}

func sortProductionPlanAssets(items []productionPlanAsset) {
	kindOrder := map[string]int{"character": 0, "environment": 1, "prop": 2, "special": 3, "sound": 4}
	sort.SliceStable(items, func(i, j int) bool {
		left, right := items[i], items[j]
		if kindOrder[left.Kind] != kindOrder[right.Kind] {
			return kindOrder[left.Kind] < kindOrder[right.Kind]
		}
		leftPriority, rightPriority := left.Priority, right.Priority
		if leftPriority <= 0 {
			leftPriority = int(^uint(0) >> 1)
		}
		if rightPriority <= 0 {
			rightPriority = int(^uint(0) >> 1)
		}
		if leftPriority != rightPriority {
			return leftPriority < rightPriority
		}
		if left.Identity != nil && right.Identity != nil && left.Identity.Code != right.Identity.Code {
			leftPrefix, leftNumber, leftOK := strings.Cut(left.Identity.Code, "-")
			rightPrefix, rightNumber, rightOK := strings.Cut(right.Identity.Code, "-")
			if leftOK && rightOK && leftPrefix == rightPrefix {
				leftTail := strings.LastIndex(leftNumber, "-")
				rightTail := strings.LastIndex(rightNumber, "-")
				if leftTail == rightTail && leftNumber[:leftTail+1] == rightNumber[:rightTail+1] {
					ln, le := strconv.Atoi(leftNumber[leftTail+1:])
					rn, re := strconv.Atoi(rightNumber[rightTail+1:])
					if le == nil && re == nil && ln != rn {
						return ln < rn
					}
				}
			}
			return left.Identity.Code < right.Identity.Code
		}
		if (left.Identity == nil) != (right.Identity == nil) {
			return left.Identity != nil
		}
		if left.Key != right.Key {
			return left.Key < right.Key
		}
		return left.Name < right.Name
	})
}

func productionInventoryEpisodes(episodes []int) string {
	if len(episodes) == 0 {
		return "未细化到单集（按计划范围）"
	}
	ordered := append([]int{}, episodes...)
	sort.Ints(ordered)
	labels := make([]string, 0, len(ordered))
	for i, episode := range ordered {
		if i == 0 || ordered[i-1] != episode {
			labels = append(labels, strconv.Itoa(episode))
		}
	}
	return "第" + strings.Join(labels, "、") + "集"
}

// Both documents project the same records. The outline shows every identity
// and description; the catalog adds reserved codes and exact episode usage.
func productionPlanningAssetTables(plan productionPlan, catalog bool) []string {
	assets := append([]productionPlanAsset{}, plan.Assets...)
	sortProductionPlanAssets(assets)
	groups := map[string][]productionPlanAsset{}
	for _, asset := range assets {
		groups[asset.Kind] = append(groups[asset.Kind], asset)
	}
	lines := []string{}
	for _, kind := range productionCurrentPlanKinds {
		items := groups[kind]
		lines = append(lines, fmt.Sprintf("### %s（%d项）", productionPlanGroupLabels[kind], len(items)), "")
		if len(items) == 0 {
			lines = append(lines, plan.Absent[kind], "")
			continue
		}
		header := "| 序号 | 名称 | 简介与别名 | 剧情用途 | 必要变体 | 计划范围 |"
		if catalog {
			header = "| 序号 | 编码与名称 | 身份约束与别名 | 剧情用途 | 必要变体 | 使用范围与集数 |"
		}
		lines = append(lines, header, "|---:|---|---|---|---|---|")
		for i, item := range items {
			name, scope := item.Name, item.PlannedRange
			if catalog {
				name = productionInventoryCode(item) + " " + name
				scope += "；" + productionInventoryEpisodes(item.Episodes)
			}
			intro := item.CoreFacts
			if len(item.Aliases) > 0 {
				intro += "；别名：" + strings.Join(item.Aliases, "、")
			}
			cells := []string{strconv.Itoa(i + 1), name, intro, item.Purpose, item.Variants, scope}
			for j := range cells {
				cells[j] = productionEpisodeTableCell(cells[j])
			}
			lines = append(lines, "| "+strings.Join(cells, " | ")+" |")
		}
		lines = append(lines, "")
	}
	return lines
}

// The inventory is a projection of the complete registry, never a model-written
// summary. Keep exact episode selections alongside the broader planned range.
func productionRenderPlanInventory(plan productionPlan) (string, error) {
	cell := func(value string) string { return strings.NewReplacer("|", "\\|", "\n", " ", "\r", " ").Replace(value) }
	orderedAssets := append([]productionPlanAsset{}, plan.Assets...)
	sortProductionPlanAssets(orderedAssets)
	items, counts := map[string]productionPlanAsset{}, map[string]int{}
	for _, item := range orderedAssets {
		items[item.Key], counts[item.Kind] = item, counts[item.Kind]+1
	}
	planning := len(plan.FlowStoryUnits) > 0
	lines := []string{}
	if !planning {
		lines = append(lines, "| 序号 | 编码 | 中文名称 | 类别 | 主次序号 | 剧情功能 | 计划篇章/集段 | 已登记集数 | 设计前置 | 关联主体 |", "|---:|---|---|---|---:|---|---|---|---|---|")
		rowNumbers := map[string]int{}
		for _, item := range orderedAssets {
			rowNumbers[item.Kind]++
			dependencies := []string{}
			for _, key := range item.DependsOn {
				if dependency, exists := items[key]; exists {
					dependencies = append(dependencies, productionInventoryCode(dependency)+"（"+dependency.Name+"）")
				} else {
					dependencies = append(dependencies, key+"（未登记，需补录）")
				}
			}
			if len(dependencies) == 0 {
				dependencies = append(dependencies, "无设计前置")
			}
			subjects := []string{}
			for _, key := range item.SubjectKeys {
				if subject, exists := items[key]; exists {
					subjects = append(subjects, productionInventoryCode(subject)+"（"+subject.Name+"）")
				} else {
					subjects = append(subjects, key+"（未登记，需补录）")
				}
			}
			if len(subjects) == 0 {
				subjects = append(subjects, "未声明关联主体")
			}
			plannedRange := item.PlannedRange
			if plannedRange == "" {
				plannedRange = productionInventoryEpisodes(item.Episodes)
			}
			priority := "未评级（旧清单）"
			if item.Priority > 0 {
				priority = strconv.Itoa(item.Priority)
			}
			lines = append(lines, fmt.Sprintf("| %d | %s | %s | %s | %s | %s | %s | %s | %s | %s |", rowNumbers[item.Kind], cell(productionInventoryCode(item)), cell(item.Name), cell(productionPlanGroupLabels[item.Kind]), cell(priority), cell(item.Purpose), cell(plannedRange), cell(productionInventoryEpisodes(item.Episodes)), cell(strings.Join(dependencies, "；")), cell(strings.Join(subjects, "；"))))
		}
	}
	// Planning assets have short identity constraints rather than repeated
	// per-source evidence. Group them before rendering so category is not a
	// redundant column and each identity appears only once.
	if planning {
		lines = append(lines, productionPlanningAssetTables(plan, true)...)
	}
	if len(plan.InventoryReview) > 0 {
		lines = append(lines, "", "### 总纲需求与登记对照", "| 总纲字段 | 需求 | 原文依据 | 处理 | 所属资产 | 原因 |", "|---|---|---|---|---|---|")
		labels := map[string]string{"asset": "独立登记", "state": "并入状态/组成", "excluded": "不制作"}
		for _, review := range plan.InventoryReview {
			if len(review.Requirements) == 0 {
				lines = append(lines, fmt.Sprintf("| %s | 无独立需求 | — | 无资产需求 | — | %s |", cell(review.Section), cell(review.NoAssetsReason)))
			}
			for _, demand := range review.Requirements {
				asset := "—"
				if item, ok := items[demand.AssetKey]; ok {
					asset = productionInventoryCode(item) + "（" + item.Name + "）"
				}
				lines = append(lines, fmt.Sprintf("| %s | %s | %s | %s | %s | %s |", cell(review.Section), cell(demand.Subject), cell(demand.Quote), cell(labels[demand.Disposition]), cell(asset), cell(demand.Reason)))
			}
		}
	}
	summary, absent := []string{}, []string{}
	for _, kind := range planKinds(productionManifest{Plan: &plan}) {
		summary = append(summary, fmt.Sprintf("%s %d 项", productionPlanGroupLabels[kind], counts[kind]))
		if reason := plan.Absent[kind]; reason != "" {
			absent = append(absent, productionPlanGroupLabels[kind]+"："+reason)
		}
	}
	absent = append(absent, "此表完整展示当前已登记项，不证明总纲中的所有资产已通过语义核对；状态细节、造型转换依据和个人声线由相应规范及独立档案承载，不能视为已生成媒体。")
	status := "待核对，尚未完成，不能作为后续制作的完整清单"
	if plan.Complete {
		status = "已完成来源核对与完整清单校验"
		if planning {
			status = "已从主要与单元资产登记、分集引用汇总，通过分类、身份与引用检查；具体制作细节在后续阶段展开"
		}
	}
	facts := fmt.Sprintf("状态：%s\n\n当前总纲版本：%s\n\n已登记 %d 项：%s。", status, plan.StoryHash, len(plan.Assets), strings.Join(summary, "；"))
	if planning {
		facts += "\n\n登记范围：主要、单元及分集补充的全部基础资产；每项完整列出名称、简介、用途及必要变体。基础身份数不等于变体、设定图或声音文件数量。后续正文新增的制作需求须补录。"
	} else {
		facts += fmt.Sprintf("已保存 %d 节来源核对。", len(plan.InventoryReview))
	}
	return productionRenderPlanDocument("inventory", "", map[string]string{
		"facts":         facts,
		"design":        strings.Join(lines, "\n"),
		"continuity":    "表内序号按类别从1开始；资产编码由系统按所属剧、类别和顺序号分配，同剧历史登记可能使编码出现间隔。引用使用 @编码，身份关联使用内部 ID，不能为了显示连续而重编已有引用。重试和修订复用原编码。只有需要独立参考图或独立资产码的重大形态、结构或身份变化使用所属资产的变体编码；服装、妆造、伤势、污渍、光照、持物和开合等普通变化写入连续性，不另造人物身份或变体。声音引用已登记主体，人物声线以人物档案为准；声音资产数量不包含人物档案内的对白声线。计划篇章与精确集数分别保留，未细化时不编造；二者冲突须根据总纲核对，计划出场不等同正文证据。后续新增资产须明确补录，不扫描全库重编。",
		"uncertainties": strings.Join(absent, "\n\n"),
	})
}
