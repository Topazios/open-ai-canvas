import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "./canvas-resource-references";

export function productionAssetDocuments(nodes: CanvasNodeData[]) {
    const assets = new Map<string, CanvasNodeData>();
    for (const node of nodes) {
        const data = node.metadata?.shortDrama;
        const identity = data?.assetIdentity;
        if (!identity || node.type !== CanvasNodeType.Text || data?.assetKey === "$summary") continue;
        const previous = assets.get(identity.code);
        if (previous && previous.metadata?.shortDrama?.assetIdentity?.id !== identity.id) throw new Error(`资产编码冲突：${identity.code}`);
        if (previous && previous.id !== node.id && previous.metadata?.shortDrama?.step === data.step) throw new Error(`资产 ${identity.code} 引用了多个版本，请统一来源`);
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
            variant.code ? [entry(variant.code, `${node.title} · ${variant.name}`, variant.description)] : [])];
    });
}

export function resolveProductionAssetReferences(prompt: string, sources: CanvasNodeData[], explicitCodes: string[] = [], renderContent?: (node: CanvasNodeData) => string) {
    const documents = productionAssetDocuments(sources);
    const codes = [...new Set([...explicitCodes, ...Array.from(prompt.matchAll(/@((?:CHR|SCN|PRP|SPC|AUD)-\d+(?:-V\d+)?)(?![A-Za-z0-9_-])/g), (match) => match[1])])];
    const references = codes.map((code) => {
        const base = code.replace(/-V\d+$/, "");
        const node = documents.find((item) => item.metadata!.shortDrama!.assetIdentity!.code === base) ||
            sources.find((item) => item.metadata?.shortDrama?.assetProfile && (item.metadata.shortDrama.assetKey === code || item.title === code));
        if (!node || !node.metadata?.content?.trim() || node.metadata.status === "error" || node.metadata.status === "loading") throw new Error(`资产引用不存在或未完成：${code}`);
        const variant = code !== base ? node.metadata.shortDrama?.assetProfile?.variants.find((item) => item.code === code) : undefined;
        if (code !== base && !variant) throw new Error(`资产状态不存在：${code}`);
        return { node, code, variant };
    });
    const nodes = [...new Map(references.map((entry) => [entry.node.id, entry.node])).values()];
    const content = nodes.map((node) => {
        const data = node.metadata!.shortDrama!;
        const variants = references.filter((entry) => entry.node.id === node.id && entry.variant).map((entry) => `${entry.code} ${entry.variant!.name}：${entry.variant!.description}`);
        const body = renderContent ? renderContent(node) : node.metadata!.content;
        if (!body && !variants.length) return "";
        return `${data.assetIdentity?.code || data.assetKey} · ${node.title}\n${body}${variants.length ? `\n指定状态：\n${variants.join("\n")}` : ""}`;
    }).filter(Boolean).join("\n\n");
    return { nodes, content, codes };
}
