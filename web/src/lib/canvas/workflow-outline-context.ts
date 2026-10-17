// Remove only explicitly visual/technical sections from the current document.
// Unknown headings and unstructured edits remain intact; stale indices never
// replace current narrative facts.
const visualAssetHeadings = new Set([
    "年龄感、体型、面部与辨识特征", "固定服装、配饰与材质配色", "发型、妆容与固定细节",
    "声线音色、质感与辨识点", "音域、音高与共鸣位置", "语速、节奏、停顿与重音",
    "可复用配音提示词", "人物参考图生成提示词", "人物外观与声线禁止变化",
    "建筑材质、表面质感与配色", "固定光源、日夜与天气光照", "可用机位、遮挡与取景边界",
    "场景参考图生成提示词", "道具参考图生成提示词", "道具材质、工艺、配色与表面细节",
]);

export function outlineAssetNarrative(content: string): string {
    const lines = content.split(/\r?\n/);
    const result: string[] = [];
    let excludedDepth = 0;
    let fence: string | undefined;
    for (const line of lines) {
        const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
        if (marker && (!fence || marker[0] === fence[0])) fence = fence ? undefined : marker;
        const heading = !fence && !marker ? line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
        if (heading) {
            if (excludedDepth && heading[1].length <= excludedDepth) excludedDepth = 0;
            if (!excludedDepth && visualAssetHeadings.has(heading[2])) excludedDepth = heading[1].length;
        }
        if (!excludedDepth) result.push(line);
    }
    return result.join("\n").trim();
}

// Only these director rules affect an outline. Camera, voice, lighting and
// delivery instructions belong to subsequent production steps.
export function outlineDirectionContext(content: string): string {
    let include = false;
    const result: string[] = [];
    for (const line of content.split(/\r?\n/)) {
        const heading = line.match(/^#{1,2}\s+(.+?)\s*#*\s*$/);
        if (heading) include = /叙事|视角|节奏|信息差/.test(heading[1]);
        if (include) result.push(line);
    }
    return result.join("\n").trim();
}
