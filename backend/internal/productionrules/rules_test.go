package productionrules

import (
	"strings"
	"testing"
)

func TestApplyPreservesContentAndSpeech(t *testing.T) {
	const original = "台词原文\n  不改动空格和换行。\n"
	for _, stage := range []string{"story", "assets", "storyboard", "voice", "video", "edit", "review", "delivery"} {
		for _, mode := range []string{"text", "image", "video", "audio"} {
			result := Apply(original, stage, mode)
			if Apply(result, stage, mode) != result || !strings.HasSuffix(result, original) {
				t.Fatalf("%s/%s: content changed or duplicate rules", stage, mode)
			}
			if mode == "audio" {
				if result != original {
					t.Fatal("speech body was changed")
				}
			} else if !strings.HasPrefix(result, Block(stage, mode)+"\n\n") || strings.Count(result, "【制作执行规范 v") != 1 {
				t.Fatalf("%s/%s: missing or duplicate rules", stage, mode)
			}
		}
	}
}

func TestUnknownScopeIsNotRewritten(t *testing.T) {
	for _, scope := range [][2]string{{"", "text"}, {"ordinary", "image"}, {"story", "unknown"}} {
		if Block(scope[0], scope[1]) != "" || Apply("original", scope[0], scope[1]) != "original" {
			t.Fatalf("unknown scope changed: %v", scope)
		}
	}
}
