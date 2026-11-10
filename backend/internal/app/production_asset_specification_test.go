package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func productionAssetSpecificationFixture(kind string) string {
	coordinate := "| 坐标基准 | 底面中心(0,0,0)，单位cm；X向右/Y向前/Z向上 |\n"
	switch kind {
	case "character":
		return "制作设定（非实测）。\n| 字段 | 值 |\n| --- | --- |\n| 年龄 | 28岁 |\n| 身高 | 173cm |\n| 体重 | 62kg |\n| 肩宽 | 42cm |\n| 基准姿态 | 赤足空手自然站立 |\n" + coordinate
	case "environment":
		return "制作设定（非实测）。\n| 长 | 8m |\n| 宽 | 6m |\n| 高 | 3m |\n| 固定锚点 | 门中心(0,2,1)，宽1m、高2m，朝X正向；桌中心(2,2,0.4)，长1.2m、宽0.6m、高0.8m |\n| 通行约束 | 门至桌南侧通道净宽1.2m，无穿插 |\n" + strings.ReplaceAll(coordinate, "单位cm", "单位m")
	case "prop":
		return "制作设定（非实测）。\n| 长宽高 | 12×8×6cm |\n| 重量 | 240g |\n| 交互锚点 | 底面平放，右侧把手握持中心(6,0,3)，单手持握，不遮挡开口 |\n" + coordinate
	}
	return ""
}

func TestProductionAssetSpecificationRequiredBeforeSave(t *testing.T) {
	for _, kind := range []string{"character", "environment", "prop"} {
		t.Run(kind, func(t *testing.T) {
			field := "appearance"
			if kind == "environment" {
				field = "layout"
			}
			good := productionAssetSpecificationFixture(kind)
			section := productionDocumentSection{Key: field}
			if err := productionValidatePlanField("registered-asset", kind, section, good); err != nil {
				t.Fatal(err)
			}
			for _, bad := range []string{"外形清楚，尺寸原文未提供，后续测量。", strings.Replace(good, "(0,0,0)", "待定", 1)} {
				err := productionValidatePlanField("registered-asset", kind, section, bad)
				requireProductionPlanDocumentError(t, err, "document."+field, "incomplete_asset_specification")
				if !strings.Contains(err.Error(), "只补齐本字段") {
					t.Fatal("repair must target the rejected field")
				}
			}
		})
	}
}

func TestProductionAssetSpecificationDoesNotBorrowUnrelatedNumbers(t *testing.T) {
	good := productionAssetSpecificationFixture("character")
	for _, value := range []string{"待测量", "青年", "62kg", "12m²", "-173cm", "不适用"} {
		bad := strings.Replace(good, "173cm", value, 1)
		if err := productionValidateAssetSpecification("character", "appearance", bad); err == nil {
			t.Fatalf("invalid height accepted: %q", value)
		}
	}
	child := strings.Replace(good, "28岁", "8岁", 1)
	// Circumferences are not mandatory, and an entity-specific exemption is allowed.
	child = strings.Replace(child, "62kg", "不适用：无实体投影没有物理质量", 1)
	if err := productionValidateAssetSpecification("character", "appearance", child); err != nil {
		t.Fatal(err)
	}
	if err := productionValidateAssetSpecification("sound", "appearance", "声音无物理尺寸"); err != nil {
		t.Fatal(err)
	}
	if err := productionValidateAssetSpecification("character", "backstory", "幼时身高待考，属于叙事往事"); err != nil {
		t.Fatal(err)
	}
}

func TestProductionAssetSpecificationAcceptsExplicitProseAndCombinedUnits(t *testing.T) {
	body := "长宽高：12×8×6cm；重量：240g；交互锚点：底面放置，右把手(6,0,3)握持\n坐标基准：底面中心(0,0,0)，单位cm，X右/Y前/Z上"
	if err := productionValidateAssetSpecification("prop", "appearance", body); err != nil {
		t.Fatal(err)
	}
	annotated := strings.Replace(productionAssetSpecificationFixture("character"), "| 身高 |", "| 净身高（制作设定） |", 1)
	if err := productionValidateAssetSpecification("character", "appearance", annotated); err != nil {
		t.Fatal(err)
	}
}

func TestProductionAssetSpecificationFieldRepairMatchesPartialAndFinalReceipts(t *testing.T) {
	for _, body := range []string{"身高待测量，青年男子。", productionAssetSpecificationFixture("character")} {
		document := orderedPlanDocument("character-1", "character")
		document["appearance"] = body
		_, finalError := productionRenderPlanDocument("character-1", "character", document)
		raw, _ := json.Marshal(map[string]any{"document": map[string]string{"appearance": body}})
		partialError := productionDocumentRawValidationError(string(raw), "character-1", "character", 1, []string{"appearance"})
		if (finalError == nil) != (partialError == nil) {
			t.Fatalf("partial and final validation disagree: %v / %v", partialError, finalError)
		}
		if partialError != nil {
			requireProductionPlanDocumentError(t, partialError, "document.appearance", "incomplete_asset_specification")
		}
	}
}
