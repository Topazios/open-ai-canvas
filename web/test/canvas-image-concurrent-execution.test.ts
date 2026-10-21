import { expect, spyOn, test } from "bun:test";
import { executeImageGeneration } from "../src/pages/canvas/canvas-image-generation-executor";
import type { CanvasGenerationExecution } from "../src/pages/canvas/canvas-generation-executor-types";
import * as generation from "../src/lib/canvas/canvas-project-generation";
import { createCanvasNode } from "../src/lib/canvas/canvas-project-domain";
import { defaultConfig } from "../src/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "../src/types/canvas";
import { createCanvasStateWriter } from "../src/lib/canvas/canvas-editor-state";

test("six image starts preserve concurrent receipts, completed results, new nodes and deletions", async () => {
    const frames = Array.from({ length: 6 }, (_, index) => ({ ...createCanvasNode(CanvasNodeType.Image, { x: index * 400, y: 0 }, {}), id: `frame-${index}` }));
    const deleted = { ...frames[0], id: "deleted" };
    const snapshot = [...frames, deleted];
    const unrelated = { ...frames[0], id: "created-during-preparation", metadata: { content: "keep edit", status: "success" as const } };
    const nodes = { current: [...frames, unrelated] as CanvasNodeData[] };
    const connections = { current: [] as CanvasConnection[] };
    const setNodes = createCanvasStateWriter(nodes, () => {});
    const setConnections = createCanvasStateWriter(connections, () => {});
    const releases = new Map<string, () => void>();
    const runner = spyOn(generation, "runCanvasGenerationTaskToConsumer").mockImplementation(async (input) => {
        const id = input.nodeId!;
        setNodes(current => current.map(node => node.id === id ? { ...node, metadata: { ...node.metadata, taskId: `task-${id}`, taskStatus: "running" } } : node));
        await new Promise<void>(resolve => releases.set(id, resolve));
        setNodes(current => current.map(node => node.id === id ? { ...node, metadata: { ...node.metadata, status: "success", taskStatus: "succeeded", content: `image-${id}` } } : node));
        return {} as Awaited<ReturnType<typeof generation.runCanvasGenerationTaskToConsumer>>;
    });
    try {
        const start = (source: CanvasNodeData) => executeImageGeneration({
            nodeId: source.id, sourceNode: source, canvasNodes: snapshot, canvasConnections: [],
            projectId: "", prompt: "Frame", effectivePrompt: "Frame", generationConfig: { ...defaultConfig, count: "1" },
            generationContext: { prompt: "Frame", referenceImages: [], referenceVideos: [], referenceAudios: [], characterReferences: [], resolvedCharacterVersions: [], resolvedCharacterVoices: [], textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 },
            controller: new AbortController(), editingTextNode: false, styleMetadata: {}, skillMetadata: {}, setNodes, setConnections,
            setSelectedNodeIds: () => {}, setSelectedConnectionId: () => {}, setDialogNodeId: () => {},
            startGenerationRequest: () => new AbortController(), finishGenerationRequest: () => {}, bindGenerationTask: () => {},
            applyGenerationTaskResult: async () => {}, showError: (error: string) => { throw new Error(error); }, registerPendingNodeIds: () => {},
        } as CanvasGenerationExecution);
        const first = start(frames[0]);
        releases.get(frames[0].id)!();
        await first;
        const rest = frames.slice(1).map(start);
        expect(runner).toHaveBeenCalledTimes(6);
        expect(nodes.current.find(node => node.id === frames[0].id)?.metadata?.content).toBe("image-frame-0");
        expect(nodes.current.slice(0, 6).map(node => node.metadata?.taskId)).toEqual(frames.map(node => `task-${node.id}`));
        expect(nodes.current.find(node => node.id === unrelated.id)).toBe(unrelated);
        expect(nodes.current.some(node => node.id === deleted.id)).toBe(false);
        releases.forEach(release => release());
        await Promise.all(rest);
        expect(nodes.current.slice(0, 6).every(node => node.metadata?.status === "success")).toBe(true);
    } finally {
        releases.forEach(release => release());
        runner.mockRestore();
    }
});
