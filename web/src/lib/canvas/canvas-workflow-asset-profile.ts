import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { WorkflowAssetProfile } from "../short-drama-steps";

export function assetContentSignature(content: string) {
    let hash = 2166136261;
    for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16);
}

export function assetMediaSignature(node: CanvasNodeData) {
    return assetContentSignature(JSON.stringify([node.type, node.metadata?.storageKey, node.metadata?.content]));
}

export function isAssetReference(node: CanvasNodeData) {
    return (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) &&
        node.metadata?.status !== "loading" && node.metadata?.status !== "error" && Boolean(node.metadata?.storageKey || node.metadata?.content);
}

export function assetReferenceState(profile: WorkflowAssetProfile | undefined, nodes: CanvasNodeData[], content?: string) {
    if (!profile?.references.length) return "仅描述";
    if (content !== undefined && profile.indexContent !== assetContentSignature(content)) return "正文已变化，参考待核对";
    const valid = profile.references.filter((ref) => {
        const node = nodes.find((entry) => entry.id === ref.nodeId);
        return node && isAssetReference(node) && assetMediaSignature(node) === ref.signature;
    });
    if (valid.length !== profile.references.length) return "参考已变化或缺失";
    return valid.some((ref) => ref.selected) ? "已选定参考版本" : "候选参考";
}

export function assetContextProfile(node: CanvasNodeData, episode?: number) {
    const profile = node.metadata?.shortDrama?.assetProfile;
    if (!profile) return;
    const current = profile.indexContent === assetContentSignature(node.metadata?.content || "");
    return { ...profile,
        occurrences: current && episode ? profile.occurrences.filter((entry) => entry.episode === episode) : profile.occurrences,
        references: profile.references.filter((ref) => ref.selected || !profile.references.some((other) => other.selected && other.variant === ref.variant)),
    };
}

export function assetAppliesToEpisode(node: CanvasNodeData, episode?: number) {
    const profile = node.metadata?.shortDrama?.assetProfile;
    // Missing or edited indexes cannot prove absence. Keep the asset rather than omit it silently.
    return !episode || !profile || profile.indexContent !== assetContentSignature(node.metadata?.content || "") ||
        !profile.occurrences.length || profile.occurrences.some((entry) => entry.episode === episode);
}

export const assetProfileOutputInstruction = `每个资产条目还必须提供以下结构化字段，与 content 中的文稿一致：
"aliases":["别名"], "occurrences":[{"episode":1,"scene":"场次","state":"出场状态","owner":"所属人物或待确认","location":"所在空间或待确认","evidence":"正文依据"}],
"variants":[{"name":"状态名称","description":"固定特征与变化"}], "sounds":["关联声线/环境声/标志音及依据"], "conflicts":["未解决的冲突或待确认项"]。
无内容的数组用 []。episode 为正文中实际提供的正整数集号，每次出场注明场次和依据；不要编造未提供集数的出场。不得生成参考节点 ID、审批结论或已选定参考。`;

export function parseAssetProfile(value: Record<string, unknown>, content: string): WorkflowAssetProfile {
    const strings = (key: string) => {
        const items = value[key];
        if (!Array.isArray(items) || items.length > 1000 || items.some((item) => typeof item !== "string")) throw new Error(`资产 ${key} 格式无效`);
        return items as string[];
    };
    const occurrences = value.occurrences;
    const variants = value.variants;
    if (!Array.isArray(occurrences) || occurrences.length > 2000 || occurrences.some((entry) => !entry || !Number.isInteger(entry.episode) || entry.episode < 1 || entry.episode > 200 || ["scene", "state", "owner", "location", "evidence"].some((key) => typeof entry[key] !== "string") || !entry.evidence.trim())) throw new Error("资产出场记录缺少集号、场次字段或正文依据");
    if (!Array.isArray(variants) || variants.length > 200 || variants.some((entry) => !entry || typeof entry.name !== "string" || !entry.name.trim() || typeof entry.description !== "string")) throw new Error("资产状态变体格式无效");
    return { aliases: strings("aliases"), sounds: strings("sounds"), conflicts: strings("conflicts"),
        occurrences: occurrences.map((entry) => ({ episode: entry.episode, scene: entry.scene, state: entry.state, owner: entry.owner, location: entry.location, evidence: entry.evidence })),
        variants: variants.map((entry) => ({ name: entry.name, description: entry.description })),
        indexContent: assetContentSignature(content), references: [] };
}
