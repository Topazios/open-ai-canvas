package app

import "testing"

func TestCloudAgentPiResumePromptAvoidsRepeatingOriginalPrompt(t *testing.T) {
	session := `{"type":"session"}` + "\n" +
		`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"生成场景参考图"}]}}` + "\n" +
		`{"type":"message","message":{"role":"assistant","content":"好"}}`
	cases := []struct {
		name, resume, original, session, want string
	}{
		{"explicit resume prompt wins", "继续", "生成场景参考图", session, "继续"},
		{"original already in session", "", "生成场景参考图", session, cloudAgentPiContinuePrompt},
		{"original with surrounding space", "", "  生成场景参考图\n", session, cloudAgentPiContinuePrompt},
		{"new prompt is kept", "", "改成夜景", session, "改成夜景"},
		{"empty original", "", "", session, cloudAgentPiContinuePrompt},
		{"string content", "", "你好", `{"type":"message","message":{"role":"user","content":"你好"}}`, cloudAgentPiContinuePrompt},
		{"assistant text is not a user prompt", "", "好", session, "好"},
	}
	for _, tc := range cases {
		if got := cloudAgentPiResumePrompt(tc.resume, tc.original, tc.session); got != tc.want {
			t.Errorf("%s: got %q want %q", tc.name, got, tc.want)
		}
	}
}
