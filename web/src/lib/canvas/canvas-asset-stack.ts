import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { findAvailableGenerationGroupPosition } from "./canvas-generation-layout";
import { currentAssetMembers } from "./canvas-asset-versions";

export const ASSET_STACK_WIDTH = 360;
export const ASSET_STACK_HEIGHT = 300;
export const ASSET_STACK_PREVIEW_LIMIT = 3;

export function isCanvasAssetStack(node: CanvasNodeData) {
    const workflow = node.metadata?.shortDrama;
    if (node.type !== CanvasNodeType.Frame || node.metadata?.folder || workflow?.role !== "collection") return false;
    return Boolean(workflow.planGroup || (workflow.step?.startsWith("assets.") && workflow.assetGroup && workflow.assetGroup.kind !== "bible"));
}

export function assetStackMembers(frame: CanvasNodeData, children: CanvasNodeData[]) {
    const manifestId = frame.metadata?.shortDrama?.assetGroup?.manifestId;
    return orderAssetStackMembers(frame, currentAssetMembers(children.filter(node => node.id !== manifestId && node.metadata?.shortDrama?.assetKey !== "$summary")));
}

const assetCodeOrder = new Intl.Collator("en", { numeric: true });

/** Rank metadata only: never parse large document bodies to place a card. */
export function orderAssetStackMembers(frame: CanvasNodeData, members: CanvasNodeData[]) {
    const catalog = new Map((frame.metadata?.frame?.assetOrder || []).map((key, index) => [key, index]));
    const manual = new Map((frame.metadata?.frame?.gridOrder || []).map((id, index) => [id, index]));
    const priorities = new Map<string, number>();
    const key = (node: CanvasNodeData) => node.metadata?.shortDrama?.planAsset?.key || node.metadata?.shortDrama?.assetKey || node.metadata?.shortDrama?.assetIdentity?.id || node.id;
    for (const node of members) {
        const priority = node.metadata?.shortDrama?.planAsset?.priority;
        if (Number.isSafeInteger(priority) && priority! > 0) priorities.set(key(node), priority!);
    }
    return [...members].sort((a, b) => {
        const left = a.metadata?.shortDrama, right = b.metadata?.shortDrama;
        const codeA = left?.assetIdentity?.code, codeB = right?.assetIdentity?.code;
        return (manual.get(a.id) ?? Infinity) - (manual.get(b.id) ?? Infinity) ||
            (catalog.get(key(a)) ?? Infinity) - (catalog.get(key(b)) ?? Infinity) ||
            (priorities.get(key(a)) ?? Infinity) - (priorities.get(key(b)) ?? Infinity) ||
            (codeA && codeB ? assetCodeOrder.compare(codeA, codeB) : codeA ? -1 : codeB ? 1 : 0) ||
            (key(a) === key(b) ? (left?.assetVersion ?? 1) - (right?.assetVersion ?? 1) : 0);
    });
}

/** Only three previews mount, even when a category holds thousands of documents. */
export function assetStackPreviews(members: CanvasNodeData[]) {
    const images: CanvasNodeData[] = [], documents: CanvasNodeData[] = [];
    for (const node of members) {
        if (node.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey)) {
            images.push(node);
            if (images.length === ASSET_STACK_PREVIEW_LIMIT) break;
        } else if (documents.length < ASSET_STACK_PREVIEW_LIMIT) documents.push(node);
    }
    return [...images, ...documents].slice(0, ASSET_STACK_PREVIEW_LIMIT);
}

/** Keep the expanded group anchored; move overlapping peers and their contents together. */
export function makeRoomForAssetStack(nodes: CanvasNodeData[], frameId: string) {
    const frame = nodes.find(node => node.id === frameId);
    if (!frame || !isCanvasAssetStack(frame) || frame.metadata?.frame?.collapsed) return nodes;
    const byId = new Map(nodes.map(node => [node.id, node]));
    const peers = nodes.filter(node => node.id !== frame.id && node.parentId === frame.parentId);
    const overlaps = (node: CanvasNodeData) => node.position.x < frame.position.x + frame.width + 48 &&
        node.position.x + node.width + 48 > frame.position.x && node.position.y < frame.position.y + frame.height + 48 &&
        node.position.y + node.height + 48 > frame.position.y;
    const collisions = peers.filter(overlaps);
    if (!collisions.length) return nodes;
    // Locked neighbours must not move. In that case only the opening group relocates.
    const moving = collisions.some(node => node.metadata?.locked) ? [frame] : collisions;
    const movingIds = new Set(moving.map(node => node.id));
    const obstacles = [frame, ...peers].filter(node => !movingIds.has(node.id));
    const offsets = new Map<string, { x: number; y: number }>();
    for (const node of moving) {
        const preferred = node === frame ? frame.position : { x: frame.position.x + frame.width + 48, y: node.position.y };
        const position = findAvailableGenerationGroupPosition(obstacles, preferred, node);
        offsets.set(node.id, { x: position.x - node.position.x, y: position.y - node.position.y });
        obstacles.push({ ...node, position });
    }
    return nodes.map(node => {
        let ancestor: CanvasNodeData | undefined = node;
        const visited = new Set<string>();
        while (ancestor && !offsets.has(ancestor.id) && ancestor.parentId && !visited.has(ancestor.id)) {
            visited.add(ancestor.id);
            ancestor = byId.get(ancestor.parentId);
        }
        const offset = ancestor && offsets.get(ancestor.id);
        return offset && (offset.x || offset.y) ? { ...node, position: { x: node.position.x + offset.x, y: node.position.y + offset.y } } : node;
    });
}
