import { describe, expect, test } from "bun:test";
import { reconcileCanvasArray, reconcileCanvasArrayMap, sameCanvasShallowValue } from "../src/lib/canvas/canvas-render-reconciliation";
import { buildContextResourceNodeMap, getContextResourceNodes } from "../src/lib/canvas/canvas-resource-references";
import { hasCanvasCustomNodeContent } from "../src/lib/canvas/canvas-custom-node-content";
import { buildCanvasCustomNodeScopes } from "../src/pages/canvas/use-canvas-scoped-node-renderers";
import { deriveStoryboardPipelineProgress } from "../src/lib/canvas/canvas-storyboard-progress";
import { createStoryboardRow } from "../src/lib/canvas/canvas-project-domain";
import { createDirectorScene } from "../src/lib/canvas/director/director-scene";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "../src/types/canvas";

const node = (id: string, type = CanvasNodeType.Text, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id, type, metadata, title: id, position: { x: 0, y: 0 }, width: 200, height: 100,
});
const edge = (fromNodeId: string, toNodeId: string): CanvasConnection => ({ id: `${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId });
const scopes = (nodes: CanvasNodeData[], connections: CanvasConnection[] = []) => buildCanvasCustomNodeScopes({
    nodes, visibleNodes: nodes, connections, mentionReferencesByNodeId: new Map(), configInputsById: new Map(), runningNodeId: null,
});

describe("canvas render reconciliation", () => {
    test("unchanged primitives and shallow references keep their identity without losing fields", () => {
        const skill = { name: "synthetic" };
        const previous = [{ id: "a", label: "A", skill }, { id: "b", label: "B", skill }];
        expect(reconcileCanvasArray(previous, previous.map((item) => ({ ...item })), sameCanvasShallowValue)).toBe(previous);
        const next = reconcileCanvasArray(previous, [{ ...previous[0], label: "Latest" }, { ...previous[1] }], sameCanvasShallowValue);
        expect(next[0].label).toBe("Latest"); expect(next[1]).toBe(previous[1]);
        expect(sameCanvasShallowValue({ x: undefined }, { y: undefined })).toBe(false);
        expect(sameCanvasShallowValue({ skill }, { skill: { ...skill } })).toBe(false);
    });
    test("insertion, reorder, removal, empty entries and deleted keys are not cached away", () => {
        const a = node("a"), b = node("b");
        const previous = new Map([["left", [a]], ["right", [b]], ["empty", []]]);
        expect(reconcileCanvasArrayMap(previous, new Map([["left", [a]], ["right", [b]], ["empty", []]]))).toBe(previous);
        const next = reconcileCanvasArrayMap(previous, new Map([["left", [b, a]], ["empty", []]]));
        expect(next.has("right")).toBe(false); expect(next.get("left")).toEqual([b, a]);
        expect(next.get("empty")).toBe(previous.get("empty"));
        expect(reconcileCanvasArray([a, b], [b, a])).toEqual([b, a]);
        expect(reconcileCanvasArray([a], [])).toEqual([]);
    });
    test("direct upstream index preserves source order, duplicates, filtering and latest state", () => {
        const a = node("a", CanvasNodeType.Text, { content: "A" }), b = node("b", CanvasNodeType.Text, { content: "B" }), config = node("config", CanvasNodeType.Config);
        const connections = [edge("b", "target"), edge("config", "target"), edge("missing", "target"), edge("a", "target"), edge("a", "target")];
        const previous = buildContextResourceNodeMap([a, b, config], connections);
        expect(previous.get("target")).toEqual([b, a, a]);
        expect(getContextResourceNodes("target", [a, b, config], connections)).toEqual(previous.get("target")!);
        const latest = { ...a, metadata: { content: "Latest result" } };
        const next = buildContextResourceNodeMap([latest, config], connections);
        expect(next.get("target")).toEqual([latest, latest]);
        expect(buildContextResourceNodeMap([], connections).size).toBe(0);
    });
    test("custom content routing retains workflow overrides and ordinary text editing", () => {
        expect(hasCanvasCustomNodeContent(node("plain"))).toBe(false);
        const story = node("story", CanvasNodeType.Text, { workflowKind: "story_input" });
        expect(hasCanvasCustomNodeContent(story)).toBe(true);
        expect(hasCanvasCustomNodeContent(story, true)).toBe(false);
        expect(hasCanvasCustomNodeContent(node("style", CanvasNodeType.Image, { workflowKind: "styleboard", content: "ready" }))).toBe(false);
        expect(hasCanvasCustomNodeContent(node("character", CanvasNodeType.Image, { workflowKind: "character", characterAssetId: "synthetic" }))).toBe(true);
    });
    test("batch scope includes references, text and output, not unrelated nodes", () => {
        const batch = node("table", CanvasNodeType.BatchTable, { batchTable: { operation: "creative", concurrency: 1,
            rows: [{ id: "row", inputNodeIds: ["image"], textNodeIds: ["text"], outputNodeId: "output", enabled: true, prompt: "synthetic" }] } });
        const image = node("image", CanvasNodeType.Image), text = node("text"), output = node("output", CanvasNodeType.Image);
        const edges = [edge("image", "table"), edge("other", "table"), edge("table", "output"), edge("other", "unused")];
        const data = scopes([batch, image, text, output, node("other")], edges).get("table")!;
        expect(data.nodes).toEqual([image, text, output]);
        expect(data.connections).toEqual(edges.slice(0, 2));
        expect(scopes([batch, text], []).get("table")!.nodes).toEqual([text]);
    });
    test("scoped storyboard pipeline equals the full graph including shared final outputs", () => {
        const script = node("script", CanvasNodeType.Script, { storyboard: { visibleColumns: [], referenceNodeIds: [], rows: [createStoryboardRow(1, {
            id: "row", imageNodeId: "image", videoNodeId: "video", assetBindings: [{ nodeId: "character", role: "character", priority: 1 }],
        })] } });
        const image = node("image", CanvasNodeType.Image, { status: "success", content: "image" });
        const video = node("video", CanvasNodeType.Video, { status: "loading" });
        const final = node("final", CanvasNodeType.Video, { workflowKind: "final", status: "success", content: "video" });
        const direct = node("direct-final", CanvasNodeType.Video, { workflowKind: "final", status: "error" });
        const nodes = [node("other"), final, image, script, video, direct, node("character")];
        const edges = [edge("video", "final"), edge("script", "direct-final"), edge("other", "unrelated")];
        const scope = scopes(nodes, edges).get("script")!;
        expect(scope.nodes.map((item) => item.id)).toEqual(["final", "image", "video", "direct-final", "character"]);
        expect(deriveStoryboardPipelineProgress(script, scope.nodes, scope.connections)).toEqual(deriveStoryboardPipelineProgress(script, nodes, edges));
        const changed = nodes.map((item) => item === video ? { ...video, metadata: { ...video.metadata, status: "success" as const, content: "arrived" } } : item).filter((item) => item !== image);
        const fresh = scopes(changed, edges).get("script")!;
        expect(deriveStoryboardPipelineProgress(script, fresh.nodes, fresh.connections)).toEqual(deriveStoryboardPipelineProgress(script, changed, edges));
    });
    test("inline storyboard videos count as pipeline results without a video canvas node", () => {
        const script = node("script", CanvasNodeType.Script, { storyboard: { visibleColumns: [], referenceNodeIds: [], rows: [createStoryboardRow(1, {
            id: "row", videoGeneration: { taskId: "task-1", taskStatus: "succeeded", content: "video" },
        })] } });
        const progress = deriveStoryboardPipelineProgress(script, [script], []);
        expect(progress.videos).toMatchObject({ total: 1, created: 1, success: 1, failed: 0, incomplete: 0 });
        expect(progress.rows[0]?.videoNode).toBeUndefined();
        expect(progress.successfulVideoNodeIds).toEqual([]);
    });
    test("director scope includes both preview fallbacks and only the selected scene", () => {
        const scene = createDirectorScene();
        scene.shots[0].previewNodeId = "shot-preview";
        const director = node("director", CanvasNodeType.Config, { directorSceneId: scene.id, directorPreviewNodeId: "metadata-preview" });
        const nodes = [director, node("metadata-preview", CanvasNodeType.Image), node("shot-preview", CanvasNodeType.Image), node("unused")];
        const scope = buildCanvasCustomNodeScopes({ nodes, visibleNodes: [director], connections: [], directorScenes: [scene], mentionReferencesByNodeId: new Map(), configInputsById: new Map(), runningNodeId: null }).get("director")!;
        expect(scope.directorScene).toBe(scene);
        expect(scope.nodes).toEqual(nodes.slice(1, 3));
    });
});
