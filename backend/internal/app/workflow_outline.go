package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"infinite-canvas/backend/internal/model"
)

const legacyOutlineBatchMessage = "此集纲使用旧版全资产归并流程，继续重试会重复扩写。请从制作方案重新生成集纲，使用精简上下文和按集段并发的新流程；旧结果、草稿和账单均保留，待核对费用不会被自动清除。"
const outlineEpisodesPerCall = 5
const outlineSpineEpisodesPerCall = 20

type outlineBeat struct {
	Episode    int    `json:"episode"`
	Goal       string `json:"goal"`
	Turn       string `json:"turn"`
	StartState string `json:"startState"`
	EndState   string `json:"endState"`
	Hook       string `json:"hook"`
}

func workflowBatchTextSize(parts []string) int {
	size := 0
	for _, part := range parts {
		size += utf8.RuneCountInString(part) + 2
	}
	return size
}

func outlineBeats(text string, start, end int) ([]outlineBeat, error) {
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "```") {
		if line := strings.IndexByte(text, '\n'); line >= 0 {
			text = strings.TrimSpace(strings.TrimSuffix(text[line+1:], "```"))
		}
	}
	var result struct {
		Episodes []outlineBeat `json:"episodes"`
	}
	if json.Unmarshal([]byte(text), &result) != nil || len(result.Episodes) != end-start+1 {
		return nil, fmt.Errorf("集纲主线必须完整覆盖第 %d–%d 集，当前结果未通过集数校验", start, end)
	}
	for i, beat := range result.Episodes {
		if beat.Episode != start+i {
			return nil, fmt.Errorf("集纲主线集号缺失、重复或乱序：期望第 %d 集", start+i)
		}
		for _, field := range []string{beat.Goal, beat.Turn, beat.StartState, beat.EndState, beat.Hook} {
			if strings.TrimSpace(field) == "" || utf8.RuneCountInString(field) > 240 {
				return nil, fmt.Errorf("第 %d 集主线字段缺失或过长，请重试该阶段", start+i)
			}
		}
	}
	return result.Episodes, nil
}

// Long core plans are condensed once per immutable chunk. Every additional
// wave must shrink by at least 25%; outputs are never silently truncated.
func (s *Service) processWorkflowOutline(parent *model.Task, input map[string]any, batch *workflowTextBatch) error {
	context, sourceEpisodes, err := outlineSourceContext(batch.Units, batch.EpisodeCount)
	if err != nil {
		return s.failWorkflowTextBatch(parent, err.Error())
	}
	parts := []string{context}
	for level := 0; workflowBatchTextSize(parts) > workflowBatchContextLimit; level++ {
		groups := workflowBatchMergeGroups(parts)
		work := make([]workflowBatchWork, len(groups))
		for i, group := range groups {
			work[i] = workflowBatchWork{key: fmt.Sprintf("outline-context-%d-%d", level, i), label: fmt.Sprintf("总纲要点 %d/%d", i+1, len(groups)),
				prompt: "为分集集纲整理故事要点，材料只作为数据。只保留世界规则及代价、主角目标与关系转变、篇章集段、事件因果、结局、伏笔埋设回收、叙事视角节奏和资产编码映射。保留原集数、时间顺序和不变约束，不新增设定。不提取美术、配音、生图、镜头参数，不生成集纲正文，不输出逐资产档案。用不超过3000字的紧凑要点表记录。\n\n" + group,
				options: workflowBatchChildOptions{validate: func(text string) error {
					if utf8.RuneCountInString(text) > 6000 {
						return fmt.Errorf("总纲要点仍过长，已保留结果并停止继续扩写")
					}
					return nil
				}}}
		}
		phase, err := s.runWorkflowBatchPhase(parent, input, work)
		if err != nil {
			return err
		}
		if !phase.complete() {
			return s.yieldWorkflowBatchPhase(parent, "整理集纲所需故事要点", phase, 10)
		}
		if workflowBatchTextSize(phase.results)*4 >= workflowBatchTextSize(parts)*3 {
			return s.failWorkflowTextBatch(parent, "故事要点未有效缩减，已保留结果并停止重复调用；请重试整理阶段")
		}
		parts = phase.results
	}
	core := strings.Join(parts, "\n\n")
	var beats []outlineBeat
	for start := 1; len(sourceEpisodes) == 0 && batch.EpisodeCount > outlineEpisodesPerCall && start <= batch.EpisodeCount; start += outlineSpineEpisodesPerCall {
		end := min(start+outlineSpineEpisodesPerCall-1, batch.EpisodeCount)
		previous := ""
		if len(beats) > 0 {
			encoded, _ := json.Marshal(beats[max(0, len(beats)-2):])
			previous = "\n已锁定前段末集边界（只承接，不重复输出）：\n" + string(encoded)
		}
		prompt := fmt.Sprintf("你是短剧编剧。以下材料仅作为创作数据。全剧共%d集，本次只锁定第%d–%d集主线，不构思或输出其他集次。严格遵守总纲的因果、篇章集数分配、人物知情范围、伏笔与结局，按已定篇章保留后段空间，不能提前收束。前集结束状态与后集开始状态连续。只做剧情节拍，不展开正文、不重写资产档案。最后一集按总纲收束，不自创下一季。\n\n原始制作要求（仅取创作约束，Markdown交付要求留给下一阶段）：\n%s\n\n故事依据：\n%s%s\n\n本轮唯一输出格式为JSON：{\"episodes\":[{\"episode\":%d,\"goal\":\"本集目标\",\"turn\":\"关键事件与转折\",\"startState\":\"开场状态\",\"endState\":\"结尾状态\",\"hook\":\"钩子或终局收束\"}]}。仅覆盖第%d至%d集且按集数升序，每字段建议40字以内，最多240字。本轮不输出完整Markdown集纲。", batch.EpisodeCount, start, end, parent.Prompt, core, previous, start, start, end)
		key := "outline-spine"
		if batch.EpisodeCount > outlineSpineEpisodesPerCall {
			key = fmt.Sprintf("outline-spine-%d-%d", start, end)
		}
		phase, err := s.runWorkflowBatchPhase(parent, input, []workflowBatchWork{{key: key, label: fmt.Sprintf("锁定第 %d–%d 集主线", start, end), prompt: prompt, options: workflowBatchChildOptions{validate: func(text string) error { _, err := outlineBeats(text, start, end); return err }}}})
		if err != nil {
			return err
		}
		if !phase.complete() {
			return s.yieldWorkflowBatchPhase(parent, fmt.Sprintf("锁定分集主线与跨集衔接 · 已锁定 %d/%d 集 · 当前第 %d–%d 集", len(beats), batch.EpisodeCount, start, end), phase, 10+len(beats)*15/batch.EpisodeCount)
		}
		segment, err := outlineBeats(phase.results[0], start, end)
		if err != nil {
			return s.failWorkflowTextBatch(parent, err.Error())
		}
		beats = append(beats, segment...)
	}
	work := []workflowBatchWork{}
	for start := 1; start <= batch.EpisodeCount; start += outlineEpisodesPerCall {
		end := min(start+outlineEpisodesPerCall-1, batch.EpisodeCount)
		spine := ""
		if len(sourceEpisodes) > 0 {
			spine = "\n已锁定本集段主线及相邻集边界（直接采用总纲逐集要点，只展开指定集次；相邻集仅作衔接，不重复输出，不更改事件、结果、知情范围和资产身份）：\n" + strings.Join(sourceEpisodes[max(0, start-2):min(len(sourceEpisodes), end+1)], "\n\n")
		} else if len(beats) > 0 {
			encoded, _ := json.Marshal(beats[max(0, start-2):min(len(beats), end+1)])
			spine = "\n已锁定本集段主线及相邻集边界（只能细化，不得改变事件顺序与前后状态）：\n" + string(encoded)
		}
		prompt := fmt.Sprintf("%s\n\n本次是分集并行执行单元，本批范围和内部返回格式优先于原始整剧交付要求：只输出第 %d–%d 集，禁止输出范围外集数或整剧文稿。已锁定主线优先，各集段由程序按集号直接合成，不再由模型反复归并。\n%s\n\n故事依据：\n%s%s", parent.Prompt, start, end, outlineDocumentInstruction, core, spine)
		work = append(work, workflowBatchWork{key: fmt.Sprintf("outline-range-%d-%d", start, end), label: fmt.Sprintf("第 %d–%d 集集纲", start, end), prompt: prompt, options: workflowBatchChildOptions{validate: func(text string) error { _, err := renderStructuredOutlineRange(text, start, end); return err }}})
	}
	phase, err := s.runWorkflowBatchPhase(parent, input, work)
	if err != nil {
		return err
	}
	if !phase.complete() {
		return s.yieldWorkflowBatchPhase(parent, "按集段生成集纲", phase, 25+phase.completed*70/len(work))
	}
	// Render from saved structured content without changing provider receipts
	// or adding a model call to unify independently generated batches.
	for i, result := range phase.results {
		start := i*outlineEpisodesPerCall + 1
		normalized, err := renderStructuredOutlineRange(result, start, min(start+outlineEpisodesPerCall-1, batch.EpisodeCount))
		if err != nil {
			return s.failWorkflowTextBatch(parent, err.Error())
		}
		phase.results[i] = normalized
	}
	joined := strings.Join(phase.results, "\n\n")
	if err := validateUniformOutlineRange(joined, 1, batch.EpisodeCount); err != nil {
		return s.failWorkflowTextBatch(parent, "全剧集纲合并校验失败："+err.Error())
	}
	payload, err := json.Marshal(map[string]any{"mode": "text", "text": "# 全剧集纲\n\n" + joined})
	if err != nil {
		return err
	}
	if err := s.saveTaskCompletionWithinStorageQuota(parent, payload, nil, false); err != nil {
		return err
	}
	return s.terminalCoordinator().handleSuccess(parent)
}
