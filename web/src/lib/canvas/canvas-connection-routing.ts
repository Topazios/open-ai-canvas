import type { CanvasNodeData, Position } from "@/types/canvas";

export const CONNECTION_CURVE_PADDING = 144;

function borderMidpoints(node: CanvasNodeData): Position[] {
    const { x, y } = node.position;
    const r = x + node.width, b = y + node.height;
    return [{ x: x + node.width / 2, y }, { x: r, y: y + node.height / 2 },
        { x: x + node.width / 2, y: b }, { x, y: y + node.height / 2 }];
}
const distanceSquared = (a: Position, b: Position) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

export function closestBorderPoint(node: CanvasNodeData, point: Position): Position {
    return borderMidpoints(node).sort((a, b) => distanceSquared(a, point) - distanceSquared(b, point))[0];
}

export function shortestBorderPair(from: CanvasNodeData, to: CanvasNodeData, fixedStart?: Position, fixedEnd?: Position) {
    if (fixedStart) return { start: fixedStart, end: fixedEnd || closestBorderPoint(to, fixedStart) };
    if (fixedEnd) return { start: closestBorderPoint(from, fixedEnd), end: fixedEnd };
    let best: { start: Position; end: Position; distance: number } | undefined;
    for (const start of borderMidpoints(from)) for (const end of borderMidpoints(to)) {
        const distance = distanceSquared(start, end);
        if (!best || distance < best.distance) best = { start, end, distance };
    }
    return best!;
}

function borderNormal(node: CanvasNodeData, point: Position): Position {
    const { x, y } = node.position;
    const sides = [
        { distance: Math.abs(point.x - x), normal: { x: -1, y: 0 } },
        { distance: Math.abs(point.x - x - node.width), normal: { x: 1, y: 0 } },
        { distance: Math.abs(point.y - y), normal: { x: 0, y: -1 } },
        { distance: Math.abs(point.y - y - node.height), normal: { x: 0, y: 1 } },
    ];
    return sides.sort((a, b) => a.distance - b.distance)[0].normal;
}

export function borderConnectionPath(start: Position, end: Position, from?: CanvasNodeData, to?: CanvasNodeData) {
    const dx = end.x - start.x, dy = end.y - start.y;
    const distance = Math.hypot(dx, dy);
    const direction = { x: dx / (distance || 1), y: dy / (distance || 1) };
    const startNormal = from ? borderNormal(from, start) : direction;
    const endNormal = to ? borderNormal(to, end) : { x: -direction.x, y: -direction.y };
    const reach = Math.min(120, distance * 0.4);
    // Aligned edges still need a gentle arc; fade the bow as the normals provide curvature.
    const cross = (normal: Position) => Math.abs(normal.x * direction.y - normal.y * direction.x);
    const bow = Math.min(24, distance * 0.16) * Math.max(0, 1 - Math.max(cross(startNormal), cross(endNormal)) * 4);
    const bend = { x: -direction.y * bow, y: direction.x * bow };
    const c1 = { x: start.x + startNormal.x * reach + bend.x, y: start.y + startNormal.y * reach + bend.y };
    const c2 = { x: end.x + endNormal.x * reach + bend.x, y: end.y + endNormal.y * reach + bend.y };
    return { pathD: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
        startX: start.x, startY: start.y, endX: end.x, endY: end.y };
}
