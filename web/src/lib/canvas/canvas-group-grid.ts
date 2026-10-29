import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { nodeSizeFromRatio } from "./canvas-node-size";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { isStoryboardFrameRecord } from "./storyboard-frame-records";

export const WORKFLOW_IMAGE_GRID = { size: 280, columns: 3, gapX: 24, gapY: 48, padding: 24, top: 88 } as const;

export function isGridFrame(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Frame && !node.metadata?.folder && (
        node.metadata?.frame?.layout === "grid" || node.metadata?.shortDrama?.role === "collection" ||
        node.metadata?.workflowKind === "storyboard" || node.metadata?.workflowKind === "reference_set"
    );
}

function visibleMembers(frame: CanvasNodeData, members: CanvasNodeData[]) {
    return members.filter(node => !isStoryboardFrameRecord(node) && !(node.id === frame.metadata?.shortDrama?.assetGroup?.manifestId &&
        node.metadata?.shortDrama?.assetKey === "$summary"));
}

export function groupGridMetrics(frame: CanvasNodeData, members: CanvasNodeData[]) {
    const images = frame.metadata?.shortDrama?.mediaKind === "image" && Boolean(frame.metadata?.shortDrama?.mediaGroup);
    const reference = frame.metadata?.workflowKind === "reference_set";
    const referenceOrder = new Map((frame.metadata?.referenceAssetNodeIds || []).map((id, index) => [id, index]));
    const size = reference ? [...members].sort((a, b) => (referenceOrder.get(a.id) ?? Infinity) - (referenceOrder.get(b.id) ?? Infinity) || a.id.localeCompare(b.id))
        .map(node => node.metadata?.size ? nodeSizeFromRatio(node.metadata.size, NODE_DEFAULT_SIZE[CanvasNodeType.Image].width, NODE_DEFAULT_SIZE[CanvasNodeType.Image].height) : undefined).find(Boolean) : undefined;
    const cellWidth = images ? WORKFLOW_IMAGE_GRID.size : size?.width || Math.max(1, ...members.map(node => node.width));
    const cellHeight = images ? WORKFLOW_IMAGE_GRID.size : size?.height || Math.max(1, ...members.map(node => node.height));
    // Text titles sit outside the node body; reserve room above the next row.
    const { gapX, padding } = WORKFLOW_IMAGE_GRID;
    const gapY = images ? WORKFLOW_IMAGE_GRID.gapY : 56;
    const top = frame.metadata?.shortDrama?.role === "collection" && !images ? 100 : WORKFLOW_IMAGE_GRID.top;
    const settings = frame.metadata?.frame;
    const defaultImageColumns = Math.min(WORKFLOW_IMAGE_GRID.columns, Math.max(1, members.length));
    const available = settings?.gridWidth ?? (images
        ? padding * 2 + defaultImageColumns * cellWidth + (defaultImageColumns - 1) * gapX
        : settings?.collapsed ? settings.expandedWidth : frame.width);
    const width = Math.max(cellWidth + padding * 2, Number.isFinite(available) ? available : cellWidth + padding * 2);
    const columns = Math.max(1, Math.floor((width - padding * 2 + gapX + 0.001) / (cellWidth + gapX)));
    const rows = Math.max(1, Math.ceil(members.length / columns));
    const workflow = frame.metadata?.shortDrama;
    const footer = workflow?.step === "story.plan" && !workflow.planGroup ? 36 : 0;
    const height = Math.max(240, top + rows * cellHeight + (rows - 1) * gapY + padding + footer);
    return { width, height, columns, cellWidth, cellHeight, gapX, gapY, padding, top, images, reference };
}

function orderedMembers(frame: CanvasNodeData, members: CanvasNodeData[]) {
    const order = new Map((frame.metadata?.frame?.gridOrder || frame.metadata?.shortDrama?.sourceNodeIds || frame.metadata?.referenceAssetNodeIds || []).map((id, index) => [id, index]));
    return visibleMembers(frame, members).sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) ||
        (a.metadata?.shortDrama?.episodeNumber ?? Infinity) - (b.metadata?.shortDrama?.episodeNumber ?? Infinity));
}

/** Pure layout shared by creation, task updates, resize, drop and restore. */
export function layoutCanvasGridGroups(nodes: CanvasNodeData[], groupIds?: ReadonlySet<string>): CanvasNodeData[] {
    const byParent = new Map<string, CanvasNodeData[]>();
    for (const node of nodes) if (node.parentId) {
        const members = byParent.get(node.parentId) || [];
        members.push(node); byParent.set(node.parentId, members);
    }
    const patches = new Map<string, CanvasNodeData>();
    for (const frame of nodes) {
        if (!isGridFrame(frame) || frame.metadata?.locked || (groupIds && !groupIds.has(frame.id))) continue;
        const members = orderedMembers(frame, byParent.get(frame.id) || []);
        if (!members.length || members.some(node => node.metadata?.locked || node.type === CanvasNodeType.Frame)) continue;
        const grid = groupGridMetrics(frame, members);
        members.forEach((node, index) => {
            const position = { x: frame.position.x + grid.padding + (index % grid.columns) * (grid.cellWidth + grid.gapX),
                y: frame.position.y + grid.top + Math.floor(index / grid.columns) * (grid.cellHeight + grid.gapY) };
            const image = (grid.images && node.type === CanvasNodeType.Image) || grid.reference;
            const width = image ? grid.cellWidth : node.width, height = image ? grid.cellHeight : node.height;
            if (node.position.x === position.x && node.position.y === position.y && node.width === width && node.height === height &&
                (!image || (node.metadata?.manualSize && !node.metadata.freeResize))) return;
            patches.set(node.id, { ...node, position, width, height,
                ...(image ? { metadata: { ...node.metadata, manualSize: true, freeResize: false } } : {}) });
        });
        const settings = frame.metadata?.frame;
        const width = settings?.collapsed ? frame.width : grid.width, height = settings?.collapsed ? frame.height : grid.height;
        if (frame.width === width && frame.height === height && settings?.expandedWidth === grid.width && settings.expandedHeight === grid.height) continue;
        patches.set(frame.id, { ...frame, width, height, metadata: { ...frame.metadata,
            frame: { ...settings, collapsed: settings?.collapsed || false, expandedWidth: grid.width, expandedHeight: grid.height } } });
    }
    return patches.size ? nodes.map(node => patches.get(node.id) || node) : nodes;
}

/** Keep semantic source order intact; only presentation order changes when dropping. */
export function snapGridDrop(nodes: CanvasNodeData[], dragged: ReadonlySet<string>, frame: CanvasNodeData) {
    const members = orderedMembers(frame, nodes.filter(node => node.parentId === frame.id));
    const moving = members.filter(node => dragged.has(node.id));
    if (!moving.length) return nodes;
    const grid = groupGridMetrics(frame, members);
    const first = moving[0];
    const column = Math.max(0, Math.min(grid.columns - 1, Math.round((first.position.x - frame.position.x - grid.padding) / (grid.cellWidth + grid.gapX))));
    const row = Math.max(0, Math.round((first.position.y - frame.position.y - grid.top) / (grid.cellHeight + grid.gapY)));
    const order = members.filter(node => !dragged.has(node.id)).map(node => node.id);
    order.splice(Math.min(order.length, row * grid.columns + column), 0, ...moving.map(node => node.id));
    return layoutCanvasGridGroups(nodes.map(node => node.id === frame.id ? { ...node, metadata: { ...node.metadata,
        frame: { collapsed: false, expandedWidth: frame.width, expandedHeight: frame.height, ...node.metadata?.frame, gridOrder: order } } } : node));
}

export function restoreGroupResize(nodes: CanvasNodeData[], before: CanvasNodeData[], frameId: string) {
    const originals = new Map(before.map(node => [node.id, node]));
    return nodes.map(node => {
        const original = originals.get(node.id);
        if (!original || (node.id !== frameId && (node.parentId !== frameId || original.parentId !== frameId))) return node;
        return { ...node, position: original.position, width: original.width, height: original.height,
            metadata: { ...node.metadata, manualSize: original.metadata?.manualSize,
                ...(node.id === frameId ? { frame: original.metadata?.frame } : {}) } };
    });
}
