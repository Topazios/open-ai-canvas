package app

import (
	"strings"
	"testing"
)

func TestVideoNoSubtitlePolicyAppendsOnce(t *testing.T) {
	once := withVideoNoSubtitlePolicy("make it move")
	if !strings.HasPrefix(once, "make it move") || !strings.Contains(once, videoNoSubtitleClause) {
		t.Fatalf("prompt = %q, want original text plus clause", once)
	}
	if twice := withVideoNoSubtitlePolicy(once); twice != once {
		t.Fatalf("clause appended twice: %q", twice)
	}
	if empty := withVideoNoSubtitlePolicy("  "); empty != "" {
		t.Fatalf("empty prompt = %q, want empty", empty)
	}
}

func TestStoryboardVideoPromptForbidsSubtitles(t *testing.T) {
	prompt := storyboardVideoPrompt(productionShot{ID: "S1", Duration: 4, Visual: "v", Camera: "c", Dialogue: "你好"})
	if strings.Count(prompt, videoNoSubtitleClause) != 1 {
		t.Fatalf("prompt = %q, want exactly one no-subtitle clause", prompt)
	}
	row := map[string]any{}
	applyStoryboardCraftFields(row, productionShot{})
	if !strings.Contains(row["negativePrompt"].(string), "字幕") {
		t.Fatalf("negativePrompt = %v", row["negativePrompt"])
	}
}