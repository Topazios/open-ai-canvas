import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "./canvas-resource-references";
import { assetVariantMaterial } from "../production-continuity";
import { productionAssetBaseCode, productionAssetCodes } from "../production-asset-code";

export function productionAssetDocuments(nodes: CanvasNodeData[]) {
    const assets = new Map<string, CanvasNodeData>();
    const identities = new Map<string, string>();
    const groups = new Map<string, CanvasNodeData[]>();
    const seen = new Set<string>();
    for (const node of nodes) {
        const data = node.metadata?.shortDrama;
        const identity = data?.assetIdentity;
        if (!identity || node.type !== CanvasNodeType.Text || data?.assetKey === "$summary") continue;
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        if (identities.has(identity.code) && identities.get(identity.code) !== identity.id) throw new Error(`资产编码冲突：${identity.code}`);
        identities.set(identity.code, identity.id);
        const key = `${identity.code}:${data.step}`;
        const group = groups.get(key);
        if (group) group.push(node);
        else groups.set(key, [node]);
    }
    for (const group of groups.values()) {
        const adopted = group.filter(item => item.metadata?.shortDrama?.assetAdopted === true);
        const identity = group[0].metadata!.shortDrama!.assetIdentity!;
        if (group.length > 1 && adopted.length !== 1) throw new Error(`资产 ${identity.code} 引用了多个版本，请选择一个采用版本或固定来源文稿`);
        const node = adopted[0] || group[0], data = node.metadata!.shortDrama!;
        const previous = assets.get(identity.code);
        if (!previous || data.step === "assets.reconcile" || previous.metadata?.shortDrama?.step === "story.plan") assets.set(identity.code, node);
    }
    return [...assets.values()];
}

export function productionAssetMentions(nodes: CanvasNodeData[]): CanvasResourceReference[] {
    return productionAssetDocuments(nodes).flatMap((node) => {
        const data = node.metadata!.shortDrama!;
        const identity = data.assetIdentity!;
        const entry = (code: string, title: string, text: string): CanvasResourceReference => ({
            id: `${node.id}:${code}`, nodeId: node.id, kind: "text", label: code, title,
            text, active: true, sourceType: node.type, mentionToken: `@${code}`,
        });
        return [entry(identity.code, node.title, node.metadata?.content || ""), ...(data.assetProfile?.variants || []).flatMap((variant) =>
            variant.code ? [entry(variant.code, `${node.title} · ${variant.name}`, assetVariantMaterial(variant))] : [])];
    });
}

export function resolveProductionAssetReferences(prompt: string, sources: CanvasNodeData[], explicitCodes: string[] = [], renderContent?: (node: CanvasNodeData) => string, options: { allowMissing?: boolean } = {}) {
    const codes = [...new Set([...explicitCodes, ...productionAssetCodes(prompt, true)])];
    const requestedBases = new Set(codes.map(productionAssetBaseCode));
    const documents = productionAssetDocuments(sources.filter(node => requestedBases.has(node.metadata?.shortDrama?.assetIdentity?.code || "")));
    // With allowMissing, assets that are not generated yet become placeholders instead of errors.
    const missing: string[] = [];
    const references = codes.flatMap((code) => {
        const base = productionAssetBaseCode(code);
        const node = documents.find((item) => item.metadata!.shortDrama!.assetIdentity!.code === base) ||
            sources.find((item) => item.metadata?.shortDrama?.assetProfile && (item.metadata.shortDrama.assetKey === code || item.title === code));
        if (!node || !node.metadata?.content?.trim() || node.metadata.status === "error" || node.metadata.status === "loading") {
            if (options.allowMissing) { missing.push(code); return []; }
            throw new Error(`资产引用不存在或未完成：${code}`);
        }
        const variant = code !== base ? node.metadata.shortDrama?.assetProfile?.variants.find((item) => item.code === code) : undefined;
        if (code !== base && !variant) {
            if (options.allowMissing) { missing.push(code); return []; }
            throw new Error(`资产状态不存在：${code}`);
        }
        return [{ node, code, variant }];
    });
    const nodes = [...new Map(references.map((entry) => [entry.node.id, entry.node])).values()];
    const content = nodes.map((node) => {
        const data = node.metadata!.shortDrama!;
        const variants = references.filter((entry) => entry.node.id === node.id && entry.variant).map((entry) => renderContent ? `${entry.code} ${entry.variant!.name}：${entry.variant!.description}` : assetVariantMaterial(entry.variant!));
        const body = renderContent ? renderContent(node) : node.metadata!.content;
        if (!body && !variants.length) return "";
        return `${data.assetIdentity?.code || data.assetKey} · ${node.title}\n${body}${variants.length ? `\n指定状态：\n${variants.join("\n")}` : ""}`;
    }).filter(Boolean).join("\n\n");
    return { nodes, content, codes: references.map((entry) => entry.code), missing };
}
