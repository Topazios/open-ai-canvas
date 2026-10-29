package protocol

import (
	"context"
	"testing"
)

func TestOfficialGenerateContentSeparatesThoughtPartsForTextAndAgent(t *testing.T) {
	adapter := officialPackageAdapter(t, "google-gemini-generate-content.yingce-plugin", "gemini-generate-content")
	agent := adapter.(AgentAdapter)
	for _, test := range []struct {
		payload, text string
		tools         int
	}{
		{`{"candidates":[{"content":{"parts":[{"thought":true,"text":"reasoning"},{"text":"answer"},{"text":" continuation"},{"functionCall":{"name":"save","args":{}}}]}}]}`, "answer continuation", 1},
		{`{"candidates":[{"content":{"parts":[{"thought":true,"text":"reasoning"}]}}]}`, "", 0},
	} {
		created, err := adapter.ParseCreate(context.Background(), []byte(test.payload))
		if err != nil || created.Result == nil || created.Result.Text != test.text || created.Result.Reasoning != "reasoning" {
			t.Fatalf("mixed text result: %+v %v", created.Result, err)
		}
		parsed, err := agent.ParseAgent(context.Background(), []byte(test.payload))
		if err != nil || parsed.Text != test.text || parsed.Reasoning != "reasoning" || len(parsed.ToolCalls) != test.tools {
			t.Fatalf("mixed agent result: %+v %v", parsed, err)
		}
	}
}
