import { productionBibleSections } from "../../src/lib/production-bible";
export const legacyBibleOutput = JSON.stringify({ summary: "覆盖第1、2集，设计建议待确认", items: [
    { name: "故事设定", section: "settings", content: "正文事实：当代城市；能力限制需确认。" },
    { name: "表现风格", section: "style", content: "设计建议：写实摄影，克制配乐，待用户确认。" },
] });
export const bibleOutput = JSON.stringify({ summary: "覆盖第1、2集，设计建议供后续调整", items: productionBibleSections.map((section) => ({ name: section.label, section: section.key, content: `正文依据：第1、2集。\n制作建议：${section.scope}。` })) });
export function assetItem(name: string, content: string, episode = 1) {
    return { priority: episode, name, content, aliases: [], occurrences: [{ episode, scene: "1", state: "基准", owner: "待确认", location: "客厅", evidence: `第${episode}集正文` }], variants: [], sounds: ["声线待确认"], conflicts: [] };
}
export const assetOutput = JSON.stringify({ summary: "覆盖第1、2集；别名已归并，其余4集待补。", items: [assetItem("林舟", "依据：第1集；人物提示词：青年黑发；服装待确认。"), assetItem("阿宁", "依据：第2集；人物提示词：短发青年。", 2)] });
