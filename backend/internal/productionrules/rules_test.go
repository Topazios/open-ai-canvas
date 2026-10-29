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

func TestAssetImageRulesReplaceOldEnvelopeOnly(t *testing.T) {
	old := "【制作执行规范 v1 · assets/image】\n旧逐集提取与配音规则\n【制作执行规范结束】\n\n"
	body := "资产外观\n  保留用户内容和空格。\n"
	got := Apply(old+old+body, "assets", "image")
	if got != Block("assets", "image")+"\n\n"+body || Apply(got, "assets", "image") != got {
		t.Fatal("old envelope remained, body changed or normalization is not idempotent")
	}
	for _, unrelated := range []string{"逐集", "声线", "配音", "发布", "武器制造"} {
		if strings.Contains(Block("assets", "image"), unrelated) {
			t.Fatalf("unrelated image instruction: %s", unrelated)
		}
	}
	if !strings.Contains(Block("assets", "text"), "逐集") || !strings.Contains(Block("assets", "text"), "声线") {
		t.Fatal("asset text extraction rules changed")
	}
	if Apply(old+body, "voice", "audio") != old+body {
		t.Fatal("audio content changed")
	}
	if !strings.HasSuffix(Apply("用户引文\n"+old+body, "assets", "image"), "用户引文\n"+old+body) {
		t.Fatal("embedded user text rewritten")
	}
}

func TestAssetImageRulesReplacePriorVersionAndKeepHistoricalPropConstraints(t *testing.T) {
	old := "【制作执行规范 v1 · assets/image】\n旧版规则\n【制作执行规范结束】\n\n名称：明代旧炮；炮身长约2米。"
	got := Apply(old, "assets", "image")
	if !strings.HasPrefix(got, Block("assets", "image")+"\n\n") || strings.Contains(got, "旧版规则") {
		t.Fatal("prior asset-image envelope was not replaced")
	}
	for _, required := range []string{"准确保留名称、身份与时代", "必要的整体外形尺寸", "不要把真实历史物件虚称为无功能物件", "静态美术呈现不代表上游审核保证通过"} {
		if !strings.Contains(Block("assets", "image"), required) {
			t.Fatalf("asset-image rule missing %q", required)
		}
	}
	if !strings.HasSuffix(got, "名称：明代旧炮；炮身长约2米。") {
		t.Fatal("historical asset facts or exterior dimensions were changed")
	}
}
