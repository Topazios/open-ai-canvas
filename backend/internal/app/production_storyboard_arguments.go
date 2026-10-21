package app

import (
	"fmt"
	"sort"
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
		for key := range typed {
			if _, declared := properties[key]; !declared && schema["additionalProperties"] == false {
				return cloudAgentFieldError(path, "unexpected_field", fmt.Sprintf("分镜参数 %s 含有规范外字段，本次未写入；请按参数规范重新提交完整对象，不要仅删除字段后省略其他场次或镜头", path))
			}
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
