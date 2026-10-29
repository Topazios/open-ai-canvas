import { describe, expect, test } from "bun:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { groupGridMetrics, layoutCanvasGridGroups, restoreGroupResize } from "@/lib/canvas/canvas-group-grid";
import { applyFrameDrop } from "@/lib/canvas/canvas-frame";
import { layoutWorkflowImageGroups } from "@/lib/canvas/canvas-workflow-image-layout";
import { ShortDramaStep } from "@/lib/short-drama-steps";
import { applyAgentCanvasPatch } from "@/lib/canvas/agent-canvas-patch";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { isolateCopiedNodeMetadata } from "@/lib/canvas/canvas-node-copy";

function fixture(count = 6): CanvasNodeData[] {
    return [{ id: "group", type: CanvasNodeType.Frame, title: "Group", position: { x: 100, y: 100 }, width: 1296, height: 800,
        metadata: { frame: { collapsed: false, expandedWidth: 1296, expandedHeight: 800, layout: "grid" },
            shortDrama: { stage: "story", step: ShortDramaStep.Body, role: "collection", pipelineId: "p", sourceSignatures: {}, sourceNodeIds: Array.from({ length: count }, (_, i) => `n${i}`) } } },
        ...Array.from({ length: count }, (_, i): CanvasNodeData => ({ id: `n${i}`, parentId: "group", type: CanvasNodeType.Text, title: `Episode ${i + 1}`,
            position: { x: i * 19, y: i * 23 }, width: 400, height: 280, metadata: { content: `Episode ${i + 1}`, status: "success" } }))];
}
function width(nodes: CanvasNodeData[], value: number) {
    return nodes.map(n => n.id === "group" ? { ...n, width: value, metadata: { ...n.metadata, frame: { ...n.metadata!.frame!, gridWidth: value } } } : n);
}

describe("responsive group grid", () => {
    test("plan root reserves bottom actions outside the document grid", () => {
        const nodes = fixture(5);
        nodes[0].metadata!.shortDrama!.step = ShortDramaStep.Plan;
        const result = layoutCanvasGridGroups(nodes);
        const frame = result[0];
        const lastBottom = Math.max(...result.slice(1).map(node => node.position.y + node.height));
        expect(frame.position.y + frame.height - lastBottom).toBeGreaterThanOrEqual(60);
        expect(layoutCanvasGridGroups(result)).toBe(result);
    });

    test("width controls columns, height fits rows, narrow width never crops a child", () => {
        const original = fixture(), snapshot = JSON.stringify(original);
        const three = layoutCanvasGridGroups(original);
        expect(three[1].position).toEqual({ x: 124, y: 200 });
        expect(three[3].position).toEqual({ x: 972, y: 200 });
        expect(three[4].position).toEqual({ x: 124, y: 536 });
        const two = layoutCanvasGridGroups(width(three, 872));
        expect(two[3].position).toEqual({ x: 124, y: 536 });
        expect(two[0].height).toBe(1076);
        const one = layoutCanvasGridGroups(width(two, 100));
        expect(one[0].width).toBe(448);
        expect(new Set(one.slice(1).map(n => n.position.x)).size).toBe(1);
        const four = layoutCanvasGridGroups(width(one, 1720));
        expect(four[4].position.y).toBe(200);
        expect(four[5].position.y).toBe(536);
        expect(JSON.stringify(original)).toBe(snapshot);
        expect(layoutCanvasGridGroups(four)).toBe(four);
    });

    test("drop reorders presentation only and snaps to exact cells", () => {
        const nodes = layoutCanvasGridGroups(fixture());
        const moved = nodes.map(n => n.id === "n5" ? { ...n, position: { x: 126, y: 203 } } : n);
        const result = applyFrameDrop(moved, new Set(["n5"]), "group");
        expect(result.find(n => n.id === "n5")!.position).toEqual({ x: 124, y: 200 });
        expect(result.find(n => n.id === "n0")!.position).toEqual({ x: 548, y: 200 });
        expect(result[0].metadata!.shortDrama!.sourceNodeIds).toEqual(nodes[0].metadata!.shortDrama!.sourceNodeIds);
        expect(layoutCanvasGridGroups(JSON.parse(JSON.stringify(result)))).toEqual(result);
    });

    test("append, remove and drag out fill cells while preserving manual width and order", () => {
        let nodes = layoutCanvasGridGroups(width(fixture(4), 872));
        nodes = applyFrameDrop(nodes.map(n => n.id === "n3" ? { ...n, position: { x: 124, y: 200 } } : n), new Set(["n3"]), "group");
        const extra = { ...nodes[1], id: "new", position: { x: 2000, y: 2000 } };
        const appended = layoutCanvasGridGroups([...nodes, extra]);
        expect(appended[0].width).toBe(872);
        expect(appended.at(-1)!.position).toEqual({ x: 124, y: 872 });
        const removed = layoutCanvasGridGroups(appended.filter(n => n.id !== "n3"));
        expect(removed.find(n => n.id === "n0")!.position).toEqual({ x: 124, y: 200 });
        const outside = applyFrameDrop(removed, new Set(["n0"]), null);
        expect(outside.find(n => n.id === "n0")!.parentId).toBeUndefined();
        expect(outside.find(n => n.id === "n1")!.position).toEqual({ x: 124, y: 200 });
    });

    test("hidden task anchor does not reserve the first cell; content updates keep other references", () => {
        const nodes = fixture(3);
        nodes[0].metadata!.shortDrama!.assetGroup = { manifestId: "task" };
        const task: CanvasNodeData = { ...nodes[1], id: "task", metadata: { shortDrama: { ...nodes[0].metadata!.shortDrama!, role: "document", assetKey: "$summary" } } };
        const ready = layoutCanvasGridGroups([nodes[0], task, ...nodes.slice(1)]);
        expect(ready[1]).toBe(task);
        expect(ready[2].position).toEqual({ x: 124, y: 200 });
        const content = ready.map(n => n.id === "n0" ? { ...n, metadata: { ...n.metadata, content: "New result" } } : n);
        expect(layoutCanvasGridGroups(content)).toBe(content);
    });

    test("image groups retain square thumbnails and manual column count after restore", () => {
        const nodes = fixture(8).map(n => n.id === "group" ? { ...n, metadata: { ...n.metadata,
            shortDrama: { ...n.metadata!.shortDrama!, mediaKind: "image" as const, mediaGroup: { sourceNodeId: "source" } } } } : { ...n, type: CanvasNodeType.Image });
        const initial = layoutWorkflowImageGroups(nodes);
        expect(groupGridMetrics(initial[0], initial.slice(1)).columns).toBe(3);
        const five = layoutWorkflowImageGroups(width(initial, 1544));
        expect(five[6].position).toEqual({ x: 124, y: 516 });
        expect(five.slice(1).every(n => n.width === 280 && n.height === 280)).toBe(true);
        const collapsed = five.map(n => n.id === "group" ? { ...n, width: 240, height: 144,
            metadata: { ...n.metadata, frame: { ...n.metadata!.frame!, collapsed: true } } } : n);
        const restored = layoutWorkflowImageGroups(JSON.parse(JSON.stringify(collapsed)));
        expect(restored[0].width).toBe(240);
        expect(restored[0].metadata!.frame!.expandedWidth).toBe(1544);
        expect(restored[6].position).toEqual(five[6].position);
        expect(layoutWorkflowImageGroups(restored)).toBe(restored);
    });

    test("mixed sizes stay inside cells; unrelated frames and folders keep their layout", () => {
        const nodes = fixture(3);
        nodes[2].width = 650; nodes[2].height = 500;
        const result = layoutCanvasGridGroups(width(nodes, 1400));
        expect(result[2].position.x - result[1].position.x).toBe(674);
        expect(result[3].position.y - result[1].position.y).toBe(556);
        const free = nodes.map(n => n.id === "group" ? { ...n, metadata: {} } : n);
        expect(layoutCanvasGridGroups(free)).toBe(free);
        const folders = nodes.map(n => n.id === "group" ? { ...n, metadata: { ...n.metadata, folder: { style: "glass" as const, createdAt: "now" } } } : n);
        expect(layoutCanvasGridGroups(folders)).toBe(folders);
    });

    test("cancel resize restores geometry without reverting new task results or resurrecting deleted nodes", () => {
        const original = layoutCanvasGridGroups(fixture());
        const resized = layoutCanvasGridGroups(width(original, 872)).filter(n => n.id !== "n4")
            .map(n => n.id === "n0" ? { ...n, metadata: { ...n.metadata, content: "Concurrent result" } } : n);
        const restored = layoutCanvasGridGroups(restoreGroupResize(resized, original, "group"));
        expect(restored[0].width).toBe(original[0].width);
        expect(restored.find(n => n.id === "n0")!.metadata!.content).toBe("Concurrent result");
        expect(restored.some(n => n.id === "n4")).toBe(false);
        expect(restored.find(n => n.id === "n2")!.position).toEqual(original[3].position);
    });

    test("background task coordinates cannot reset local columns; content conflicts still fail", () => {
        const original = layoutCanvasGridGroups(fixture());
        const local = layoutCanvasGridGroups(width(original, 872));
        const project: CanvasProject = { id: "canvas", title: "Grid", nodes: local, connections: [], chatSessions: [], activeChatId: null,
            viewport: { x: 0, y: 0, k: 1 }, createdAt: "2026-10-17", updatedAt: "2026-10-17" };
        const incoming = { ...original[3], position: { x: 999, y: 999 }, metadata: { ...original[3].metadata, content: "Generated result" } };
        const patch = { canvasId: project.id, updatedAt: project.updatedAt, connections: [], nodes: [
            { before: original[0], after: { ...original[0], height: 900, metadata: { ...original[0].metadata, frame: { ...original[0].metadata!.frame!, expandedHeight: 900 } } } },
            { before: original[3], after: incoming },
            { before: null, after: { ...original[1], id: "new" } },
        ] };
        const merged = applyAgentCanvasPatch(project, patch);
        expect(merged.nodes[0].width).toBe(872);
        expect(merged.nodes[3].position).toEqual(local[3].position);
        expect(merged.nodes[3].metadata!.content).toBe("Generated result");
        expect(merged.nodes.at(-1)!.position).toEqual({ x: 124, y: 1208 });
        expect(applyAgentCanvasPatch(merged, patch)).toBe(merged);
        const conflicting = { ...project, nodes: local.map(n => n.id === incoming.id ? { ...n, metadata: { ...n.metadata, content: "Manual edit" } } : n) };
        expect(() => applyAgentCanvasPatch(conflicting, patch)).toThrow("冲突");
    });

    test("new remote group and its children can replay after grid normalization", () => {
        const project: CanvasProject = { id: "canvas", title: "Grid", nodes: [], connections: [], chatSessions: [], activeChatId: null,
            viewport: { x: 0, y: 0, k: 1 }, createdAt: "2026-10-17", updatedAt: "2026-10-17" };
        const patch = { canvasId: project.id, updatedAt: project.updatedAt, connections: [], nodes: fixture().map(node => ({ before: null, after: node })) };
        const first = applyAgentCanvasPatch(project, patch);
        expect(first.nodes[1].position).toEqual({ x: 124, y: 200 });
        expect(applyAgentCanvasPatch(first, patch)).toBe(first);
    });

    test("copying a grid preserves width and maps visual order to copied members", () => {
        const group = fixture()[0];
        group.metadata!.frame!.gridWidth = 872;
        group.metadata!.frame!.gridOrder = ["n2", "n0", "deleted"];
        const copied = isolateCopiedNodeMetadata(group, new Map([["n0", "copy0"], ["n2", "copy2"]]));
        expect(copied.frame!.gridOrder).toEqual(["copy2", "copy0"]);
        expect(copied.frame!.gridWidth).toBe(872);
        expect(group.metadata!.frame!.gridOrder).toEqual(["n2", "n0", "deleted"]);
    });

    test("reference groups use one size and do not fight custom width on repeated updates", () => {
        const nodes = fixture(4);
        nodes[0].metadata = { frame: { ...nodes[0].metadata!.frame!, gridWidth: 1800 }, workflowKind: "reference_set", referenceAssetNodeIds: ["n0", "n1", "n2", "n3"] };
        nodes.slice(1).forEach((node, i) => { node.type = CanvasNodeType.Image; node.metadata = { ...node.metadata, size: i === 0 ? "16:9" : "1:1" }; });
        const layout = layoutCanvasGridGroups(nodes);
        expect(new Set(layout.slice(1).map(n => `${n.width}x${n.height}`)).size).toBe(1);
        expect(layout[0].width).toBe(1800);
        expect(layoutCanvasGridGroups(layout)).toBe(layout);
        const reordered = applyFrameDrop(layout.map(n => n.id === "n3" ? { ...n, position: layout[1].position } : n), new Set(["n3"]), "group");
        expect(reordered.slice(1).every(n => n.width === layout[1].width && n.height === layout[1].height)).toBe(true);
        expect(layoutCanvasGridGroups(reordered)).toBe(reordered);
    });
});
