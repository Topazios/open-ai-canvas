package app

import "strings"

// videoNoSubtitleClause 是发给任何视频上游的统一硬约束：画面内不得出现文字。
// 字幕只在后期合成阶段添加，视频模型一律不负责生成。
const videoNoSubtitleClause = "【硬性限制】画面内严禁出现任何字幕、对白文字、台词条、标题字、水印、台标、Logo、界面文字或任何叠加文字；对白只以声音表达，不得以文字呈现。No subtitles, no captions, no on-screen text, no watermark, no logo."

// withVideoNoSubtitlePolicy 在视频提示词末尾追加无字幕条款，已含条款时不重复追加。
func withVideoNoSubtitlePolicy(prompt string) string {
	prompt = strings.TrimSpace(prompt)
	if strings.Contains(prompt, videoNoSubtitleClause) {
		return prompt
	}
	if prompt == "" {
		return prompt
	}
	return prompt + "\n" + videoNoSubtitleClause
}
