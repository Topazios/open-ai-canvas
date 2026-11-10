import { expect, test } from "bun:test";
import { cleanCanvasDocument } from "@/lib/canvas/canvas-document-integrity";
import { removeCanvasNodes } from "@/lib/canvas/canvas-project-domain";
import { applyAgentCanvasPatch, mergeCanvasSnapshot } from "@/lib/canvas/agent-canvas-patch";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "@/types/canvas";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const node = (id: string, parentId?: string): CanvasNodeData => ({ id, parentId, type: CanvasNodeType.Text, title: id, position: { x: 0, y: 0 }, width: 320, height: 240 });
const frame = (id: string, parentId?: string): CanvasNodeData => ({ ...node(id, parentId), type: CanvasNodeType.Frame });
const edge = (fromNodeId: string, toNodeId: string): CanvasConnection => ({ id: `${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId } as CanvasConnection);
const project = (nodes: CanvasNodeData[], connections: CanvasConnection[] = []): CanvasProject => ({ id: "canvas", title: "test", nodes, connections, chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 }, createdAt: "2026-11-10", updatedAt: "2026-11-10" });

test("deleting any container removes nested groups, batch children and script frames", () => {
    const script = { ...node("script", "nested"), metadata: { isBatchRoot: true, batchChildIds: ["batch"] } };
    const bound = { ...node("bound"), metadata: { storyboardFrame: { scriptId: "script" } } } as CanvasNodeData;
    const nodes = [node("keep"), frame("group"), frame("nested", "group"), script, node("batch"), bound, node("deep", "batch")];
    const result = removeCanvasNodes(nodes, new Set(["group"]));
    expect(result.nodes.map(node => node.id)).toEqual(["keep"]);
    expect([...result.removedIds].sort()).toEqual(["batch", "bound", "deep", "group", "nested", "script"]);
});

test("full snapshot cleanup removes broken chains, cycles and dangling edges without mutating input", () => {
    const keep = node("keep");
    const group = { ...frame("group"), metadata: { batchChildIds: ["keep", "gone"] } };
    const nodes = [keep, group, node("orphan", "missing"), node("grandchild", "orphan"), node("cycle-a", "cycle-b"), node("cycle-b", "cycle-a")];
    const connections = [edge("keep", "group"), edge("group", "orphan"), edge("gone", "keep")];
    const result = cleanCanvasDocument(nodes, connections);
    expect(result.nodes.map(node => node.id)).toEqual(["keep", "group"]);
    expect(result.nodes[0]).toBe(keep);
    expect(result.nodes[1].metadata?.batchChildIds).toEqual(["keep"]);
    expect(group.metadata.batchChildIds).toEqual(["keep", "gone"]);
    expect(result.connections).toEqual([connections[0]]);
    const again = cleanCanvasDocument(result.nodes, result.connections);
    expect(again.nodes).toBe(result.nodes);
    expect(again.connections).toBe(result.connections);
});

test("whole patches retain children before parents but cascade parent deletions", () => {
    const group = frame("group"), child = node("child", "group");
    const created = applyAgentCanvasPatch(project([]), { canvasId: "canvas", updatedAt: "", nodes: [{ before: null, after: child }, { before: null, after: group }], connections: [] });
    expect(created.nodes.map(node => node.id)).toEqual(["child", "group"]);
    const removed = applyAgentCanvasPatch(created, { canvasId: "canvas", updatedAt: "", nodes: [{ before: group, after: null }], connections: [] });
    expect(removed.nodes).toHaveLength(0);
    const incoming = project([group, child, node("late", "group")]);
    expect(mergeCanvasSnapshot(created, removed, incoming, { lenient: true }).nodes).toHaveLength(0);
});

test("cleanup handles a deep ownership chain without recursion", () => {
    const nodes = [frame("root"), ...Array.from({ length: 20000 }, (_, index) => node(`node-${index}`, index ? `node-${index - 1}` : "root"))];
    expect(cleanCanvasDocument(nodes, []).nodes).toBe(nodes);
    expect(cleanCanvasDocument(nodes.slice(1), []).nodes).toHaveLength(0);
});
