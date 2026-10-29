import { describe, expect, test } from "bun:test";
import { buildCanvasConnectionSpatialIndex, removeCanvasDisplayConnection, resolveCanvasDisplayConnections } from "../src/lib/canvas/canvas-connection-spatial-index";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "../src/types/canvas";

const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Text, title: "Source", position: { x: 10, y: 10 }, width: 100, height: 100, metadata: { content: "original" } };
const target: CanvasNodeData = { ...source, id: "target", position: { x: 200, y: 100 } };
const connections: CanvasConnection[] = [{ id: "edge", fromNodeId: source.id, toNodeId: target.id }];
const view = { left: 0, top: 0, right: 500, bottom: 500 };

describe("connection geometry index", () => {
    test("expanded workflow collections expose one link with all provenance edges and delete it atomically", () => {
        const frame: CanvasNodeData = { ...source, id: "collection", type: CanvasNodeType.Frame, width: 400, height: 300, metadata: { frame: { collapsed: false }, shortDrama: { stage: "story", step: "story.body", role: "collection", pipelineId: "p", sourceNodeIds: ["a", "b"], sourceSignatures: {} } } };
        const a = { ...source, id: "a", parentId: frame.id }, b = { ...source, id: "b", parentId: frame.id };
        const edges = [{ id: "a-edge", fromNodeId: target.id, toNodeId: a.id }, { id: "b-edge", fromNodeId: target.id, toNodeId: b.id }];
        const nodes = [target, a, b, frame];
        const index = buildCanvasConnectionSpatialIndex(nodes, edges);
        expect(index.index.query(view)).toEqual(["a-edge"]);
        expect(index.endpointsById.get("a-edge")).toEqual({ fromNodeId: target.id, toNodeId: frame.id });
        expect([...index.memberIdsByConnectionId.get("a-edge")!]).toEqual(["a-edge", "b-edge"]);
        expect([...index.connectionIdsByNodeId.get(b.id)!]).toEqual(["a-edge"]);
        expect(resolveCanvasDisplayConnections(nodes, edges)).toHaveLength(1);
        expect(removeCanvasDisplayConnection(nodes, edges, "a-edge")).toEqual([]);
        expect(edges).toHaveLength(2);
        const moved = nodes.map((node) => node.id === frame.id ? { ...node, position: { x: 2000, y: 2000 } } : node);
        expect(buildCanvasConnectionSpatialIndex(moved, edges, index)).not.toBe(index);
        const ungrouped = nodes.map((node) => node.id === frame.id ? { ...node, metadata: { frame: { collapsed: false } } } : node);
        expect(buildCanvasConnectionSpatialIndex(ungrouped, edges, index).index.query(view)).toHaveLength(2);
        const out = nodes.map((node) => node.id === b.id ? { ...node, parentId: undefined } : node);
        expect(buildCanvasConnectionSpatialIndex(out, edges, index).index.query(view)).toHaveLength(2);
        const targetFrame = { ...frame, id: "target-frame" };
        expect(resolveCanvasDisplayConnections([...nodes.map((node) => node.id === target.id ? { ...node, parentId: targetFrame.id } : node), targetFrame], edges).map(({ from, to }) => [from.id, to.id])).toEqual([[targetFrame.id, frame.id]]);
    });
    test("content, task and title updates reuse an index that owns only geometry and IDs", () => {
        const first = buildCanvasConnectionSpatialIndex([source, target], connections);
        const changed = { ...source, title: "Latest", metadata: { content: "result", status: "success" as const } };
        const next = buildCanvasConnectionSpatialIndex([changed, target], connections, first);
        expect(next).toBe(first);
        expect(next.index.query(view)).toEqual(["edge"]);
        expect(next.endpointsById.get("edge")).toEqual({ fromNodeId: "source", toNodeId: "target" });
        expect(JSON.stringify(next.geometry)).not.toContain("original");
        expect(JSON.stringify(next.geometry)).not.toContain("result");
    });
    test("moves, resizes, insertion, deletion and edge replacement invalidate the index", () => {
        const first = buildCanvasConnectionSpatialIndex([source, target], connections);
        for (const changed of [{ ...source, width: 101 }, { ...source, height: 101 }, { ...source, position: { x: 11, y: 10 } }, { ...source, position: { x: 10, y: 11 } }]) {
            expect(buildCanvasConnectionSpatialIndex([changed, target], connections, first)).not.toBe(first);
        }
        const removed = buildCanvasConnectionSpatialIndex([source], connections, first);
        expect(removed.index.query(view)).toEqual([]);
        const restored = buildCanvasConnectionSpatialIndex([source, target], connections, removed);
        expect(restored.index.query(view)).toEqual(["edge"]);
        const reversed = [{ ...connections[0], fromNodeId: "target", toNodeId: "source" }];
        expect(buildCanvasConnectionSpatialIndex([source, target], reversed, first).endpointsById.get("edge")?.fromNodeId).toBe("target");
    });
    test("collapsed frames substitute endpoints and hide internal edges", () => {
        const frame: CanvasNodeData = { ...source, id: "frame", type: CanvasNodeType.Frame, width: 400, height: 300, metadata: { frame: { collapsed: true } } };
        const child = { ...source, parentId: frame.id };
        const first = buildCanvasConnectionSpatialIndex([child, target, frame], connections);
        expect(first.endpointsById.get("edge")?.fromNodeId).toBe(frame.id);
        expect([...first.connectionIdsByNodeId.get(frame.id)!]).toEqual(["edge"]);
        const internal = buildCanvasConnectionSpatialIndex([child, { ...target, parentId: frame.id }, frame], connections, first);
        expect(internal.index.query(view)).toEqual([]);
        const expanded = buildCanvasConnectionSpatialIndex([child, target, { ...frame, metadata: { frame: { collapsed: false } } }], connections, first);
        expect(expanded.endpointsById.get("edge")?.fromNodeId).toBe(source.id);
        const notAFrame = buildCanvasConnectionSpatialIndex([child, target, { ...frame, type: CanvasNodeType.Text }], connections, first);
        expect(notAFrame.endpointsById.get("edge")?.fromNodeId).toBe(source.id);
    });
    test("batch visibility and missing roots match existing collapse semantics", () => {
        const root: CanvasNodeData = { ...source, id: "batch", type: CanvasNodeType.Image, metadata: { isBatchRoot: true } };
        const child = { ...source, metadata: { ...source.metadata, batchRootId: root.id } };
        const collapsed = buildCanvasConnectionSpatialIndex([child, target, root], connections);
        expect(collapsed.index.query(view)).toEqual([]);
        const expanded = buildCanvasConnectionSpatialIndex([child, target, { ...root, metadata: { ...root.metadata, imageBatchExpanded: true } }], connections, collapsed);
        expect(expanded.index.query(view)).toEqual(["edge"]);
        expect(buildCanvasConnectionSpatialIndex([child, target], connections, expanded).index.query(view)).toEqual(["edge"]);
    });
    test("non-rendered storyboard frame links do not consume the viewport connection budget", () => {
        const frameRecord: CanvasNodeData = { ...source, id: "frame-record", metadata: { storyboardFrame: { scriptId: "script", rowId: "row", frameId: "frame", sourcePromptHash: "hash" } } };
        const frameLinks = Array.from({ length: 5001 }, (_, index) => ({ id: `frame-link-${index}`, fromNodeId: frameRecord.id, toNodeId: target.id }));
        const index = buildCanvasConnectionSpatialIndex([source, target, frameRecord], [...frameLinks, ...connections]);

        expect(index.index.query(view, 1)).toEqual(["edge"]);
        expect(index.endpointsById.has("frame-link-0")).toBe(false);
    });
});
