import type { CanvasNodeData, Position } from "@/types/canvas";

type Rect = Position & { width: number; height: number };
const gap = 64;
export function workflowNodeBounds(node: CanvasNodeData): Rect {
    return { ...node.position, width: Math.max(node.width, node.metadata?.frame?.expandedWidth || 0), height: Math.max(node.height, node.metadata?.frame?.expandedHeight || 0) };
}
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;

// Search actual free rectangles near the source, not the bottom of its entire column.
export function placeWorkflowFootprint(nodes: CanvasNodeData[], size: { width: number; height: number }, preferred: Position, anchor?: CanvasNodeData): Position {
    const occupied = nodes.map(workflowNodeBounds);
    const candidates: Position[] = [preferred];
    const source = anchor ? workflowNodeBounds(anchor) : { ...preferred, width: 0, height: 0 };
    for (const rect of [source, ...occupied]) {
        const xs = [rect.x + rect.width + gap, rect.x - size.width - gap];
        const ys = [rect.y + rect.height + gap, rect.y - size.height - gap];
        for (const x of xs) for (const y of [preferred.y, rect.y, rect.y + rect.height - size.height]) candidates.push({ x, y });
        for (const y of ys) for (const x of [preferred.x, rect.x, rect.x + rect.width - size.width]) candidates.push({ x, y });
    }
    const free = (position: Position) => !occupied.some(rect => intersects({ ...position, ...size }, rect));
    if (free(preferred)) return preferred;
    const distance = (p: Position) => {
        const dx = Math.max(source.x - p.x - size.width, p.x - source.x - source.width, 0);
        const dy = Math.max(source.y - p.y - size.height, p.y - source.y - source.height, 0);
        return dx * dx + dy * dy;
    };
    candidates.sort((a, b) => distance(a) - distance(b) || Math.hypot(a.x - preferred.x, a.y - preferred.y) - Math.hypot(b.x - preferred.x, b.y - preferred.y));
    const result = candidates.find(free);
    return result || { x: Math.max(preferred.x, ...occupied.map(rect => rect.x + rect.width + gap)), y: preferred.y };
}

export function placeNewWorkflowGroup(nodes: CanvasNodeData[], groupId: string, original: CanvasNodeData[], anchor?: CanvasNodeData) {
    const group = nodes.find(node => node.id === groupId)!;
    const position = placeWorkflowFootprint(original, workflowNodeBounds(group), group.position, anchor);
    const dx = position.x - group.position.x, dy = position.y - group.position.y;
    if (!dx && !dy) return nodes;
    return nodes.map(node => node.id === groupId || node.parentId === groupId ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node);
}
