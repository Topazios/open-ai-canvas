package app

import (
	"fmt"
	"sort"
	"strings"
)

// Persisted scenes contain checkpoint fields which are not writable tool inputs.
// Check the advertised contract before decoding into those internal structs.
func validateStoryboardArgumentFields(call cloudAgentCall) error {
	for _, tool := range storyboardTools() {
		function, _ := tool["function"].(map[string]any)
		if function["name"] != call.Function.Name {
			continue
		}
		var value map[string]any
		if err := decodeCloudAgentJSONObject(call.Function.Arguments, &value); err != nil {
			return cloudAgentJSONArgumentError(err)
		}
		schema, _ := function["parameters"].(map[string]any)
		return storyboardArgumentFields(value, schema, "parameters")
	}
	return nil
}

func storyboardArgumentFields(value any, schema map[string]any, path string) error {
	switch typed := value.(type) {
	case map[string]any:
		properties, ok := schema["properties"].(map[string]any)
		if !ok {
			return nil // The typed decoder handles mismatched value types.
		}
		var unexpected []string
		for key := range typed {
			if _, declared := properties[key]; !declared && schema["additionalProperties"] == false {
				// Only name known layout fields; arbitrary model keys may contain secrets.
				switch key {
				case "goal", "entry", "exit", "dependsOn", "taskGroup":
					unexpected = append(unexpected, key)
				default:
					unexpected = append(unexpected, "未声明字段")
				}
			}
		}
		if len(unexpected) > 0 {
			sort.Strings(unexpected)
			return cloudAgentFieldError(path, "unexpected_field", fmt.Sprintf("分镜参数 %s 含有规范外字段（%s），本次未写入；仅按当前分配范围提交，保留规定的完整画面、机位、对白和连续性。规划goal/entry/exit的内容落实到visual及continuity，不要复制规划字段或补写其他工作组", path, strings.Join(unexpected, "、")))
		}
		keys := make([]string, 0, len(properties))
		for key := range properties {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			child, _ := properties[key].(map[string]any)
			if err := storyboardArgumentFields(typed[key], child, path+"."+key); err != nil {
				return err
			}
		}
	case []any:
		child, _ := schema["items"].(map[string]any)
		for index, item := range typed {
			if err := storyboardArgumentFields(item, child, fmt.Sprintf("%s[%d]", path, index)); err != nil {
				return err
			}
		}
	}
	return nil
}
