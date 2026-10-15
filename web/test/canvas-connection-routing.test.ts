import { expect, test } from "bun:test";
import { closestBorderPoint, shortestBorderPair } from "@/lib/canvas/canvas-connection-routing";
import { activeConnectionPath, canvasConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const box = (id: string, x: number, y: number, width = 100, height = 100): CanvasNodeData => ({ id, type: CanvasNodeType.Text, title: id, position: { x, y }, width, height });
const midpoints = (node: CanvasNodeData) => {
    const { x, y } = node.position, w = node.width, h = node.height;
    return [{ x: x + w / 2, y }, { x: x + w, y: y + h / 2 }, { x: x + w / 2, y: y + h }, { x, y: y + h / 2 }];
};
test("automatic anchors choose the nearest pair of four edge midpoints, never corners", () => {
    const a = box("a", 0, 0);
    for (const [x, y] of [[200, 0], [-200, 0], [0, 200], [0, -200], [170, 180], [-180, -190], [40, 30]]) {
        const b = box("b", x, y);
        const { start, end } = shortestBorderPair(a, b);
        expect(midpoints(a)).toContainEqual(start);
        expect(midpoints(b)).toContainEqual(end);
        expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeCloseTo(Math.min(...midpoints(a).flatMap((s) => midpoints(b).map((e) => Math.hypot(e.x - s.x, e.y - s.y)))));
        expect(closestBorderPoint(a, start)).toEqual(start);
        expect(closestBorderPoint(b, end)).toEqual(end);
        const reverse = shortestBorderPair(b, a);
        expect(Math.hypot(reverse.end.x - reverse.start.x, reverse.end.y - reverse.start.y)).toBeCloseTo(Math.hypot(end.x - start.x, end.y - start.y));
    }
    const pair = shortestBorderPair(a, box("inside", 20, 20, 30, 30));
    expect(midpoints(a)).toContainEqual(pair.start);
    expect(midpoints(box("inside", 20, 20, 30, 30))).toContainEqual(pair.end);
});
test("snaps to fixed midpoints and keeps live preview aligned with committed geometry", () => {
    const a = box("a", 0, 0), b = box("b", 40, 200);
    expect(closestBorderPoint(a, { x: 27, y: -8 })).toEqual({ x: 50, y: 0 });
    expect(closestBorderPoint(a, { x: 108, y: 63 })).toEqual({ x: 100, y: 50 });
    const path = canvasConnectionPath({ id: "edge", fromNodeId: a.id, toNodeId: b.id }, a, b);
    expect(path.startY).toBe(100); expect(path.endY).toBe(200);
    expect(activeConnectionPath(a, { nodeId: a.id, handleType: "source" }, b.position, b)).toBe(path.pathD);
    expect(activeConnectionPath(b, { nodeId: b.id, handleType: "target" }, a.position, a)).toBe(path.pathD);
});
test("horizontal, vertical and diagonal connections are curved with bounded outward controls", () => {
    const a = box("a", 0, 0);
    for (const [x, y] of [[200, 0], [-200, 0], [0, 200], [0, -200], [170, 180]]) {
        const b = box("b", x, y);
        const path = canvasConnectionPath({ id: "edge", fromNodeId: a.id, toNodeId: b.id }, a, b);
        const [sx, sy, c1x, c1y, c2x, c2y, ex, ey] = path.pathD.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g)!.map(Number);
        expect(Math.abs((c1x - sx) * (ey - sy) - (c1y - sy) * (ex - sx)) + Math.abs((c2x - sx) * (ey - sy) - (c2y - sy) * (ex - sx))).toBeGreaterThan(0);
        expect(Math.hypot(c1x - sx, c1y - sy)).toBeLessThanOrEqual(144);
        expect(Math.hypot(c2x - ex, c2y - ey)).toBeLessThanOrEqual(144);
    }
});
test("explicit business ports retain their row position", () => {
    const a = box("a", 0, 0), b = box("b", 200, 200);
    expect(shortestBorderPair(a, b, { x: 100, y: 37 }, { x: 200, y: 229 })).toEqual({ start: { x: 100, y: 37 }, end: { x: 200, y: 229 } });
});
test("container projection does not inherit hidden member row handles", () => {
    const a = box("frame-a", 0, 0), b = box("frame-b", 0, 200);
    const path = canvasConnectionPath({ id: "edge", fromNodeId: "member-a", toNodeId: "member-b", fromHandleId: "row:1", toHandleId: "row:2" }, a, b);
    expect(path.startY).toBe(100); expect(path.endY).toBe(200);
});
