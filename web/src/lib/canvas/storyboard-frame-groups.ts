import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { createCanvasNode } from "./canvas-project-domain";

function groupOwner(group: CanvasNodeData, nodes: CanvasNodeData[]) {
    const binding = group.metadata?.storyboardFramesGroup;
    if (!binding || group.type !== CanvasNodeType.Frame) return undefined;
    const script = nodes.find(node => node.id === binding.scriptId);
    const children = nodes.filter(node => node.parentId === group.id);
    const owners = [script?.metadata?.shortDrama, ...children.map(node => node.metadata?.shortDrama)].filter(Boolean);
    const pipelineId = binding.pipelineId || owners[0]?.pipelineId;
    const episodeNumber = binding.episodeNumber ?? owners[0]?.episodeNumber;
    if (!pipelineId || !episodeNumber || owners.some(owner => owner?.pipelineId !== pipelineId || owner.episodeNumber !== episodeNumber)) return undefined;
    return { pipelineId, episodeNumber, key: `${pipelineId}:${episodeNumber}` };
}

/** Merge only proven episode frame groups; child IDs, tasks and script-version bindings survive. */
export function reconcileStoryboardFramesGroups(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const owners = new Map<string, CanvasNodeData>();
    const aliases = new Map<string, string>();
    const patches = new Map<string, CanvasNodeData>();
    for (const group of nodes) {
        const owner = groupOwner(group, nodes);
        if (!owner || group.metadata?.locked) continue;
        const canonical = owners.get(owner.key);
        if (canonical) { aliases.set(group.id, canonical.id); continue; }
        owners.set(owner.key, group);
        const binding = group.metadata!.storyboardFramesGroup!;
        if (binding.pipelineId !== owner.pipelineId || binding.episodeNumber !== owner.episodeNumber) patches.set(group.id, {
            ...group, metadata: { ...group.metadata, storyboardFramesGroup: { ...binding, pipelineId: owner.pipelineId, episodeNumber: owner.episodeNumber } },
        });
    }
    if (!aliases.size && !patches.size) return { nodes, connections };
    const next = nodes.filter(node => !aliases.has(node.id)).map(node => {
        const value = patches.get(node.id) || node;
        const parentId = value.parentId && aliases.get(value.parentId);
        return parentId ? { ...value, parentId } : value;
    });
    const seen = new Set<string>();
    const edges = connections.flatMap(edge => {
        const fromNodeId = aliases.get(edge.fromNodeId) || edge.fromNodeId;
        const toNodeId = aliases.get(edge.toNodeId) || edge.toNodeId;
        const key = JSON.stringify([fromNodeId, toNodeId, edge.relation, edge.storyboardRowId, edge.fromHandleId, edge.toHandleId]);
        if (fromNodeId === toNodeId || seen.has(key)) return [];
        seen.add(key);
        return [fromNodeId === edge.fromNodeId && toNodeId === edge.toNodeId ? edge : { ...edge, fromNodeId, toNodeId }];
    });
    return { nodes: next, connections: aliases.size ? edges : connections };
}

export function ensureStoryboardFramesGroup(script: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const reconciled = reconcileStoryboardFramesGroups(nodes, connections);
    const data = script.metadata?.shortDrama;
    const key = data?.pipelineId && data.episodeNumber ? `${data.pipelineId}:${data.episodeNumber}` : undefined;
    const existing = reconciled.nodes.find(node => key ? groupOwner(node, reconciled.nodes)?.key === key : node.metadata?.storyboardFramesGroup?.scriptId === script.id);
    if (existing) return {
        ...reconciled, group: existing,
        connections: reconciled.connections.some(edge => edge.fromNodeId === script.id && edge.toNodeId === existing.id) ? reconciled.connections : [...reconciled.connections, { id: `storyboard-frames-link:${script.id}`, fromNodeId: script.id, toNodeId: existing.id }],
    };
    const group = createCanvasNode(CanvasNodeType.Frame, { x: script.position.x + script.width + 120, y: script.position.y });
    group.id = `storyboard-frames:${key || script.id}`;
    group.title = `第 ${data?.episodeNumber || 1} 集 · 镜头帧`;
    group.width = 960;
    group.metadata = { ...group.metadata, storyboardFramesGroup: { scriptId: script.id, pipelineId: data?.pipelineId, episodeNumber: data?.episodeNumber }, frame: { layout: "grid", gridWidth: 960, collapsed: false, expandedWidth: 960, expandedHeight: 400 } };
    return { nodes: [...reconciled.nodes, group], connections: [...reconciled.connections, { id: `storyboard-frames-link:${script.id}`, fromNodeId: script.id, toNodeId: group.id }], group };
}
