package app

import (
	"fmt"
	"strings"
)

// 拍摄语法契约：把镜头语言结构化，使分镜读起来是可拍的镜头而不是叙事复述。
// 新字段均为可选，缺失时不拦截提交，只回退到 camera 自由文本。
const storyboardCraftPolicy = `
拍摄语法契约：每镜除 camera 外尽量填写 shotSize、cameraAngle、lens、movement、equipment、blocking、transitionIn、transitionOut、cutPoint，用镜头语言写，不复述剧情。需要特殊设计时才写，留空的字段由系统按 camera 与相邻镜头自动补全，已写的内容不会被覆盖。
景别阶梯：大远景交代环境，远景/全景建立空间，中景写动作与关系，近景/特写写情绪与关键物件；相邻镜头景别要有变化理由，同一人物连续镜头避免景别跳跃不足（小于一级）造成的跳切感，除非刻意用跳切。
机位与轴线：同场建立 180 度轴线并写明本镜在轴线哪一侧；对话用正反打或过肩，两人视线方向在相邻镜头保持相反且画面左右不互换；越轴必须有中性镜头、人物移动或明确转场承接。相邻镜头机位夹角不小于 30 度，否则合并或改景别。
运镜：一个镜头只保留一个主运镜（固定/推/拉/摇/移/跟/升降/环绕/手持呼吸），写起点、终点与动机，运镜要服务情绪或信息，不为炫技；设备（三脚架、肩扛手持、稳定器、轨道、摇臂、无人机）只翻译成成片稳定度与运动质感，不写视频模型无法理解的器材型号。
焦段与景深：广角强化空间与压迫，标准焦段近似人眼，中长焦压缩空间并虚化背景，写清焦点落在谁身上以及何时转焦。
人物空间：blocking 写画面左右、前中后景、相对距离、朝向与视线，并与上一镜保持一致或写明变化原因。
转场：transitionIn/transitionOut 选用硬切、动作匹配、视线匹配、声音先行或后留（J/L cut）、叠化、淡入淡出、遮挡转场、跳切之一，并写出叙事动机；同一场内以硬切、动作匹配和视线匹配为主，叠化与淡入淡出留给时间或空间的明显跨越。transitionOut 与下一镜 transitionIn 必须互相呼应。
剪辑节奏：动作镜头短而密，情绪镜头可停留；切点放在动作完成前或视线落定处，并在 cutPoint 写出切走的那一刻。
场次空间基准：场次规划写入 axisSide（轴线侧别）、keyProps（主要道具位置）、scaleBaseline（尺寸比例基准），镜头沿用，不在每镜重复描述外观。`

func storyboardShotCraftLines(shot productionShot) []string {
	lines := []string{}
	appendLine := func(label, value string) {
		if value = strings.TrimSpace(value); value != "" {
			lines = append(lines, label+value)
		}
	}
	frame := strings.TrimSpace(strings.Join(nonEmptyStrings(shot.ShotSize, shot.CameraAngle, shot.Lens), "，"))
	appendLine("机位景别：", frame)
	move := strings.TrimSpace(strings.Join(nonEmptyStrings(shot.Movement, shot.Equipment), "，"))
	appendLine("运镜设备：", move)
	appendLine("人物空间：", shot.Blocking)
	appendLine("入镜转场：", shot.TransitionIn)
	appendLine("出镜转场：", shot.TransitionOut)
	appendLine("剪辑点：", shot.CutPoint)
	return lines
}

func nonEmptyStrings(values ...string) []string {
	out := []string{}
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			out = append(out, strings.TrimSpace(value))
		}
	}
	return out
}

// 分镜行默认负面提示词：禁止画面内出现任何文字类元素，字幕只在后期添加。
const storyboardNegativePrompt = "字幕, 对白文字, 台词条, 标题字, 水印, 台标, Logo, 界面文字, subtitles, captions, on-screen text, watermark"

// 视频提示词分段：镜头语言先于对白声音，缺失的拍摄字段整段省略。
func storyboardVideoPrompt(shot productionShot) string {
	parts := []string{fmt.Sprintf("镜头 %s · %.1f秒", shot.ID, shot.Duration), "画面：" + shot.Visual, "镜头：" + shot.Camera}
	parts = append(parts, storyboardShotCraftLines(shot)...)
	parts = append(parts, "对白："+shot.Dialogue, "声音："+shot.Sound, "衔接："+shot.Continuity)
	return withVideoNoSubtitlePolicy(strings.Join(parts, "\n"))
}

func storyboardImagePrompt(shot productionShot) string {
	prefix := strings.Join(nonEmptyStrings(shot.ShotSize, shot.CameraAngle, shot.Lens), "，")
	text := shot.Visual + "\n" + shot.Camera
	if prefix != "" {
		text = prefix + "\n" + text
	}
	if blocking := strings.TrimSpace(shot.Blocking); blocking != "" {
		text += "\n" + blocking
	}
	return text
}

// 把拍摄字段写入表格行：沿用既有列承载景别、机位视角、运动与站位，新增列保存焦段、设备与转场。
func applyStoryboardCraftFields(row map[string]any, shot productionShot) {
	row["shotSize"] = strings.TrimSpace(shot.ShotSize)
	row["viewerPOV"] = strings.TrimSpace(shot.CameraAngle)
	row["motion"] = strings.Join(nonEmptyStrings(shot.Movement, shot.Equipment), "；")
	row["performanceBlocking"] = strings.TrimSpace(shot.Blocking)
	row["lens"] = strings.TrimSpace(shot.Lens)
	row["transitionIn"] = strings.TrimSpace(shot.TransitionIn)
	row["transitionOut"] = strings.TrimSpace(shot.TransitionOut)
	row["cutPoint"] = strings.TrimSpace(shot.CutPoint)
	row["negativePrompt"] = storyboardNegativePrompt
}

// 拍摄语法一致性检查：只给出警告写入分镜行，不拦截提交，也不触发重做。
func storyboardCraftWarnings(shots []productionShot) []string {
	warnings := []string{}
	for i := 1; i < len(shots); i++ {
		prev, cur := shots[i-1], shots[i]
		if strings.TrimSpace(prev.TransitionOut) == "" && strings.TrimSpace(cur.TransitionIn) == "" && (prev.Visual != "" && cur.Visual != "") {
			warnings = append(warnings, fmt.Sprintf("%s到%s缺少转场设计", prev.ID, cur.ID))
		}
		prevSide, curSide := storyboardAxisSide(prev.CameraAngle+prev.Blocking), storyboardAxisSide(cur.CameraAngle+cur.Blocking)
		if prevSide != "" && curSide != "" && prevSide != curSide && !storyboardMentionsAxisCrossing(prev.TransitionOut+cur.TransitionIn+cur.Continuity+cur.Camera) {
			warnings = append(warnings, fmt.Sprintf("%s到%s轴线侧别由%s变为%s，未写越轴承接", prev.ID, cur.ID, prevSide, curSide))
		}
	}
	return warnings
}

func storyboardAxisSide(text string) string {
	left, right := strings.Contains(text, "轴线左侧"), strings.Contains(text, "轴线右侧")
	switch {
	case left && !right:
		return "左侧"
	case right && !left:
		return "右侧"
	}
	return ""
}

func storyboardMentionsAxisCrossing(text string) bool {
	for _, word := range []string{"越轴", "中性镜头", "跨轴", "换边", "人物移动", "遮挡转场"} {
		if strings.Contains(text, word) {
			return true
		}
	}
	return false
}

// 把本场的警告写入已完成镜头行；没有警告时清除旧值。
func applyStoryboardCraftWarnings(rows []any, shots []productionShot) {
	warning := strings.Join(storyboardCraftWarnings(shots), "；")
	for _, item := range rows {
		row, ok := item.(map[string]any)
		if !ok || row["detailStatus"] != "ready" {
			continue
		}
		if warning == "" {
			delete(row, "craftWarning")
			continue
		}
		row["craftWarning"] = warning
	}
}

// storyboardSceneSpaceContext 把场次级空间基准带入镜头展开上下文，缺失字段不写入。
func storyboardSceneSpaceContext(context map[string]any, scene productionScene) {
	if scene.AxisSide != "" {
		context["sceneAxisSide"] = scene.AxisSide
	}
	if scene.KeyProps != "" {
		context["sceneKeyProps"] = scene.KeyProps
	}
	if scene.ScaleBaseline != "" {
		context["sceneScaleBaseline"] = scene.ScaleBaseline
	}
}
