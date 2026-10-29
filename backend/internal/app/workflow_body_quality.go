package app

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"infinite-canvas/backend/internal/model"
)

type bodyWritingSpec struct {
	Version       int    `json:"version"`
	MinSeconds    int    `json:"minSeconds"`
	MaxSeconds    int    `json:"maxSeconds"`
	TargetSeconds int    `json:"targetSeconds"`
	Language      string `json:"language"`
}

func (b bodyWritingSpec) valid() bool {
	return (b.Version == 1 || b.Version == 2) && b.MinSeconds >= 10 && b.MaxSeconds <= 3600 && b.MaxSeconds >= b.MinSeconds && b.TargetSeconds >= b.MinSeconds && b.TargetSeconds <= b.MaxSeconds && len(b.Language) > 0 && len(b.Language) <= 24
}

var bodyBeatDuration = regexp.MustCompile(`^[ \t]*【节拍时长[：:]\s*([0-9]{1,4})\s*秒】[ \t]*$`)
var bodyAssetCode = regexp.MustCompile(`\b` + model.ProductionAssetReferencePattern + `\b`)
var bodyAppendixHeading = regexp.MustCompile(`^(?:本集)?(?:资产(?:应用|清单|引用)|新增资产|连续性(?:检查|核对)|制作附录|状态衔接|补充说明)`)

// This catches obvious underdevelopment, not artistic quality or actual runtime.
// Technical appendices, cast lists and declared total durations do not count.
func bodyWritingIssues(text string, spec *bodyWritingSpec) []string {
	issues := bodyWritingGlobalIssues(text, spec)
	if spec != nil && spec.Version >= 2 {
		issues = append(issues, bodyBeatPacingIssues(text, bodyCharacterBased(spec.Language))...)
	}
	return issues
}

func bodyCharacterBased(language string) bool {
	for _, prefix := range []string{"zh", "ja", "ko", "th"} {
		if strings.HasPrefix(language, prefix) {
			return true
		}
	}
	return false
}

func bodyWritingGlobalIssues(text string, spec *bodyWritingSpec) []string {
	if spec == nil {
		return nil
	}
	characterBased := bodyCharacterBased(spec.Language)
	beats, seconds, units, emptyBeats := 0, 0, 0, 0
	beatUnits := 0
	beatSeconds := 0
	minBeatUnits := 12
	if !characterBased {
		minBeatUnits = 3
	}
	beatEmpty := func() bool {
		if spec.Version == 1 {
			return beatUnits < minBeatUnits
		}
		return beatUnits == 0 || (beatSeconds >= 8 && beatUnits < minBeatUnits)
	}
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if match := bodyBeatDuration.FindStringSubmatch(trimmed); match != nil {
			if beats > 0 && beatEmpty() {
				emptyBeats++
			}
			beats++
			beatUnits = 0
			value, _ := strconv.Atoi(match[1])
			beatSeconds = value
			seconds += value
			continue
		}
		plain := strings.TrimLeft(trimmed, "#* \t")
		if bodyAppendixHeading.MatchString(plain) {
			break
		}
		if beats == 0 || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(plain, "人物：") || strings.HasPrefix(plain, "出场人物：") || strings.HasPrefix(plain, "【剪辑") || strings.HasPrefix(plain, "【音效") || strings.HasPrefix(plain, "【音乐") {
			continue
		}
		plain = bodyAssetCode.ReplaceAllString(plain, "")
		count := 0
		if characterBased {
			for _, r := range plain {
				if unicode.IsLetter(r) {
					count++
				}
			}
		} else {
			count = len(strings.FieldsFunc(plain, func(r rune) bool { return !unicode.IsLetter(r) && r != '\'' }))
		}
		units += count
		beatUnits += count
	}
	if beats > 0 && beatEmpty() {
		emptyBeats++
	}
	issues := []string{}
	minBeats := int(math.Ceil(float64(spec.TargetSeconds) / 25))
	if beats < minBeats {
		issues = append(issues, fmt.Sprintf("有效节拍仅 %d 段，约 %d 秒的剧本需展开行动、反应及冲突推进（参考至少 %d 段）", beats, spec.TargetSeconds, minBeats))
	}
	if seconds < spec.MinSeconds || seconds > spec.MaxSeconds {
		issues = append(issues, fmt.Sprintf("节拍合计 %d 秒，要求 %d–%d 秒；须调整真实动作与对白，不能只改时长标签", seconds, spec.MinSeconds, spec.MaxSeconds))
	}
	rate, unit := 350.0, "字"
	if !characterBased {
		rate, unit = 130, "词"
	}
	minimum := int(math.Round(float64(spec.TargetSeconds) / 60 * rate))
	if units < minimum {
		issues = append(issues, fmt.Sprintf("戏剧正文约 %d %s，明显展开不足（本集体量检查参考 %d %s，不计资产附录与技术说明）", units, unit, minimum, unit))
	}
	if emptyBeats > 0 {
		issues = append(issues, fmt.Sprintf("%d 个节拍缺少实质行动或对白，不应用空标签填时长", emptyBeats))
	}
	return issues
}

var bodySpeechLine = regexp.MustCompile(`^([^：:]{1,48})[：:]\s*(.+)$`)
var bodyNonSpeechLabel = regexp.MustCompile(`(?i)^(?:人物|出场人物|场次|时间|地点|画面与动作|画面|动作|音效|音乐|剪辑|剪辑提示|镜头|字幕|时长|资产|备注|说明|SFX|BGM|Action|Sound|Music|Scene|Location|Time|Camera)(?:（[^）]*）|\([^)]*\))?$`)
var bodyActionLabel = regexp.MustCompile(`(?i)^(?:画面与动作|画面|动作|Action)$`)
var bodyHold = regexp.MustCompile(`沉默|久久|良久|静静|长时间|长久|停顿|发呆|不说话|没有说话|(?i:\b(?:silence|silent|pause|waiting)\b)`)

// Conservative screening only: speech cannot exceed even a fast read, while
// short speech plus sparse action cannot justify a long hold by itself.
func bodyBeatPacingIssues(text string, characterBased bool) []string {
	issues := []string{}
	index, seconds, speech, action := 0, 0, 0, 0
	hold := false
	narrationBlock := false
	count := func(value string) int {
		value = bodyAssetCode.ReplaceAllString(value, "")
		if !characterBased {
			return len(strings.FieldsFunc(value, func(r rune) bool { return !unicode.IsLetter(r) && r != '\'' }))
		}
		n := 0
		for _, r := range value {
			if unicode.IsLetter(r) {
				n++
			}
		}
		return n
	}
	finish := func() {
		if index == 0 {
			return
		}
		if seconds <= 0 {
			issues = append(issues, fmt.Sprintf("第 %d 节拍时长必须为正数", index))
			return
		}
		fastSpeechRate, sparseSpeechRate, sparseActionRate := 6.0, 1.0, 3.0
		unit := "字"
		if !characterBased {
			fastSpeechRate, sparseSpeechRate, sparseActionRate = 3.5, 0.6, 1.5
			unit = "词"
		}
		minimumSpeechTime := int(math.Ceil(float64(speech) / fastSpeechRate))
		if minimumSpeechTime > seconds+1 {
			issues = append(issues, fmt.Sprintf("第 %d 节拍口播约 %d %s却仅标 %d 秒，连偏快朗读的粗估都需约 %d 秒；调整对白或节奏，不用赶读硬塞", index, speech, unit, seconds, minimumSpeechTime))
		}
		if seconds >= 8 && float64(speech) <= float64(seconds)*sparseSpeechRate && float64(action) < float64(seconds)*sparseActionRate {
			if hold || speech == 0 {
				issues = append(issues, fmt.Sprintf("第 %d 节拍标 %d 秒但口播和行动稀少，存在可疑留白；核对沉默或停顿的具体反应与后果，能短演就缩短，不添形容词凑时长", index, seconds))
			}
		}
	}
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if match := bodyBeatDuration.FindStringSubmatch(line); match != nil {
			finish()
			index++
			seconds, _ = strconv.Atoi(match[1])
			speech, action, hold = 0, 0, false
			narrationBlock = false
			continue
		}
		plain := strings.TrimLeft(line, "#* \t")
		if bodyAppendixHeading.MatchString(plain) {
			break
		}
		if index == 0 || strings.HasPrefix(line, "#") {
			narrationBlock = false
			continue
		}
		// Inline stage labels are not speakers. Spoken narration is counted,
		// while sounds, cast lists and editing notes are not read aloud.
		if strings.HasPrefix(plain, "【") {
			if end := strings.Index(plain, "】"); end >= 0 {
				label, rest := plain[len("【"):end], strings.TrimSpace(plain[end+len("】"):])
				narrationBlock = false
				switch label {
				case "旁白", "独白", "内心声":
					speech += count(rest)
					narrationBlock = rest == ""
					continue
				case "对白", "台词", "画面与动作", "画面", "动作":
					plain = rest
				default:
					if bodyNonSpeechLabel.MatchString(label) {
						continue
					}
				}
			}
		}
		if match := bodySpeechLine.FindStringSubmatch(plain); match != nil {
			narrationBlock = false
			label := strings.Trim(match[1], "【】[]* ")
			if bodyNonSpeechLabel.MatchString(label) {
				if bodyActionLabel.MatchString(label) {
					hold = hold || bodyHold.MatchString(match[2])
					action += count(match[2])
				}
			} else {
				speech += count(match[2])
			}
			continue
		}
		if narrationBlock {
			speech += count(plain)
			continue
		}
		hold = hold || bodyHold.MatchString(plain)
		action += count(plain)
	}
	finish()
	if len(issues) > 4 {
		issues = append(issues[:4], fmt.Sprintf("另有 %d 项逐段节奏问题，请一并自查；机器粗估不能代替配音与表演实测", len(issues)-4))
	}
	return issues
}
