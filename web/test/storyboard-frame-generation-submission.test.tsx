import { expect, spyOn, test } from "bun:test";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { useEpisodeStoryboardFrames } from "@/pages/canvas/use-episode-storyboard-frames";
import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { useConfigStore } from "@/stores/use-config-store";

test("unified submit persists mixed image and automatic keyframe targets after one confirmation", async () => {
    const rows = [1, 2].map(shotNumber => createStoryboardRow(shotNumber, { id: `row-${shotNumber}`, durationSeconds: 10, videoMotionPrompt: "人物放下相机", sceneId: "S01" }));
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, { storyboard: { rows, visibleColumns: [], referenceNodeIds: [] }, shortDrama: { pipelineId: "p", stage: "storyboard", step: "direction.shots", role: "document", sourceNodeIds: [], sourceSignatures: {} } });
    const nodesRef = { current: [script] as CanvasNodeData[] };
    const connectionsRef = { current: [] as CanvasConnection[] };
    const calls: Array<{ mode: string; targets: Array<{ rowId: string; nodeId: string; frameGeneration?: unknown }> }> = [];
    const confirmations: string[] = [];
    const errors: string[] = [];
    let saves = 0;
    const app = spyOn(App, "useApp").mockReturnValue({ message: { info() {}, error(value: string) { errors.push(value); } }, modal: { confirm(options: { content: string; onOk: () => void }) { confirmations.push(options.content); queueMicrotask(() => options.onOk()); return { destroy() {} }; } } } as unknown as ReturnType<typeof App.useApp>);
    const ready = spyOn(useConfigStore.getState(), "isAiConfigReady").mockReturnValue(true);
    let api!: ReturnType<typeof useEpisodeStoryboardFrames>;
    function Harness() {
        api = useEpisodeStoryboardFrames({ projectId: "project", nodesRef, connectionsRef,
            setNodes(update) { nodesRef.current = typeof update === "function" ? update(nodesRef.current) : update; },
            setConnections(update) { connectionsRef.current = typeof update === "function" ? update(connectionsRef.current) : update; },
            retry: async () => {}, save: async () => { saves++; return true; },
            enqueue(_id, mode, targets) { expect(saves).toBeGreaterThan(0); calls.push({ mode, targets }); return mode; },
        });
        return null;
    }
    try {
        renderToStaticMarkup(<Harness />);
        await api.generateStoryboardFrames(script.id, undefined, "all", { regenerate: true, frameTargets: [{ rowId: rows[0].id, frameId: "end" }, { rowId: rows[1].id, frameId: "key-plan" }] });
        expect(errors).toEqual([]);
        expect(confirmations).toHaveLength(1);
        expect(confirmations[0]).toContain("1 个镜头自动提取关键帧");
        expect(calls.map(call => [call.mode, call.targets.length])).toEqual([["storyboard_image", 1], ["storyboard_keyframes", 1]]);
        expect(calls[1].targets[0].rowId).toBe(rows[1].id);
        expect(calls[1].targets[0].frameGeneration).toBeTruthy();
        expect(nodesRef.current.find(node => node.id === calls[1].targets[0].nodeId)?.metadata?.storyboardFramePlan?.rowId).toBe(rows[1].id);
    } finally { app.mockRestore(); ready.mockRestore(); }
});
