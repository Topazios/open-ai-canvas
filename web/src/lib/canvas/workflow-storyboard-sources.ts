import type { CanvasNodeData } from "@/types/canvas";
import { ShortDramaStep } from "../short-drama-steps";

/** Storyboard splitting consumes the selected body snapshot, not its workflow status. */
export function storyboardBodyMembers(source: CanvasNodeData | undefined, nodes: CanvasNodeData[], pipelineId: string) {
    const data = source?.metadata?.shortDrama;
    if (!source || data?.pipelineId !== pipelineId || data.step !== ShortDramaStep.Body) return [];
    const members = data.role === "collection" ? nodes.filter(node => data.sourceNodeIds.includes(node.id)) : [source];
    return members.filter(node => {
        const entry = node.metadata?.shortDrama;
        return entry?.pipelineId === pipelineId && entry.step === ShortDramaStep.Body && entry.role === "document"
            && Number.isInteger(entry.episodeNumber) && entry.episodeNumber! > 0 && Boolean(node.metadata?.content?.trim());
    });
}

export function storyboardGenerationSources(sourceIds: string[], nodes: CanvasNodeData[], pipelineId: string) {
    const selected = sourceIds.map(id => nodes.find(node => node.id === id));
    if (selected.some(node => !node || node.metadata?.shortDrama?.pipelineId !== pipelineId)) throw new Error("分镜来源已删除或不属于当前制作流程");
    const bodySources = selected.filter(node => node?.metadata?.shortDrama?.step === ShortDramaStep.Body);
    if (bodySources.length !== 1) throw new Error("请选择一个分集正文节点或正文容器");
    const bodies = storyboardBodyMembers(bodySources[0], nodes, pipelineId);
    if (!bodies.length) throw new Error("所选来源暂无正文内容，请先生成对应集正文");
    const episodes = bodies.map(node => node.metadata!.shortDrama!.episodeNumber!);
    if (new Set(episodes).size !== episodes.length) throw new Error("所选正文容器同一集有多个版本，请选择一个版本");
    const scenes = selected.filter(node => node?.metadata?.shortDrama?.step === ShortDramaStep.Scenes).flatMap(node => {
        const data = node!.metadata!.shortDrama!;
        return data.role === "collection" ? nodes.filter(member => data.sourceNodeIds.includes(member.id) && member.parentId === node!.id) : [node!];
    }).filter(node => node.metadata?.shortDrama?.pipelineId === pipelineId && node.metadata.shortDrama.step === ShortDramaStep.Scenes && episodes.includes(node.metadata.shortDrama.episodeNumber!) && node.metadata?.content?.trim());
    // Keep available production context on this branch, but never make an
    // optional document, stale lineage or another body a prerequisite.
    const context = new Map<string, CanvasNodeData>();
    const visited = new Set(bodies.map(node => node.id));
    const visit = (id: string) => {
        if (visited.has(id)) return;
        visited.add(id);
        const node = nodes.find(item => item.id === id);
        const data = node?.metadata?.shortDrama;
        if (!node || data?.pipelineId !== pipelineId || data.step === ShortDramaStep.Body || data.screenplayAudit || data.screenplayRepair) return;
        data.sourceNodeIds.forEach(visit);
        if (node.metadata?.content?.trim() && data.role !== "collection") context.set(id, node);
    };
    bodies.forEach(body => body.metadata!.shortDrama!.sourceNodeIds.forEach(visit));
    return [...context.values(), ...(bodySources[0]!.metadata!.shortDrama!.role === "collection" ? [bodySources[0]!] : []), ...bodies, ...scenes];
}
