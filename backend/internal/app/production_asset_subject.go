package app

import (
	"fmt"
	"regexp"
	"strings"
)

var productionSubjectCode = regexp.MustCompile(`(?:^|[\n；;|])\s*(?:[-*]\s*)?(?:人物|角色|场景|道具|特殊资产|声音|主体|资产)编码\s*[:：|]?\s*(@?(?:CHR|SCN|PRP|SPC|AUD)-D[0-9]+-[0-9]+)`)
var productionSubjectName = regexp.MustCompile(`(?:^|[\n；;|])\s*(?:[-*]\s*)?(?:姓名|主体名称|资产名称)\s*[:：|]?\s*[“「]?([^；;，,。\n|”」]+)`)

// Only the subject declaration is identity evidence. Other sections may name
// family members, adjacent rooms, owners and sound sources legitimately.
func productionValidateAssetSubject(item *productionPlanAsset, facts string) error {
	if item == nil {
		return nil
	}
	var failures []error
	facts = strings.NewReplacer("**", "", "`", "").Replace(facts)
	for _, match := range productionSubjectCode.FindAllStringSubmatch(facts, -1) {
		code := strings.TrimPrefix(match[1], "@")
		if item.Identity != nil && code != item.Identity.Code {
			failures = append(failures, cloudAgentFieldError("document.facts", "subject_identity", fmt.Sprintf("当前主体是%s（%s），正文声明了%s；只修复本资产内容，不能改名接收其他主体的文稿", item.Name, item.Identity.Code, code)))
		}
	}
	for _, match := range productionSubjectName.FindAllStringSubmatch(facts, -1) {
		name := strings.TrimSpace(match[1])
		name, _, _ = strings.Cut(name, "（")
		name, _, _ = strings.Cut(name, "(")
		name = strings.TrimSpace(name)
		if name != item.Name && !cloudAgentContainsString(item.Aliases, name) {
			failures = append(failures, cloudAgentFieldError("document.facts", "subject_identity", "当前主体名称为"+item.Name+"，正文主体名称为"+name+"；关系人物请写入关系或关联字段"))
		}
	}
	return cloudAgentValidationErrors(failures...)
}

func productionAssetSubjectFacts(item *productionPlanAsset, facts string) string {
	if item == nil || item.Identity == nil {
		return facts
	}
	prefix := fmt.Sprintf("资产编码：%s；资产名称：%s；资产类别：%s。", item.Identity.Code, item.Name, item.Kind)
	if strings.HasPrefix(facts, prefix) {
		return facts
	}
	return prefix + "\n\n" + facts
}
