package app

import "strings"

// 拍摄字段自动补全：模型留空的字段按镜头文本和相邻镜头推导，已填写的不覆盖。
// 只在生成分镜行时作用于副本，不改动已保存的镜头数据，也不参与镜头哈希。
func storyboardAutoCraft(scene productionScene, shots []productionShot) []productionShot {
	out := append([]productionShot{}, shots...)
	for i := range out {
		shot := &out[i]
		if strings.TrimSpace(shot.Visual) == "" {
			continue
		}
		if strings.TrimSpace(shot.ShotSize) == "" {
			shot.ShotSize = storyboardInferShotSize(shot.Camera)
		}
		if strings.TrimSpace(shot.CameraAngle) == "" {
			shot.CameraAngle = storyboardInferAngle(shot.Camera, scene.AxisSide)
		}
		if strings.TrimSpace(shot.Lens) == "" {
			shot.Lens = storyboardInferLens(shot.ShotSize)
		}
		if strings.TrimSpace(shot.Movement) == "" {
			shot.Movement = storyboardInferMovement(shot.Camera)
		}
		if strings.TrimSpace(shot.Equipment) == "" {
			shot.Equipment = storyboardInferEquipment(shot.Movement)
		}
		if strings.TrimSpace(shot.CutPoint) == "" {
			shot.CutPoint = storyboardInferCutPoint(shot.Dialogue)
		}
	}
	// 转场按相邻镜头成对补齐：前镜出场与后镜入场互相呼应，场内默认硬切。
	for i := range out {
		if strings.TrimSpace(out[i].Visual) == "" {
			continue
		}
		if strings.TrimSpace(out[i].TransitionIn) == "" {
			out[i].TransitionIn = "硬切"
			if i > 0 && strings.TrimSpace(out[i-1].TransitionOut) != "" {
				out[i].TransitionIn = out[i-1].TransitionOut
			}
		}
		if strings.TrimSpace(out[i].TransitionOut) == "" {
			out[i].TransitionOut = "硬切"
			if i+1 < len(out) && strings.TrimSpace(out[i+1].TransitionIn) != "" {
				out[i].TransitionOut = out[i+1].TransitionIn
			}
		}
	}
	return out
}

// 取【标签】后到下一个【之前的内容；没有标签时返回全文。
func storyboardCameraSection(camera, label string) string {
	start := strings.Index(camera, "【"+label+"】")
	if start < 0 {
		return camera
	}
	rest := camera[start+len("【"+label+"】"):]
	if end := strings.Index(rest, "【"); end >= 0 {
		rest = rest[:end]
	}
	return rest
}

func storyboardFirstKeyword(text string, words []string) string {
	for _, word := range words {
		if strings.Contains(text, word) {
			return word
		}
	}
	return ""
}

func storyboardInferShotSize(camera string) string {
	text := storyboardCameraSection(camera, "构图基准")
	if size := storyboardFirstKeyword(text, []string{"大特写", "特写", "大远景", "远景", "全景", "中近景", "近景", "中景"}); size != "" {
		return size
	}
	return "中景"
}

func storyboardInferAngle(camera, axisSide string) string {
	angle := "平视"
	switch {
	case strings.Contains(camera, "过肩"):
		angle = "过肩"
	case storyboardFirstKeyword(camera, []string{"俯拍", "俯视", "俯角"}) != "":
		angle = "俯拍"
	case storyboardFirstKeyword(camera, []string{"仰拍", "仰视", "仰角"}) != "":
		angle = "仰拍"
	case strings.Contains(camera, "主观"):
		angle = "主观视角"
	}
	switch {
	case strings.Contains(camera, "轴线左侧"):
		angle += "，轴线左侧"
	case strings.Contains(camera, "轴线右侧"):
		angle += "，轴线右侧"
	case strings.Contains(axisSide, "左") && !strings.Contains(axisSide, "右"):
		angle += "，轴线左侧"
	case strings.Contains(axisSide, "右") && !strings.Contains(axisSide, "左"):
		angle += "，轴线右侧"
	case strings.TrimSpace(axisSide) != "":
		angle += "，" + strings.TrimSpace(axisSide)
	}
	return angle
}

func storyboardInferLens(shotSize string) string {
	switch {
	case strings.Contains(shotSize, "远景"), strings.Contains(shotSize, "全景"):
		return "广角，深景深交代空间"
	case strings.Contains(shotSize, "特写"), strings.Contains(shotSize, "近景"):
		return "中长焦，浅景深焦点落在主体"
	}
	return "标准焦段，景深适中"
}

func storyboardInferMovement(camera string) string {
	text := storyboardCameraSection(camera, "机位运动")
	if word := storyboardFirstKeyword(text, []string{"环绕", "升降", "手持", "跟拍", "跟随", "推近", "缓推", "推镜", "拉远", "缓拉", "拉镜", "摇镜", "横摇", "横移", "平移"}); word != "" {
		return word
	}
	return "固定机位"
}

func storyboardInferEquipment(movement string) string {
	switch {
	case strings.Contains(movement, "手持"):
		return "肩扛手持"
	case strings.Contains(movement, "升降"):
		return "摇臂"
	case strings.Contains(movement, "环绕"), strings.Contains(movement, "跟"), strings.Contains(movement, "移"):
		return "稳定器"
	case strings.Contains(movement, "固定"):
		return "三脚架"
	}
	return "稳定器"
}

func storyboardInferCutPoint(dialogue string) string {
	text := strings.TrimSpace(dialogue)
	if text == "" || text == "无" {
		return "动作落幅稳定处切走"
	}
	return "对白说完、视线落定处切走"
}
