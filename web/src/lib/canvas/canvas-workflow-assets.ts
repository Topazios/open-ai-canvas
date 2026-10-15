import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { ShortDramaStep, type WorkflowAssetProfile } from "../short-drama-steps";
import { parseAssetProfile } from "./canvas-workflow-asset-profile";
import { legacyProductionBibleKeys, productionBibleSection, type ProductionBibleSection } from "../production-bible";

export const assetGroupOutputInstruction = `本步骤必须只输出一个 JSON 对象，不加 Markdown 围栏：
{"summary":"覆盖集数、归并情况、冲突及待确认项", "items":[{"name":"唯一资产名称", "content":"完整 Markdown 文稿，含正文依据、出现集数场次、固定特征、状态变体、可直接使用的完整提示词、负面约束及待确认项"}]}
每个独立资产一个条目，合并别名和跨集重复项，名称不得重复；没有该类资产时 items 为 []，summary 说明依据。不要为凑数量虚构资产。最多 200 项，超出时明确报告范围不足，不假称完整。`;

export function emptyWorkflowAssetManifest(nodes: CanvasNodeData[], id: string) {
    const anchor = nodes.find((node) => node.id === id);
    const manifest = anchor?.metadata?.shortDrama?.assetGroup ? nodes.find((node) => node.id === anchor.metadata!.shortDrama!.assetGroup!.manifestId) : anchor;
    const data = manifest?.metadata?.shortDrama;
    if (!manifest || !data?.materializedTaskId || data.assetOutput) return;
    const frame = nodes.find((node) => node.id === manifest.parentId && node.metadata?.shortDrama?.assetGroup?.manifestId === manifest.id);
    if (!frame || nodes.some((node) => node.id !== manifest.id && node.parentId === frame.id && node.metadata?.shortDrama?.assetKey)) return;
    return manifest;
}

export function restoreEmptyWorkflowAssetGroup(nodes: CanvasNodeData[], id: string): CanvasNodeData[] {
    const manifest = emptyWorkflowAssetManifest(nodes, id);
    const data = manifest?.metadata?.shortDrama;
    if (!manifest || !data) return nodes;
    return nodes.map((node) => node.id === id ? { ...node, metadata: { ...node.metadata, shortDrama: { ...data, assetOutput: true, materializedTaskId: undefined } } } : node);
}

export function parseWorkflowAssetGroup(content: string, mode?: "bible" | "assets", requiredSections: readonly ProductionBibleSection[] = legacyProductionBibleKeys): { summary: string; items: { name: string; content: string; section?: ProductionBibleSection; profile?: WorkflowAssetProfile }[] } {
    const text = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error("模型未返回完整的资产分组 JSON"); }
    if (!value || typeof value !== "object" || !("summary" in value) || typeof value.summary !== "string" || !value.summary.trim() || !("items" in value) || !Array.isArray(value.items) || value.items.length > 200) throw new Error("资产分组缺少提取说明或条目格式无效");
    const names = new Set<string>();
    const items = value.items.map((item: unknown) => {
        if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 200 || !("content" in item) || typeof item.content !== "string" || !item.content.trim()) throw new Error("资产条目缺少名称或完整提示词正文");
        const key = item.name.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();
        if (names.has(key)) throw new Error(`资产名称重复：${item.name}，请归并后重新生成`);
        names.add(key);
        const record = item as Record<string, unknown>;
        const section = mode === "bible" ? record.section : undefined;
        if (mode === "bible" && !productionBibleSection(section)) throw new Error("制作规范条目必须标注有效的分类 section");
        return { name: item.name.trim(), content: item.content.trim(), section: section as ProductionBibleSection | undefined,
            profile: mode === "assets" ? parseAssetProfile(record, item.content.trim()) : undefined };
    });
    if (mode === "bible" && (items.length !== requiredSections.length || new Set(items.map((item) => item.section)).size !== requiredSections.length || requiredSections.some((key) => !items.some((item) => item.section === key)))) throw new Error("统一制作规范必须同时包含所有要求的分类文稿");
    return { summary: value.summary.trim(), items };
}

// Pure and deterministic: durable persistence and live-state replay produce the same children.
export function materializeWorkflowAssetGroup(nodes: CanvasNodeData[], manifest: CanvasNodeData, taskId: string): CanvasNodeData[] {
    const data = manifest.metadata?.shortDrama;
    if (!data?.assetOutput || manifest.metadata?.status !== "success") return nodes;
    const frame = nodes.find((node) => node.id === manifest.parentId && node.metadata?.shortDrama?.assetGroup?.manifestId === manifest.id);
    if (!frame) throw new Error("资产分组容器已删除或节点已移出，结果仍保留在任务中心");
    let parsed: ReturnType<typeof parseWorkflowAssetGroup>;
    try {
        parsed = parseWorkflowAssetGroup(manifest.metadata.content || "", data.step === ShortDramaStep.Bible ? "bible" : data.assetSchemaVersion === 2 ? "assets" : undefined, frame.metadata?.shortDrama?.assetGroup?.sections);
        const episodes = new Set(nodes.filter((node) => data.sourceSignatures[node.id] && (node.metadata?.shortDrama?.step === ShortDramaStep.Body || node.metadata?.storyDevelopment?.stage === "body")).map((node) => node.metadata?.shortDrama?.episodeNumber ?? node.metadata?.storyDevelopment?.episodeNumber));
        if (parsed.items.some((item) => item.profile?.occurrences.some((entry) => !episodes.has(entry.episode)))) throw new Error("资产出场记录引用了未提供的正文集数");
    }
    catch (error) {
        return nodes.map((node) => node.id === manifest.id ? { ...node, metadata: { ...node.metadata, status: "error", errorDetails: `${(error as Error).message}。原始结果已保留，可编辑检查或生成另一版。`, shortDrama: { ...data, materializedTaskId: taskId } } } : node);
    }
    const columns = Math.min(3, parsed.items.length + 1);
    const cellWidth = Math.max(400, manifest.width) + 24;
    const cellHeight = Math.max(280, manifest.height) + 24;
    const width = Math.max(frame.width, frame.metadata?.frame?.expandedWidth || 0, columns * cellWidth + 24);
    const height = Math.max(frame.height, frame.metadata?.frame?.expandedHeight || 0, 100 + Math.ceil((parsed.items.length + 1) / columns) * cellHeight);
    let position = frame.position;
    const others = nodes.filter((node) => node.id !== frame.id && node.parentId !== frame.id);
    let overlaps: CanvasNodeData[];
    // Concurrent groups may have been placed below a still-small pending group.
    while ((overlaps = others.filter((node) => node.position.x < position.x + width && node.position.x + node.width > position.x && node.position.y < position.y + height && node.position.y + node.height > position.y)).length) {
        position = { ...position, y: Math.max(...overlaps.map((node) => node.position.y + node.height)) + 64 };
    }
    const children: CanvasNodeData[] = parsed.items.map((item, index) => ({
        id: `${manifest.id}:asset:${index + 1}`, type: CanvasNodeType.Text, title: item.name,
        parentId: frame.id, width: 400, height: 280, createdAt: manifest.createdAt, updatedAt: manifest.updatedAt,
        position: { x: position.x + 24 + ((index + 1) % columns) * cellWidth, y: position.y + 100 + Math.floor((index + 1) / columns) * cellHeight },
        metadata: { content: item.content, status: "success", generationMode: "text", model: manifest.metadata?.model,
            workflowTitle: manifest.metadata?.workflowTitle,
            shortDrama: { stage: data.stage, step: productionBibleSection(item.section)?.step || data.step, pipelineId: data.pipelineId, role: "document", assetKey: item.section || `${index + 1}`, ...(item.section ? { bibleSection: item.section } : {}),
                ...(item.profile ? { assetProfile: item.profile, assetSchemaVersion: 2 as const } : {}),
                sourceNodeIds: [...data.sourceNodeIds], sourceSignatures: { ...data.sourceSignatures }, sourceSteps: data.sourceSteps ? [...data.sourceSteps] : undefined,
                parameters: data.parameters, version: data.version },
        },
    }));
    if (children.some((child) => nodes.some((node) => node.id === child.id))) throw new Error("资产分组已有同标识节点，未覆盖已有内容");
    return [...nodes.map((node) => {
        if (node.id === manifest.id) return { ...node, position: { x: node.position.x, y: node.position.y + position.y - frame.position.y }, metadata: { ...node.metadata, content: parsed.summary, richText: undefined, shortDrama: { ...data, assetOutput: false, materializedTaskId: taskId } } };
        if (node.id !== frame.id) return node;
        const collapsed = frame.metadata?.frame?.collapsed;
        return { ...frame, position, width: collapsed ? frame.width : width, height: collapsed ? frame.height : height,
            metadata: { ...frame.metadata, frame: { collapsed: false, ...frame.metadata?.frame, expandedWidth: width, expandedHeight: height },
                shortDrama: { ...frame.metadata!.shortDrama!, sourceNodeIds: [manifest.id, ...children.map((child) => child.id)] } } };
    }), ...children];
}
