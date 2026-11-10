package app

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Specifications live in the existing visual field, so field-level repair can
// complete a design without regenerating unrelated biography or plot sections.
const productionAssetSpecificationPolicy = "规格必须在本次资产设计完成，不留待定、未知、待测量。优先保留原文明确值；缺少的按时代、身份、体型和剧情合理设计，标明制作设定（非实测），不得冒充原文事实。用两列表格逐行写字段和值，数值带单位；同一基准状态只保留一组规格。年龄/形态变体另列规格并标明适用阶段，不与基准混写。确实不适用的单项写不适用并说明实体原因，不能以原文未提供为由免填。后续提示词和各视图直接引用这组值，不得重新估算。"

var productionSpecificationLength = regexp.MustCompile(`(?:^|[^0-9.\-])[0-9]+(?:\.[0-9]+)?\s*(?:毫米|厘米|千米|米|mm|cm|km|m)(?:[^a-zA-Z0-9²³]|$)`)
var productionSpecificationMass = regexp.MustCompile(`(?:^|[^0-9.\-])[0-9]+(?:\.[0-9]+)?\s*(?:千克|公斤|克|kg|g|斤)(?:[^a-zA-Z0-9]|$)`)
var productionSpecificationAge = regexp.MustCompile(`[0-9]+(?:\.[0-9]+)?\s*(?:岁|年|个月|月)`)
var productionSpecificationCoordinateUnit = regexp.MustCompile(`(?i)(?:单位\s*[:：为]?\s*(?:mm|cm|m|毫米|厘米|米)|(?:mm|cm|m|毫米|厘米|米)\s*(?:为单位|制))`)
var productionSpecificationPlaceholder = regexp.MustCompile(`待定|待测量|待补充|待设计|未知|未确定|TBD|TODO`)
var productionSpecificationReason = regexp.MustCompile(`不适用\s*[:：，,（(\-]?\s*\S{2,}`)
var productionSpecificationTriple = regexp.MustCompile(`[-+]?\d+(?:\.\d+)?\s*[,，、]\s*[-+]?\d+(?:\.\d+)?\s*[,，、]\s*[-+]?\d+(?:\.\d+)?`)
var productionSpecificationLabelNote = regexp.MustCompile(`\s*[（(][^）)]*[）)]\s*$`)
var productionSpecificationSignedNumber = regexp.MustCompile(`[-+]?\d+(?:\.\d+)?`)

func productionSpecificationValue(body string, labels ...string) string {
	for _, raw := range strings.Split(strings.NewReplacer("**", "", "`", "").Replace(body), "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "|") {
			cells := strings.Split(strings.Trim(line, "| "), "|")
			if len(cells) >= 2 {
				for _, label := range labels {
					if productionSpecificationLabelNote.ReplaceAllString(strings.TrimSpace(cells[0]), "") == label {
						return strings.TrimSpace(cells[1])
					}
				}
			}
		}
		for _, segment := range strings.FieldsFunc(line, func(r rune) bool { return r == '；' || r == ';' }) {
			segment = strings.TrimLeft(strings.TrimSpace(segment), "-+* ")
			for _, label := range labels {
				for _, separator := range []string{"：", ":"} {
					parts := strings.SplitN(segment, separator, 2)
					if len(parts) == 2 && productionSpecificationLabelNote.ReplaceAllString(strings.TrimSpace(parts[0]), "") == label {
						value := parts[1]
						return strings.TrimSpace(value)
					}
				}
			}
		}
	}
	return ""
}

func productionValidateAssetSpecification(kind, field, body string) error {
	if !((kind == "character" || kind == "prop") && field == "appearance" || kind == "environment" && field == "layout") {
		return nil
	}
	var missing []string
	require := func(label string, numeric bool, aliases ...string) {
		value := productionSpecificationValue(body, append([]string{label}, aliases...)...)
		valid := value != "" && !productionSpecificationPlaceholder.MatchString(value)
		if valid && numeric && !productionSpecificationReason.MatchString(value) {
			pattern := productionSpecificationLength
			if label == "年龄" {
				pattern = productionSpecificationAge
			} else if label == "体重" || label == "重量" {
				pattern = productionSpecificationMass
			}
			valid = pattern.MatchString(value)
			if valid {
				measure, err := strconv.ParseFloat(productionSpecificationSignedNumber.FindString(value), 64)
				valid = err == nil && !math.IsInf(measure, 0) && (measure > 0 || label == "年龄" && measure == 0)
			}
		}
		if !valid {
			missing = append(missing, label)
		}
	}
	if kind == "character" {
		require("年龄", true, "基准年龄")
		require("身高", true, "净身高")
		require("体重", true)
		require("肩宽", true)
		require("基准姿态", false)
	} else {
		// A combined row is allowed, but it must contain all three dimensions.
		combined := productionSpecificationValue(body, "长宽高", "长×宽×高", "外形尺寸", "空间尺寸")
		combinedValid := len(productionSpecificationSignedNumber.FindAllString(combined, -1)) == 3 && productionSpecificationLength.MatchString(combined) && !productionSpecificationPlaceholder.MatchString(combined)
		for _, raw := range productionSpecificationSignedNumber.FindAllString(combined, -1) {
			number, err := strconv.ParseFloat(raw, 64)
			combinedValid = combinedValid && err == nil && number > 0 && !math.IsInf(number, 0)
		}
		if !combinedValid {
			require("长", true, "长度")
			require("宽", true, "宽度")
			require("高", true, "高度", "净高")
		}
		if kind == "environment" {
			require("固定锚点", false, "固定陈设坐标")
			anchors := productionSpecificationValue(body, "固定锚点", "固定陈设坐标")
			if anchors != "" && !productionSpecificationTriple.MatchString(anchors) {
				missing = append(missing, "固定锚点的三维坐标")
			}
			require("通行约束", false)
		} else {
			require("重量", true)
			require("交互锚点", false)
			anchor := productionSpecificationValue(body, "交互锚点")
			if anchor != "" && !productionSpecificationTriple.MatchString(anchor) {
				missing = append(missing, "交互锚点的局部三维坐标")
			}
		}
	}
	coordinate := productionSpecificationValue(body, "坐标基准", "局部坐标", "坐标系")
	if !productionSpecificationTriple.MatchString(coordinate) || !productionSpecificationCoordinateUnit.MatchString(coordinate) || !strings.Contains(strings.ToUpper(coordinate), "X") || !strings.Contains(strings.ToUpper(coordinate), "Y") || !strings.Contains(strings.ToUpper(coordinate), "Z") || productionSpecificationPlaceholder.MatchString(coordinate) {
		missing = append(missing, "坐标基准（原点三维坐标、单位及X/Y/Z方向）")
	}
	if len(missing) == 0 {
		return nil
	}
	return cloudAgentFieldError("document."+field, "incomplete_asset_specification", "只补齐本字段中缺少或含占位的规格："+strings.Join(missing, "、")+"。"+productionAssetSpecificationPolicy+productionAssetFieldRequirements[kind][field])
}
