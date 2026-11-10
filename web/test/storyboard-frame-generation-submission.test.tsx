import { expect, spyOn, test } from "bun:test";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { useEpisodeStoryboardFrames } from "@/pages/canvas/use-episode-storyboard-frames";
import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { useConfigStore } from "@/stores/use-config-store";
import { storyboardFrameHash, type StoryboardFrameTarget } from "@/lib/canvas/episode-storyboard-frames";

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
        expect(confirmations[0]).toContain("本次范围：镜头 1 · 尾帧；镜头 2 · 关键帧（自动提取）");
        expect(calls.map(call => [call.mode, call.targets.length])).toEqual([["storyboard_image", 1], ["storyboard_keyframes", 1]]);
        expect(calls[1].targets[0].rowId).toBe(rows[1].id);
        expect(calls[1].targets[0].frameGeneration).toBeTruthy();
        expect(nodesRef.current.find(node => node.id === calls[1].targets[0].nodeId)?.metadata?.storyboardFramePlan?.rowId).toBe(rows[1].id);
    } finally { app.mockRestore(); ready.mockRestore(); }
});

test("confirmation freezes clicked targets and never treats an empty or missing selection as all", async () => {
    const rows = [1, 2, 3].map(shotNumber => createStoryboardRow(shotNumber, { id: `row-${shotNumber}`, shotCode: `S01-00${shotNumber}`, durationSeconds: 10, videoMotionPrompt: `人物动作 ${shotNumber}`, sceneId: "S01" }));
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, { storyboard: { rows, visibleColumns: [], referenceNodeIds: [] }, shortDrama: { pipelineId: "p", stage: "storyboard", step: "direction.shots", role: "document", sourceNodeIds: [], sourceSignatures: {} } });
    const nodesRef = { current: [script] as CanvasNodeData[] };
    const connectionsRef = { current: [] as CanvasConnection[] };
    const selected: StoryboardFrameTarget[] = [{ rowId: rows[0].id, frameId: "end", sourcePromptHash: storyboardFrameHash(rows[0]) }];
    const calls: Array<{ rowId: string; nodeId: string }> = [];
    const errors: string[] = [];
    let confirmations = 0, saves = 0;
    const app = spyOn(App, "useApp").mockReturnValue({ message: { info() {}, error(value: string) { errors.push(value); } }, modal: { confirm(options: { content: string; onOk: () => void }) {
        confirmations++;
        expect(options.content).toContain("S01-001 · 尾帧");
        expect(options.content).not.toContain("S01-003");
        // A caller changing the original selection while the dialog is open must not change approval.
        selected[0].rowId = rows[2].id;
        selected[0].sourcePromptHash = storyboardFrameHash(rows[2]);
        queueMicrotask(() => options.onOk());
        return { destroy() {} };
    } } } as unknown as ReturnType<typeof App.useApp>);
    const ready = spyOn(useConfigStore.getState(), "isAiConfigReady").mockReturnValue(true);
    let api!: ReturnType<typeof useEpisodeStoryboardFrames>;
    function Harness() {
        api = useEpisodeStoryboardFrames({ projectId: "project", nodesRef, connectionsRef,
            setNodes(update) { nodesRef.current = typeof update === "function" ? update(nodesRef.current) : update; },
            setConnections(update) { connectionsRef.current = typeof update === "function" ? update(connectionsRef.current) : update; },
            retry: async () => {}, save: async () => { saves++; return true; },
            enqueue(_id, mode, targets) { calls.push(...targets); return mode; },
        });
        return null;
    }
    try {
        renderToStaticMarkup(<Harness />);
        await api.generateStoryboardFrames(script.id, undefined, "all", { frameTargets: [] });
        expect(confirmations).toBe(0);
        expect(saves).toBe(0);
        await api.generateStoryboardFrames(script.id, undefined, "all", { frameTargets: [{ rowId: "deleted-row", frameId: "start" }] });
        expect(confirmations).toBe(0);
        expect(calls).toEqual([]);
        expect(errors).toEqual(["所选画面的分镜已更新或删除，请重新勾选后生成"]);
        errors.length = 0;
        await api.generateStoryboardFrames(script.id, undefined, "all", { frameTargets: selected });
        expect(errors).toEqual([]);
        expect(confirmations).toBe(1);
        expect(calls.map(target => target.rowId)).toEqual([rows[0].id]);
    } finally { app.mockRestore(); ready.mockRestore(); }
});
