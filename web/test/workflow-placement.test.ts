import { expect, test } from "bun:test";
import { placeWorkflowFootprint, workflowNodeBounds, placeNewWorkflowGroup } from "../src/lib/canvas/canvas-workflow-placement";
import { createCanvasNode } from "../src/lib/canvas/canvas-project-domain";
import { CanvasNodeType } from "../src/types/canvas";

const node = (x: number, y: number, width = 400, height = 280) => ({ ...createCanvasNode(CanvasNodeType.Text, { x, y }), position: { x, y }, width, height });
test("free space next to source is used even when the same column has distant nodes", () => {
    const source = node(0, 0), far = node(500, 10000);
    expect(placeWorkflowFootprint([source, far], { width: 400, height: 280 }, { x: 500, y: 0 }, source)).toEqual({ x: 500, y: 0 });
});
test("occupied right side chooses nearby free side using the complete group footprint", () => {
    const source = node(0, 0), blocker = node(500, -100, 1500, 7000);
    const size = { width: 1296, height: 6180 };
    const placed = placeWorkflowFootprint([source, blocker], size, { x: 500, y: 0 }, source);
    expect(Math.abs(placed.y)).toBeLessThan(7000);
    for (const other of [source, blocker].map(workflowNodeBounds)) {
        expect(placed.x + size.width <= other.x || placed.x >= other.x + other.width || placed.y + size.height <= other.y || placed.y >= other.y + other.height).toBe(true);
    }
});
test("collapsed groups reserve expanded space and new children move with their group", () => {
    const source = node(0, 0);
    source.metadata = { frame: { collapsed: true, expandedWidth: 1000, expandedHeight: 2000 } };
    const frame = node(500, 0, 800, 1000); frame.type = CanvasNodeType.Frame;
    const child = node(524, 100); child.parentId = frame.id;
    const result = placeNewWorkflowGroup([source, frame, child], frame.id, [source], source);
    const moved = result.find(n => n.id === frame.id)!;
    const member = result.find(n => n.id === child.id)!;
    expect(moved.position).not.toEqual(frame.position);
    expect(member.position.x - moved.position.x).toBe(24);
    expect(member.position.y - moved.position.y).toBe(100);
    expect(result[0]).toBe(source);
});
