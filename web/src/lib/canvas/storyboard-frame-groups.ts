import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { isLegacyStoryboardFrameContainer, isStoryboardFrameRecord } from "./storyboard-frame-records";

/** Retire legacy presentation containers without deleting frame media or task receipts. */
export function reconcileStoryboardFramesGroups(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const groups = new Set(nodes.filter(node => node.metadata?.storyboardFramesGroup || isLegacyStoryboardFrameContainer(node)).map(node => node.id));
    const next = groups.size ? nodes.filter(node => !groups.has(node.id)).map(node =>
        node.parentId && groups.has(node.parentId) ? { ...node, parentId: undefined } : node) : nodes;
    const records = new Set(nodes.filter(isStoryboardFrameRecord).map(node => node.id));
    const edges = connections.filter(edge => !records.has(edge.fromNodeId) && !records.has(edge.toNodeId));
    return { nodes: next, connections: edges.length === connections.length ? connections : edges };
}
