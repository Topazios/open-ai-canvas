import type { CanvasNodeData } from "@/types/canvas";
import { outlineDirectionContext } from "./workflow-outline-context";
import { assetVariantMaterial } from "../production-continuity";
import { productionAssetBaseCode, productionAssetCodes } from "../production-asset-code";

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

function bodyWorldRules(content: string) {
    const lines = content.split(/\r?\n/);
    if (!lines.some(line => /^#{1,2}\s/.test(line))) return content;
    let include = false;
    return lines.filter(line => {
        const heading = line.match(/^#{1,2}\s+(.+)/);
        if (heading) include = /时代背景|世界设定|世界运行规则|限制与代价|时间线|故事连续性|本土创作依据/.test(heading[1]);
        return include;
    }).join("\n").trim();
}

export function bodySourceRecords(sources: CanvasNodeData[], episode: number, instruction: string) {
    const outlines = sources.filter(node => (node.metadata?.shortDrama?.step || `story.${node.metadata?.storyDevelopment?.stage}`) === "story.episodes");
    const selected = new Map(outlines.map(node => [node.id, episodeOutlineContext(node.metadata?.content || "", episode)]));
    const current = [...selected.values()].map(value => value.current).join("\n");
    const mentions = `${current}\n${instruction}`;
    const codes = new Set(productionAssetCodes(mentions).map(productionAssetBaseCode));
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
        if (isAsset) {
            content = `本集关联资产编码索引（详细设定按需读取）：${JSON.stringify({
                code: data?.assetIdentity?.code || asset?.key,
                name: asset?.name || node.title,
                kind: asset?.kind,
                purpose: asset?.purpose,
                plannedRange: asset?.plannedRange,
                episodes: asset?.episodes,
            })}`;
            const variants = data?.assetProfile?.variants.filter(variant => variant.code && mentions.includes(variant.code)) || [];
            if (variants.length) content += `\n\n本集指定状态：\n${variants.map(assetVariantMaterial).join("\n")}`;
        }
        if (!content.trim()) return [];
        return [{ id: node.id, title: node.title, step, episodeNumber: data?.episodeNumber, assetIdentity: data?.assetIdentity, content }];
    });
}
