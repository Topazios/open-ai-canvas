import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { nodeSizeFromRatio } from "./canvas-node-size";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { isStoryboardFrameRecord } from "./storyboard-frame-records";

export const WORKFLOW_IMAGE_GRID = { size: 280, columns: 3, gapX: 24, gapY: 48, padding: 24, top: 88 } as const;
// The story outline spans the full row above the specification cards (mirrors productionLayoutPlanGroup on the backend).
export const PLAN_LEAD = { top: 100, height: 320, gap: 40 } as const;

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

/** The story outline document that leads a production-plan container; placeholders only carry assetKey. */
export function isPlanLeadNode(node: CanvasNodeData) {
    const workflow = node.metadata?.shortDrama;
    if (!workflow || workflow.planGroup) return false;
    return workflow.assetKey === "story" || (workflow.planSection === "story" && workflow.role === "document");
}

export function groupGridMetrics(frame: CanvasNodeData, members: CanvasNodeData[]) {
    const images = frame.metadata?.shortDrama?.mediaKind === "image" && Boolean(frame.metadata?.shortDrama?.mediaGroup);
    const reference = frame.metadata?.workflowKind === "reference_set";
    // Production-plan containers always lay documents out three per row, whatever width an older local copy kept.
    const planGrid = !images && frame.metadata?.shortDrama?.step === "story.plan" && Boolean(frame.metadata.shortDrama.assetGroup);
    // The story outline is a full-width lead card; it must not widen the cells of the specification cards below it.
    const lead = planGrid && !frame.metadata?.shortDrama?.planGroup ? members.find(isPlanLeadNode) : undefined;
    const cards = lead ? members.filter(node => node !== lead) : members;
    const referenceOrder = new Map((frame.metadata?.referenceAssetNodeIds || []).map((id, index) => [id, index]));
    const size = reference ? [...cards].sort((a, b) => (referenceOrder.get(a.id) ?? Infinity) - (referenceOrder.get(b.id) ?? Infinity) || a.id.localeCompare(b.id))
        .map(node => node.metadata?.size ? nodeSizeFromRatio(node.metadata.size, NODE_DEFAULT_SIZE[CanvasNodeType.Image].width, NODE_DEFAULT_SIZE[CanvasNodeType.Image].height) : undefined).find(Boolean) : undefined;
    const cellWidth = images ? WORKFLOW_IMAGE_GRID.size : planGrid ? Math.max(400, ...cards.map(node => node.width)) : size?.width || Math.max(1, ...cards.map(node => node.width));
    const cellHeight = images ? WORKFLOW_IMAGE_GRID.size : size?.height || Math.max(1, ...cards.map(node => node.height));
    // Text titles sit outside the node body; reserve room above the next row.
    const { gapX, padding } = WORKFLOW_IMAGE_GRID;
    const gapY = images ? WORKFLOW_IMAGE_GRID.gapY : 56;
    const baseTop = frame.metadata?.shortDrama?.role === "collection" && !images ? 100 : WORKFLOW_IMAGE_GRID.top;
    const top = lead ? PLAN_LEAD.top + PLAN_LEAD.height + PLAN_LEAD.gap : baseTop;
    const settings = frame.metadata?.frame;
    const defaultImageColumns = Math.min(WORKFLOW_IMAGE_GRID.columns, Math.max(1, cards.length));
    const planWidth = padding * 2 + WORKFLOW_IMAGE_GRID.columns * cellWidth + (WORKFLOW_IMAGE_GRID.columns - 1) * gapX;
    // A plan container never grows past three columns; a stale wider gridWidth would otherwise stretch it into a thin strip.
    const stored = planGrid && settings?.gridWidth !== undefined ? Math.min(settings.gridWidth, planWidth) : settings?.gridWidth;
    const available = stored ?? (images
        ? padding * 2 + defaultImageColumns * cellWidth + (defaultImageColumns - 1) * gapX
        : planGrid ? planWidth
        : settings?.collapsed ? settings.expandedWidth : frame.width);
    const width = Math.max(cellWidth + padding * 2, Number.isFinite(available) ? available : cellWidth + padding * 2);
    const columns = Math.max(1, Math.floor((width - padding * 2 + gapX + 0.001) / (cellWidth + gapX)));
    const rows = cards.length ? Math.ceil(cards.length / columns) : lead ? 0 : 1;
    const rowsHeight = rows ? rows * cellHeight + (rows - 1) * gapY : 0;
    const height = Math.max(240, top + rowsHeight + padding);
    return { width, height, columns, cellWidth, cellHeight, gapX, gapY, padding, top, images, reference, lead };
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
        const cards = grid.lead ? members.filter(node => node !== grid.lead) : members;
        if (grid.lead) {
            const lead = grid.lead;
            const position = { x: frame.position.x + grid.padding, y: frame.position.y + PLAN_LEAD.top };
            const width = grid.width - grid.padding * 2, height = PLAN_LEAD.height;
            if (lead.position.x !== position.x || lead.position.y !== position.y || lead.width !== width || lead.height !== height)
                patches.set(lead.id, { ...lead, position, width, height });
        }
        cards.forEach((node, index) => {
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
    const grid = groupGridMetrics(frame, members);
    const cards = grid.lead ? members.filter(node => node !== grid.lead) : members;
    const moving = cards.filter(node => dragged.has(node.id));
    if (!moving.length) return grid.lead && dragged.has(grid.lead.id) ? layoutCanvasGridGroups(nodes, new Set([frame.id])) : nodes;
    const first = moving[0];
    const column = Math.max(0, Math.min(grid.columns - 1, Math.round((first.position.x - frame.position.x - grid.padding) / (grid.cellWidth + grid.gapX))));
    const row = Math.max(0, Math.round((first.position.y - frame.position.y - grid.top) / (grid.cellHeight + grid.gapY)));
    const order = cards.filter(node => !dragged.has(node.id)).map(node => node.id);
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
