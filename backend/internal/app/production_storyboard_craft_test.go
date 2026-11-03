package app

import (
	"strings"
	"testing"
)

func TestStoryboardCraftFieldsReachRowAndPrompts(t *testing.T) {
	shot := productionShot{ID: "S1-001", Duration: 8, Visual: "伟哥翻开账本", Camera: "【构图基准】中近景", Dialogue: "不加葱", Sound: "锅铲声", Continuity: "切至小满",
		ShotSize: "中近景，胸部以上", CameraAngle: "过肩，轴线左侧", Lens: "中长焦，浅景深焦点在账本", Movement: "缓推，从中景推到近景", Equipment: "稳定器",
		Blocking: "伟哥画左中景，小满画右前景背对镜头", TransitionIn: "声音先行，锅铲声提前入画", TransitionOut: "视线匹配切至底片特写"}
	prompt := storyboardVideoPrompt(shot)
	for _, want := range []string{"机位景别：中近景", "运镜设备：缓推", "人物空间：伟哥画左", "入镜转场：声音先行", "出镜转场：视线匹配"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("video prompt lacks %q:\n%s", want, prompt)
		}
	}
	if !strings.HasPrefix(storyboardImagePrompt(shot), "中近景") {
		t.Fatalf("image prompt should lead with framing: %s", storyboardImagePrompt(shot))
	}
	row := map[string]any{}
	applyStoryboardCraftFields(row, shot)
	if row["shotSize"] != "中近景，胸部以上" || row["viewerPOV"] != "过肩，轴线左侧" || row["transitionOut"] != "视线匹配切至底片特写" || !strings.Contains(row["motion"].(string), "稳定器") {
		t.Fatalf("unexpected row: %#v", row)
	}
}

func TestStoryboardCraftFieldsOptionalForLegacyShots(t *testing.T) {
	shot := productionShot{ID: "S1-001", Duration: 5, Visual: "画面", Camera: "中景", Dialogue: "无", Sound: "静", Continuity: "连续"}
	if strings.Contains(storyboardVideoPrompt(shot), "机位景别") || strings.Contains(storyboardVideoPrompt(shot), "入镜转场") {
		t.Fatal("legacy shot must not emit empty craft lines")
	}
	if storyboardImagePrompt(shot) != "画面\n中景" {
		t.Fatalf("legacy image prompt changed: %q", storyboardImagePrompt(shot))
	}
}

func TestStoryboardCutPointReachesPromptAndRow(t *testing.T) {
	shot := productionShot{ID: "S1-001", Duration: 5, Visual: "画面", Camera: "中景", Dialogue: "无", Sound: "静", Continuity: "连续", CutPoint: "小满抬头的瞬间切走"}
	if !strings.Contains(storyboardVideoPrompt(shot), "剪辑点：小满抬头的瞬间切走") {
		t.Fatalf("video prompt lacks cut point:\n%s", storyboardVideoPrompt(shot))
	}
	row := map[string]any{}
	applyStoryboardCraftFields(row, shot)
	if row["cutPoint"] != "小满抬头的瞬间切走" {
		t.Fatalf("unexpected cutPoint: %#v", row["cutPoint"])
	}
	legacy := productionShot{ID: "S1-002", Duration: 5, Visual: "画面", Camera: "中景", Dialogue: "无", Sound: "静", Continuity: "连续"}
	if strings.Contains(storyboardVideoPrompt(legacy), "剪辑点") {
		t.Fatal("legacy shot must not emit an empty cut point line")
	}
}

func TestStoryboardCraftWarnings(t *testing.T) {
	base := func(id, angle, out, in, cont string) productionShot {
		return productionShot{ID: id, Visual: "画面", CameraAngle: angle, TransitionOut: out, TransitionIn: in, Continuity: cont}
	}
	if got := storyboardCraftWarnings([]productionShot{base("S1-001", "", "", "", "")}); len(got) != 0 {
		t.Fatalf("single shot should not warn: %v", got)
	}
	if got := storyboardCraftWarnings([]productionShot{base("S1-001", "", "", "", ""), base("S1-002", "", "", "", "")}); len(got) != 1 || !strings.Contains(got[0], "缺少转场设计") {
		t.Fatalf("missing transition should warn: %v", got)
	}
	flipped := []productionShot{
		base("S1-001", "轴线左侧", "硬切", "", ""),
		base("S1-002", "轴线右侧", "", "硬切", ""),
	}
	if got := storyboardCraftWarnings(flipped); len(got) != 1 || !strings.Contains(got[0], "轴线侧别") {
		t.Fatalf("axis flip should warn: %v", got)
	}
	flipped[1].Continuity = "中性镜头过渡后越轴"
	if got := storyboardCraftWarnings(flipped); len(got) != 0 {
		t.Fatalf("axis crossing note should clear warning: %v", got)
	}
}

func TestApplyStoryboardCraftWarningsOnlyReadyRows(t *testing.T) {
	shots := []productionShot{{ID: "S1-001", Visual: "画面"}, {ID: "S1-002", Visual: "画面"}}
	ready := map[string]any{"detailStatus": "ready", "craftWarning": "旧警告"}
	planned := map[string]any{"detailStatus": "planned"}
	applyStoryboardCraftWarnings([]any{ready, planned}, shots)
	if text, _ := ready["craftWarning"].(string); !strings.Contains(text, "缺少转场设计") {
		t.Fatalf("ready row should carry warning: %#v", ready)
	}
	if _, ok := planned["craftWarning"]; ok {
		t.Fatalf("planned row must not carry warning: %#v", planned)
	}
	clean := []productionShot{{ID: "S1-001", Visual: "画面", TransitionOut: "硬切"}, {ID: "S1-002", Visual: "画面"}}
	applyStoryboardCraftWarnings([]any{ready}, clean)
	if _, ok := ready["craftWarning"]; ok {
		t.Fatalf("stale warning should be cleared: %#v", ready)
	}
}
func TestStoryboardAutoCraftFillsEmptyFields(t *testing.T) {
	shots := []productionShot{
		{ID: "S1-001", Duration: 5, Visual: "伟哥翻开账本", Camera: "【构图基准】特写\n【机位运动】缓推", Dialogue: "不加葱"},
		{ID: "S1-002", Duration: 5, Visual: "小满抬头", Camera: "过肩，仰拍", Dialogue: "无"},
	}
	got := storyboardAutoCraft(productionScene{AxisSide: "左侧"}, shots)
	if got[0].ShotSize != "特写" || got[0].Movement != "缓推" || got[0].Equipment != "稳定器" || !strings.Contains(got[0].Lens, "浅景深") {
		t.Fatalf("unexpected first shot: %#v", got[0])
	}
	if got[0].CutPoint != "对白说完、视线落定处切走" || got[1].CutPoint != "动作落幅稳定处切走" {
		t.Fatalf("unexpected cut points: %q %q", got[0].CutPoint, got[1].CutPoint)
	}
	if !strings.HasPrefix(got[1].CameraAngle, "过肩") || storyboardAxisSide(got[0].CameraAngle) != "左侧" {
		t.Fatalf("unexpected angles: %q %q", got[0].CameraAngle, got[1].CameraAngle)
	}
	if got[1].Movement != "固定机位" || got[1].Equipment != "三脚架" || got[1].ShotSize != "中景" {
		t.Fatalf("unexpected defaults: %#v", got[1])
	}
}

func TestStoryboardAutoCraftKeepsFilledFieldsAndInput(t *testing.T) {
	shots := []productionShot{
		{ID: "S1-001", Duration: 5, Visual: "画面", Camera: "中景", ShotSize: "大远景", TransitionOut: "视线匹配切"},
		{ID: "S1-002", Duration: 5, Visual: "画面二", Camera: "中景"},
	}
	got := storyboardAutoCraft(productionScene{}, shots)
	if got[0].ShotSize != "大远景" {
		t.Fatalf("filled field overwritten: %q", got[0].ShotSize)
	}
	if shots[0].Lens != "" || shots[1].TransitionIn != "" {
		t.Fatal("input slice must not be modified")
	}
	if got[1].TransitionIn != "视线匹配切" || got[0].TransitionIn != "硬切" || got[1].TransitionOut != "硬切" {
		t.Fatalf("transitions not paired: %q %q %q", got[0].TransitionIn, got[1].TransitionIn, got[1].TransitionOut)
	}
}

func TestStoryboardAutoCraftSkipsPlaceholders(t *testing.T) {
	got := storyboardAutoCraft(productionScene{}, []productionShot{{ID: "S1-001", Duration: 5}})
	if got[0].ShotSize != "" || got[0].TransitionIn != "" || got[0].CutPoint != "" {
		t.Fatalf("placeholder shot must stay empty: %#v", got[0])
	}
}
