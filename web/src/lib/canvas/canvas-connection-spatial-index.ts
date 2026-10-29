import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { buildCanvasSpatialIndex, type CanvasSpatialIndex, type CanvasSpatialIndexEntry } from "./canvas-spatial-index";
import { measureCanvasComputation } from "./canvas-performance-diagnostics";
import { CONNECTION_CURVE_PADDING } from "./canvas-connection-routing";
import { isStoryboardFrameRecord } from "./storyboard-frame-records";

type ConnectionGeometryNode = {
    id: string; x: number; y: number; width: number; height: number;
    parentId?: string; frame: boolean; frameCollapsed: boolean; workflowCollection: boolean;
    batchRootId?: string; batchExpanded: boolean; storyboardFrameRecord: boolean;
};
export type CanvasConnectionSpatialIndex = {
    geometry: ConnectionGeometryNode[];
    connections: CanvasConnection[];
    index: CanvasSpatialIndex<string>;
    endpointsById: Map<string, { fromNodeId: string; toNodeId: string }>;
    connectionIdsByNodeId: Map<string, Set<string>>;
    memberIdsByConnectionId: Map<string, Set<string>>;
};

export function buildCanvasConnectionSpatialIndex(nodes: CanvasNodeData[], connections: CanvasConnection[], previous?: CanvasConnectionSpatialIndex): CanvasConnectionSpatialIndex {
    if (previous?.connections === connections && previous.geometry.length === nodes.length && nodes.every((node, index) => {
        const old = previous.geometry[index];
        return old.id === node.id && old.x === node.position.x && old.y === node.position.y && old.width === node.width && old.height === node.height &&
            old.parentId === node.parentId && old.frame === (node.type === CanvasNodeType.Frame) && old.frameCollapsed === Boolean(node.metadata?.frame?.collapsed) &&
            old.workflowCollection === (node.metadata?.shortDrama?.role === "collection") &&
            old.batchRootId === node.metadata?.batchRootId && old.batchExpanded === Boolean(node.metadata?.imageBatchExpanded) && old.storyboardFrameRecord === isStoryboardFrameRecord(node);
    })) return previous;
    return measureCanvasComputation("connection-spatial-index", () => {
        const geometry: ConnectionGeometryNode[] = nodes.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y, width: node.width, height: node.height,
            parentId: node.parentId, frame: node.type === CanvasNodeType.Frame, frameCollapsed: Boolean(node.metadata?.frame?.collapsed), workflowCollection: node.metadata?.shortDrama?.role === "collection",
            batchRootId: node.metadata?.batchRootId, batchExpanded: Boolean(node.metadata?.imageBatchExpanded), storyboardFrameRecord: isStoryboardFrameRecord(node) }));
        const byId = new Map(geometry.map((node) => [node.id, node]));
        const entries: CanvasSpatialIndexEntry<string>[] = [];
        const endpointsById = new Map<string, { fromNodeId: string; toNodeId: string }>();
        const connectionIdsByNodeId = new Map<string, Set<string>>();
        const memberIdsByConnectionId = new Map<string, Set<string>>();
        const collectionPairs = new Map<string, string>();
        const batchHidden = (node: ConnectionGeometryNode) => {
            const root = node.batchRootId ? byId.get(node.batchRootId) : undefined;
            return root && !root.batchExpanded;
        };
        const representative = (node: ConnectionGeometryNode) => {
            const parent = node.parentId ? byId.get(node.parentId) : undefined;
            return parent?.frame && (parent.frameCollapsed || parent.workflowCollection) ? parent : node;
        };
        for (const connection of connections) {
            const from = byId.get(connection.fromNodeId), to = byId.get(connection.toNodeId);
            // Frame task records are deliberately not rendered on the canvas.
            // Exclude their links before the viewport query applies its render budget.
            if (!from || !to || from.storyboardFrameRecord || to.storyboardFrameRecord || batchHidden(from) || batchHidden(to)) continue;
            const displayFrom = representative(from), displayTo = representative(to);
            if (displayFrom.id === displayTo.id) continue;
            // Keep per-document provenance, but expose one selectable/deletable link per collection pair.
            const pair = displayFrom.workflowCollection || displayTo.workflowCollection ? JSON.stringify([displayFrom.id, displayTo.id]) : undefined;
            const displayId = (pair && collectionPairs.get(pair)) || connection.id;
            if (pair) collectionPairs.set(pair, displayId);
            const members = memberIdsByConnectionId.get(displayId) || new Set<string>();
            members.add(connection.id); memberIdsByConnectionId.set(displayId, members);
            if (displayId === connection.id) {
                entries.push({ id: displayId, value: displayId, bounds: {
                    left: Math.min(displayFrom.x, displayTo.x) - CONNECTION_CURVE_PADDING,
                    top: Math.min(displayFrom.y, displayTo.y) - CONNECTION_CURVE_PADDING,
                    right: Math.max(displayFrom.x + displayFrom.width, displayTo.x + displayTo.width) + CONNECTION_CURVE_PADDING,
                    bottom: Math.max(displayFrom.y + displayFrom.height, displayTo.y + displayTo.height) + CONNECTION_CURVE_PADDING,
                } });
                endpointsById.set(displayId, { fromNodeId: displayFrom.id, toNodeId: displayTo.id });
            }
            for (const nodeId of new Set([from.id, to.id, displayFrom.id, displayTo.id])) {
                const ids = connectionIdsByNodeId.get(nodeId);
                if (ids) ids.add(displayId); else connectionIdsByNodeId.set(nodeId, new Set([displayId]));
            }
        }
        return { geometry, connections, index: buildCanvasSpatialIndex(entries), endpointsById, connectionIdsByNodeId, memberIdsByConnectionId };
    });
}

export function removeCanvasDisplayConnection(nodes: CanvasNodeData[], connections: CanvasConnection[], id: string) {
    const index = buildCanvasConnectionSpatialIndex(nodes, connections);
    const ids = index.memberIdsByConnectionId.get(id) || new Set([id]);
    return connections.filter((edge) => !ids.has(edge.id));
}

export function resolveCanvasDisplayConnections(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const index = buildCanvasConnectionSpatialIndex(nodes, connections);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return connections.flatMap((connection) => {
        const endpoints = index.endpointsById.get(connection.id);
        return endpoints ? [{ connection, from: byId.get(endpoints.fromNodeId)!, to: byId.get(endpoints.toNodeId)! }] : [];
    });
}
