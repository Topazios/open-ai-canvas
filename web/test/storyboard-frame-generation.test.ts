import { expect, test } from "bun:test";
import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { materializeStoryboardFrames, storyboardFrameHash } from "@/lib/canvas/episode-storyboard-frames";
import { continueStoryboardFrameGeneration, materializeStoryboardKeyframePlans, storyboardFrameRequests } from "@/lib/canvas/storyboard-frame-generation";
import { generationBatchQueueCandidates, pauseNodeGenerationBatches, reconcileGenerationBatches } from "@/lib/canvas/canvas-generation-batch";
import { CanvasNodeType, type CanvasGenerationBatch, type CanvasNodeData } from "@/types/canvas";
import { encodeChannelModel } from "@/stores/config-model-options";

const settings = { size: "16:9", quality: "standard", transparentBackground: "false" };
const imageModel = encodeChannelModel("test-channel", "image-model");
function fixture() {
    const rows = [1, 2].map(shotNumber => createStoryboardRow(shotNumber, { id: `row-${shotNumber}`, durationSeconds: 10, videoMotionPrompt: "人物抬手，放下相机", sceneId: "S01" }));
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, {
        storyboard: { rows, visibleColumns: [], referenceNodeIds: [] },
        shortDrama: { pipelineId: "p", stage: "storyboard", step: "direction.shots", role: "document", sourceNodeIds: [], sourceSignatures: {} },
    });
    return { rows, script, nodes: [script] };
}
function queuedPlan(status: "waiting" | "succeeded" = "succeeded") {
    const f = fixture();
    const planned = materializeStoryboardKeyframePlans(f.script.id, [f.rows[0]], f.nodes, "text-model", { model: imageModel, settings });
    const target = planned.targets[0];
    const batch: CanvasGenerationBatch = { id: "extract", projectId: "project", sourceNodeId: f.script.id, mode: "storyboard_keyframes", status: status === "waiting" ? "queued" : "completed", items: [{ ...target, id: "item", status, retryCount: 0 }], createdAt: "now", updatedAt: "now" };
    const nodes: CanvasNodeData[] = planned.nodes.map(node => node.id === f.script.id ? { ...node, metadata: { ...node.metadata, generationBatches: [batch] } } : node.id === target.nodeId && status === "succeeded" ? { ...node, metadata: { ...node.metadata, status: "success", content: JSON.stringify({ frames: [{ timeSeconds: 3, prompt: "人物抬手的瞬间" }, { timeSeconds: 6, prompt: "人物放下相机的瞬间" }] }) } } : node);
    return { ...f, nodes, target, batch };
}

test("mixed selection submits ready boundary images and extracts only selected key placeholders", () => {
    const f = fixture();
    const options = { frameTargets: [{ rowId: f.rows[0].id, frameId: "end" }, { rowId: f.rows[1].id, frameId: "key-plan" }] };
    const resolved = storyboardFrameRequests(f.rows, f.nodes, "all", options);
    expect(resolved.planRows.map(row => row.id)).toEqual([f.rows[1].id]);
    const images = materializeStoryboardFrames(f.script, resolved.requests, f.nodes, [], "image", settings, resolved.options);
    expect(images.targets).toHaveLength(1);
    const plans = materializeStoryboardKeyframePlans(f.script.id, resolved.planRows, images.nodes, "text", { model: "image", settings });
    expect(plans.targets.map(target => target.rowId)).toEqual([f.rows[1].id]);
    expect(plans.nodes.find(node => node.id === plans.targets[0].nodeId)?.metadata?.prompt).toContain("1至8个有意义的关键画面");
    expect(plans.nodes.filter(node => node.type === CanvasNodeType.Image).every(node => !!node.metadata?.prompt)).toBe(true);
});

test("no selection includes all boundaries and pending keys; boundary-only selection never extracts keys", () => {
    const f = fixture();
    const all = storyboardFrameRequests(f.rows, f.nodes, "all", {});
    expect(all.planRows).toHaveLength(2);
    expect(all.requests.flatMap(request => request.frames)).toHaveLength(4);
    const boundary = storyboardFrameRequests(f.rows, f.nodes, "all", { frameTargets: [{ rowId: f.rows[0].id, frameId: "end" }] });
    expect(boundary.planRows).toHaveLength(0);
    expect(boundary.requests.flatMap(request => request.frames).map(frame => frame.id)).toEqual(["end"]);
});

test("placeholder resolves to extracted keys if a plan completes before confirmation", () => {
    const f = queuedPlan();
    const row = f.nodes.find(node => node.id === f.script.id)!.metadata!.storyboard!.rows[0];
    const resolved = storyboardFrameRequests([row], f.nodes, "all", { frameTargets: [{ rowId: row.id, frameId: "key-plan" }] });
    expect(resolved.planRows).toHaveLength(0);
    expect(resolved.requests[0].frames.map(frame => frame.id)).toEqual(["key-1", "key-2"]);
});

test("successful extraction durably queues its images exactly once, including after reload", () => {
    const f = queuedPlan();
    const completed = continueStoryboardFrameGeneration(JSON.parse(JSON.stringify(f.nodes)), [], "project");
    const script = completed.nodes.find(node => node.id === f.script.id)!;
    expect(script.metadata!.generationBatches).toHaveLength(2);
    expect(script.metadata!.generationBatches![0].items[0].frameGeneration).toBeUndefined();
    const images = generationBatchQueueCandidates(completed.nodes, "project");
    expect(images).toHaveLength(2);
    expect(images.every(item => item.batch.mode === "storyboard_image")).toBe(true);
    expect(images.map(item => item.node.metadata?.storyboardFrame?.frameId)).toEqual(["key-1", "key-2"]);
    expect(images.every(item => item.node.metadata?.size === settings.size && item.node.metadata?.model === imageModel)).toBe(true);
    expect(continueStoryboardFrameGeneration(completed.nodes, completed.connections, "project").nodes).toBe(completed.nodes);
    const reloaded = JSON.parse(JSON.stringify(completed.nodes));
    expect(continueStoryboardFrameGeneration(reloaded, [], "project").nodes).toBe(reloaded);
});

test("paused and cancelled extraction never starts automatic images", () => {
    const f = queuedPlan();
    const paused = pauseNodeGenerationBatches(f.nodes, f.script.id);
    expect(continueStoryboardFrameGeneration(paused, [], "project").nodes).toBe(paused);
    const cancelled = f.nodes.map(node => node.id !== f.script.id ? node : { ...node, metadata: { ...node.metadata, generationBatches: [{ ...f.batch, items: f.batch.items.map(item => ({ ...item, status: "cancelled" as const })) }] } });
    expect(continueStoryboardFrameGeneration(cancelled, [], "project").nodes).toBe(cancelled);
    const stopped = pauseNodeGenerationBatches(continueStoryboardFrameGeneration(f.nodes, [], "project").nodes, f.script.id);
    expect(generationBatchQueueCandidates(stopped, "project")).toEqual([]);
});

test("deletion, prompt changes, replacement and account/project boundaries cannot recreate images", () => {
    for (const reason of ["source", "plan", "row", "hash", "replacement", "project"]) {
        const f = queuedPlan();
        let nodes = f.nodes;
        if (reason === "source") nodes = nodes.filter(node => node.id !== f.script.id);
        if (reason === "plan") nodes = nodes.filter(node => node.id !== f.target.nodeId);
        if (["row", "hash", "replacement"].includes(reason)) nodes = nodes.map(node => node.id !== f.script.id ? node : { ...node, metadata: { ...node.metadata, storyboard: { ...node.metadata!.storyboard!, rows: reason === "row" ? [] : node.metadata!.storyboard!.rows.map(row => row.id !== f.rows[0].id ? row : { ...row, ...(reason === "hash" ? { videoMotionPrompt: "changed" } : { framePlanNodeId: "other" }) }) } } });
        const result = continueStoryboardFrameGeneration(nodes, [], reason === "project" ? "other" : "project");
        expect(result.nodes.some(node => node.type === CanvasNodeType.Image)).toBe(false);
    }
});

test("invalid extraction becomes an explicit failure without submitting an empty image prompt", () => {
    const f = queuedPlan();
    const invalid = f.nodes.map(node => node.id !== f.target.nodeId ? node : { ...node, metadata: { ...node.metadata, content: "invalid JSON" } });
    const result = continueStoryboardFrameGeneration(invalid, [], "project");
    const item = result.nodes.find(node => node.id === f.script.id)!.metadata!.generationBatches![0].items[0];
    expect(item.status).toBe("failed");
    expect(item.errorDetails).toBeTruthy();
    expect(item.frameGeneration).toBeUndefined();
    expect(result.nodes.filter(node => node.type === CanvasNodeType.Image)).toHaveLength(0);
});

test("existing extraction can acquire auto-generation without submitting another text task", () => {
    const f = queuedPlan("waiting");
    const nodes = f.nodes.map(node => node.id !== f.script.id ? node : { ...node, metadata: { ...node.metadata, generationBatches: [{ ...f.batch, items: f.batch.items.map(item => ({ ...item, frameGeneration: undefined })) }] } });
    const row = nodes.find(node => node.id === f.script.id)!.metadata!.storyboard!.rows[0];
    const result = materializeStoryboardKeyframePlans(f.script.id, [row], nodes, "text", { model: "image", settings });
    expect(result.targets).toHaveLength(0);
    expect(result.nodes).toHaveLength(nodes.length);
    expect(result.nodes.find(node => node.id === f.script.id)!.metadata!.generationBatches![0].items[0].frameGeneration?.sourcePromptHash).toBe(storyboardFrameHash(row));
    const finished = result.nodes.map(node => node.id !== f.target.nodeId ? node : { ...node, metadata: { ...node.metadata, status: "success" as const, content: JSON.stringify({ frames: [{ timeSeconds: 4, prompt: "人物抬手" }] }) } });
    const reconciled = reconcileGenerationBatches(finished, "project", new Set());
    expect(continueStoryboardFrameGeneration(reconciled, [], "project").nodes.filter(node => node.type === CanvasNodeType.Image)).toHaveLength(1);
});
