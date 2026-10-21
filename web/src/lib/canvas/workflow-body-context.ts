import type { CanvasNodeData } from "@/types/canvas";
import { outlineDirectionContext } from "./workflow-outline-context";

export function episodeOutlineContext(content: string, episode: number) {
    const headings = [...content.matchAll(/^#{1,3}\s+第\s*(\d+)\s*集[^\n]*$/gm)];
    // Legacy hand-written outlines are kept intact rather than silently discarded.
    if (!headings.length) return { current: content, context: content };
    const matches = headings.filter(match => Number(match[1]) === episode);
    if (matches.length !== 1) throw new Error(`集纲中第 ${episode} 集${matches.length ? "重复" : "缺失"}，请先修正集纲`);
    const section = (index: number) => content.slice(headings[index].index, headings[index + 1]?.index ?? content.length).trim();
    const index = headings.indexOf(matches[0]);
    const current = section(index);
    const context = [
        index > 0 ? `【前集衔接，仅供连续性参考】\n${section(index - 1)}` : "",
        `【本集集纲，正文只扩写本集】\n${current}`,
        index + 1 < headings.length ? `【后集边界，不提前展开】\n${section(index + 1)}` : "",
    ].filter(Boolean).join("\n\n");
    return { current, context };
}

const bodyProductionOnlyHeadings = new Set([
    "人物编码、别名、选题依据与预计出场", "场景编码、别名、选题依据与预计出场",
    "道具编码、别名、选题依据与预计出场", "声音编码、别名、选题依据与预计出场",
    "年龄感、体型、面部与辨识特征", "固定服装、配饰与材质配色", "发型、妆容与固定细节",
    "音域、音高与共鸣位置", "可复用配音提示词", "人物参考图生成提示词",
    "建筑材质、表面质感与配色", "固定光源、日夜与天气光照", "可用机位、遮挡与取景边界",
    "场景参考图生成提示词", "道具参考图生成提示词", "道具材质、工艺、配色与表面细节",
    "声音生成提示词与声线复用要求", "音色、频段、质感与声源构成", "距离、方位、混响与空间层次",
    "音量层级、对白避让与混音边界", "生图参数", "负面提示词",
]);

const bodyAssetNoiseHeadings: Record<string, Set<string>> = {
    character: new Set(["人物编码、别名、选题依据与预计出场", "人物经历与关键成因", "人物成长与阶段变化", "年龄感、体型、面部与辨识特征", "固定服装、配饰与材质配色", "发型、妆容与固定细节", "人物创作设计与未定事项", "人物参考图生成提示词"]),
    environment: new Set(["场景编码、别名、选题依据与预计出场", "地理位置、时代与建筑类型", "建筑材质、表面质感与配色", "固定光源、日夜与天气光照", "可用机位、遮挡与取景边界", "场景创作设计与未定事项", "场景参考图生成提示词"]),
    prop: new Set(["道具编码、别名、选题依据与预计出场", "道具形状、尺寸、比例与辨识特征", "道具材质、工艺、配色与表面细节", "道具创作设计与未定事项", "道具参考图生成提示词"]),
    sound: new Set(["声音编码、别名、选题依据与预计出场", "音色、频段、质感与声源构成", "距离、方位、混响与空间层次", "音量层级、对白避让与混音边界", "声音创作设计与未定事项", "声音生成提示词与声线复用要求"]),
};

function bodyAssetContent(content: string, kind?: string) {
    // Keep identity, personality, voice and causal rules; image production belongs downstream.
    let excludedDepth = 0;
    let fence = "";
    const noise = bodyAssetNoiseHeadings[kind || ""] || new Set<string>();
    const lines = content.split(/\r?\n/);
    return lines.filter(line => {
        const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
        if (marker && (!fence || marker[0] === fence[0])) fence = fence ? "" : marker;
        const heading = !fence && !marker ? line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
        if (heading) {
            if (excludedDepth && heading[1].length <= excludedDepth) excludedDepth = 0;
            if (!excludedDepth && (bodyProductionOnlyHeadings.has(heading[2]) || noise.has(heading[2]) || /参考图生成提示词|可复用配音提示词|生图参数|负面提示词/.test(heading[2]))) excludedDepth = heading[1].length;
        }
        return !excludedDepth;
    }).join("\n").trim();
}

function bodyWorldRules(content: string) {
    const lines = content.split(/\r?\n/);
    if (!lines.some(line => /^#{1,2}\s/.test(line))) return content;
    let include = false;
    return lines.filter(line => {
        const heading = line.match(/^#{1,2}\s+(.+)/);
        if (heading) include = /时代背景|世界设定|世界运行规则|限制与代价|时间线|故事连续性/.test(heading[1]);
        return include;
    }).join("\n").trim();
}

export function bodySourceRecords(sources: CanvasNodeData[], episode: number, instruction: string) {
    const outlines = sources.filter(node => (node.metadata?.shortDrama?.step || `story.${node.metadata?.storyDevelopment?.stage}`) === "story.episodes");
    const selected = new Map(outlines.map(node => [node.id, episodeOutlineContext(node.metadata?.content || "", episode)]));
    const current = [...selected.values()].map(value => value.current).join("\n");
    const mentions = `${current}\n${instruction}`;
    const codes = new Set([...mentions.matchAll(/\b(?:CHR|SCN|PRP|SPC|AUD)-\d+(?:-V\d+)?\b/g)].map(match => match[0].replace(/-V\d+$/, "")));
    const hasStory = sources.some(node => node.metadata?.shortDrama?.planSection === "story");
    return sources.flatMap(node => {
        const data = node.metadata?.shortDrama;
        const step = data?.step || `story.${node.metadata?.storyDevelopment?.stage}`;
        if (data?.role === "collection" || data?.assetKey === "$summary" || data?.mediaKind) return [];
        if (step === "story.topic" && hasStory) return [];
        if (["visual", "generation", "inventory"].includes(data?.planSection || "")) return [];
        // The outline is the writing contract. Prior episode prose and other
        // downstream outputs are not an implicit invitation to reread the series.
        if (step === "story.body" || step.startsWith("direction.") || step.startsWith("voice.")) return [];
        const asset = data?.planAsset;
        const isAsset = !!(asset || data?.assetIdentity || data?.assetProfile);
        if (isAsset) {
            const code = data?.assetIdentity?.code;
            const named = [asset?.name, node.title].some(name => name && mentions.includes(name));
            const relevant = (code && codes.has(code)) || named;
            if (!relevant) return [];
        }
        let content = selected.get(node.id)?.context ?? node.metadata?.content ?? "";
        if (data?.planSection === "story") content = bodyWorldRules(content);
        if (data?.planSection === "direction") content = outlineDirectionContext(content);
        if (isAsset) content = bodyAssetContent(content, asset?.kind);
        if (!content.trim()) return [];
        return [{ id: node.id, title: node.title, step, episodeNumber: data?.episodeNumber, assetIdentity: data?.assetIdentity, content }];
    });
}
