package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const cloudAgentValidationReceiptMaxBytes = 24 * 1024

type cloudAgentValidationIssue struct {
	Field   string `json:"field"`
	Issue   string `json:"issue"`
	Message string `json:"message"`
}

// Keep the first field compatible with existing consumers, while giving the
// next model step every independently checked defect in the rejected proposal.
func cloudAgentValidationIssues(err error) []cloudAgentValidationIssue {
	var field *cloudAgentFieldArgumentError
	if !errors.As(err, &field) {
		return nil
	}
	if len(field.Issues) > 0 {
		return append([]cloudAgentValidationIssue{}, field.Issues...)
	}
	return []cloudAgentValidationIssue{{Field: field.Field, Issue: field.Issue, Message: cloudAgentSafeToolError(err)}}
}

func cloudAgentValidationErrors(failures ...error) error {
	var issues []cloudAgentValidationIssue
	seen := map[cloudAgentValidationIssue]bool{}
	for _, failure := range failures {
		if failure == nil {
			continue
		}
		items := cloudAgentValidationIssues(failure)
		if len(items) == 0 {
			// Permissions, state and infrastructure errors cannot become model
			// argument repairs merely because validation also found a defect.
			return failure
		}
		for _, item := range items {
			if !seen[item] {
				issues, seen[item] = append(issues, item), true
			}
		}
	}
	if len(issues) == 0 {
		return nil
	}
	if len(issues) == 1 {
		return cloudAgentFieldError(issues[0].Field, issues[0].Issue, issues[0].Message)
	}
	// The user-facing summary stays bounded; the tool receipt carries the full
	// structured list, so long reports never collapse to a generic safe error.
	message := fmt.Sprintf("本次提交发现 %d 项未满足要求；请在当前制作项按 validationIssues 一次补齐后重新提交。", len(issues))
	for i, item := range issues {
		if i == 3 {
			break
		}
		item = cloudAgentSafeValidationIssue(item)
		message += " " + truncateRunes(item.Field, 100) + "：" + truncateRunes(item.Message, 150)
	}
	return &cloudAgentFieldArgumentError{
		error: &cloudAgentArgumentError{BadAuthRequest(message)},
		Field: issues[0].Field, Issue: issues[0].Issue, Issues: issues,
	}
}

func cloudAgentValidationReceipt(detail map[string]any, err error) {
	cloudAgentValidationReceiptWithLimit(detail, err, cloudAgentValidationReceiptMaxBytes)
}

// Model context keeps the complete issue set. User-facing events use the
// bounded receipt above so one malformed submission cannot overflow journals.
func cloudAgentValidationModelReceipt(detail map[string]any, err error) {
	cloudAgentValidationReceiptWithLimit(detail, err, 0)
}

func cloudAgentValidationReceiptWithLimit(detail map[string]any, err error, maxBytes int) {
	issues := cloudAgentValidationIssues(err)
	if len(issues) == 0 {
		return
	}
	detail["validationProblemSignature"] = productionHash(productionValidationProblems(issues, ""))
	items := make([]cloudAgentValidationIssue, 0, len(issues))
	encodedBytes := 2 // JSON array brackets.
	for _, issue := range issues {
		item := cloudAgentSafeValidationIssue(issue)
		if maxBytes > 0 {
			encoded, marshalErr := json.Marshal(item)
			if marshalErr != nil {
				continue
			}
			separatorBytes := 0
			if len(items) > 0 {
				separatorBytes = 1
			}
			if encodedBytes+separatorBytes+len(encoded) > maxBytes {
				break
			}
			encodedBytes += separatorBytes + len(encoded)
		}
		items = append(items, item)
	}
	omitted := len(issues) - len(items)
	detail["validationIssues"], detail["validationIssueCount"] = items, len(issues)
	detail["validationIssuesIncluded"], detail["validationIssuesOmitted"] = len(items), omitted
	detail["validationReportComplete"] = omitted == 0
	detail["validationScope"] = "current_submission"
	if omitted == 0 {
		detail["guidance"] = strings.Join([]string{
			"本次提交未通过，validationIssues 已包含当前可检查的完整问题集。下一次模型调用应在当前制作项一次处理全部问题并保留其余有效内容；全部校验通过前不得进入下一步骤。",
			"来源缺失、版本冲突或无法解析的部分必须先解决前置条件；本回执不代表未提供内容已检查，也不代表作品语义完整。",
		}, "")
		return
	}
	detail["guidance"] = fmt.Sprintf("本执行记录按大小保留了 %d/%d 项；完整问题集已保留给当前制作项的下一次模型调用。下一次调用必须一次处理全部问题并保留其余有效内容；全部校验通过前不得进入下一步骤。", len(items), len(issues))
}

func cloudAgentSafeValidationIssue(item cloudAgentValidationIssue) cloudAgentValidationIssue {
	if !cloudAgentSafeUserMessageWithLimit(item.Field, 400) {
		item.Field = "arguments"
	}
	if !cloudAgentSafeUserMessageWithLimit(item.Issue, 120) {
		item.Issue = "invalid_value"
	}
	if !cloudAgentSafeUserMessageWithLimit(item.Message, 1200) {
		item.Message = "该字段不满足当前工具契约，请按 parameters 与当前来源修正。"
	}
	return item
}
