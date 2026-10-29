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
	lines := []string{"| 编码 | 中文名称 | 类别 | 主次序号 | 剧情功能 | 计划篇章/集段 | 已登记集数 | 设计前置 | 关联主体 |", "|---|---|---|---:|---|---|---|---|---|"}
	for _, item := range orderedAssets {
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
		lines = append(lines, fmt.Sprintf("| %s | %s | %s | %s | %s | %s | %s | %s | %s |", cell(productionInventoryCode(item)), cell(item.Name), cell(productionPlanGroupLabels[item.Kind]), cell(priority), cell(item.Purpose), cell(plannedRange), cell(productionInventoryEpisodes(item.Episodes)), cell(strings.Join(dependencies, "；")), cell(strings.Join(subjects, "；"))))
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
	return productionRenderPlanDocument("inventory", "", map[string]string{
		"facts":         fmt.Sprintf("当前总纲版本：%s\n\n已登记 %d 项：%s。", plan.StoryHash, len(plan.Assets), strings.Join(summary, "；")),
		"design":        strings.Join(lines, "\n"),
		"continuity":    "编码由系统按所属剧、类别和顺序号分配；引用使用 @编码，身份关联使用内部 ID。重试和修订复用原编码。只有需要独立参考图或独立资产码的重大形态、结构或身份变化使用所属资产的变体编码；服装、妆造、伤势、污渍、光照、持物和开合等普通变化写入连续性，不另造人物身份或变体。声音引用已登记主体，人物声线以人物档案为准。计划篇章与精确集数分别保留，未细化时不编造；二者冲突须根据总纲核对，计划出场不等同正文证据。后续新增资产须明确补录，不扫描全库重编。",
		"uncertainties": strings.Join(absent, "\n\n"),
	})
}
