// Package productionrules owns the shared film-production instruction catalog.
package productionrules

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

const Version = 1

//go:embed rules.json
var catalogJSON []byte

var catalog = func() struct {
	Version int                 `json:"version"`
	Common  []string            `json:"common"`
	Stages  map[string][]string `json:"stages"`
	Media   map[string][]string `json:"media"`
} {
	var value struct {
		Version int                 `json:"version"`
		Common  []string            `json:"common"`
		Stages  map[string][]string `json:"stages"`
		Media   map[string][]string `json:"media"`
	}
	if err := json.Unmarshal(catalogJSON, &value); err != nil {
		panic(err)
	}
	if value.Version != Version {
		panic("production rule catalog version mismatch")
	}
	return value
}()

func ValidStage(stage string) bool { return len(catalog.Stages[stage]) > 0 }

func Block(stage, mode string) string {
	if !ValidStage(stage) || len(catalog.Media[mode]) == 0 {
		return ""
	}
	lines := []string{fmt.Sprintf("【制作执行规范 v%d · %s/%s】", Version, stage, mode)}
	lines = append(lines, catalog.Common...)
	lines = append(lines, catalog.Stages[stage]...)
	lines = append(lines, catalog.Media[mode]...)
	return strings.Join(append(lines, "【制作执行规范结束】"), "\n")
}

func Apply(prompt, stage, mode string) string {
	// Speech text is content, never an instruction carrier.
	if mode == "audio" {
		return prompt
	}
	block := Block(stage, mode)
	if block == "" || strings.HasPrefix(prompt, block+"\n\n") {
		return prompt
	}
	return block + "\n\n" + prompt
}
