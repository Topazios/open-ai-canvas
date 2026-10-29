import { expect, test } from "bun:test";
import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { generationBatchCandidates, generationBatchQueueCandidates, generationBatchReservations, generationBatchRetryItems, pauseNodeGenerationBatches, reconcileGenerationBatches } from "../src/lib/canvas/canvas-generation-batch";
import { CanvasNodeType, type CanvasNodeData, type CanvasGenerationBatch } from "../src/types/canvas";
import { freshRuntimeLimits } from "../src/services/runtime-limits";
import { installRuntimeLimits } from "./fixtures/runtime-limits";

function fixture(mode: CanvasGenerationBatch["mode"], legacyConcurrency: number): CanvasNodeData[] {
    const targets: CanvasNodeData[] = Array.from({ length: 6 }, (_, i) => ({ id: `${mode}-${i}`, type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} }));
    const batch: CanvasGenerationBatch = { id: mode, projectId: "project", sourceNodeId: `source-${mode}`, mode, status: "queued", concurrency: legacyConcurrency, createdAt: "", updatedAt: "", items: targets.map((node) => ({ id: node.id, rowId: node.id, nodeId: node.id, status: "waiting", retryCount: 0 })) };
    return [{ ...targets[0], id: batch.sourceNodeId, metadata: { batchTable: { operation: "creative", concurrency: legacyConcurrency, rows: [] }, generationBatches: [batch] } }, ...targets];
}

test("legacy table/batch overrides never cap or expand system image/video capacity", () => {
    installRuntimeLimits({ image: 3, video: 2 }, 0);
    for (const legacy of [1, 999]) {
        const selected = generationBatchCandidates([...fixture("batch_image", legacy), ...fixture("storyboard_video", legacy)], "project", freshRuntimeLimits()!, [], { image: 0, video: 0 });
        expect(selected.filter((item) => item.batch.mode === "batch_image")).toHaveLength(3);
        expect(selected.filter((item) => item.batch.mode === "storyboard_video")).toHaveLength(2);
    }
});

test("durable queue submits every eligible item regardless of current worker capacity", () => {
    installRuntimeLimits({ image: 1 }, 1);
    expect(generationBatchQueueCandidates(fixture("batch_image", 1), "project")).toHaveLength(6);
});

test("cancelled batch item can be retried after its task receipt is reset", () => {
    installRuntimeLimits({ video: 1 }, 0);
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, {
        storyboard: {
            rows: [createStoryboardRow(1, { id: "shot-cancelled", videoMotionPrompt: "人物转身离开", videoGeneration: { taskId: "cancelled-task", taskStatus: "cancelled", errorDetails: "用户已取消" } })],
            visibleColumns: [],
            referenceNodeIds: [],
        },
    });
    const row = script.metadata!.storyboard!.rows[0];
    script.metadata!.generationBatches = [{
        id: "cancelled-batch", projectId: "project", sourceNodeId: script.id, mode: "storyboard_video", status: "cancelled", createdAt: "", updatedAt: "",
        items: [{ id: "cancelled-item", rowId: row.id, nodeId: script.id, targetKind: "storyboard_video", status: "cancelled", taskId: "cancelled-task", retryCount: 0 }],
    }];

    expect(generationBatchRetryItems([script], script.id, "cancelled-batch").map(item => item.id)).toEqual(["cancelled-item"]);
});

test("inline storyboard video ignores the script node's unrelated storyboard task", () => {
    installRuntimeLimits({ video: 2 }, 0);
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, {
        taskId: "storyboard-task",
        taskStatus: "succeeded",
        storyboard: {
            rows: [createStoryboardRow(1, { id: "shot-1", shotCode: "S1-001", videoMotionPrompt: "人物推门进入房间", durationSeconds: 8 })],
            visibleColumns: [],
            referenceNodeIds: [],
        },
    });
    const row = script.metadata!.storyboard!.rows[0];
    script.metadata!.generationBatches = [{
        id: "video-batch",
        projectId: "project",
        sourceNodeId: script.id,
        mode: "storyboard_video",
        status: "queued",
        createdAt: "",
        updatedAt: "",
        items: [{ id: "video-item", rowId: row.id, nodeId: script.id, targetKind: "storyboard_video", status: "waiting", retryCount: 0 }],
    }];

    const candidates = generationBatchCandidates([script], "project", freshRuntimeLimits()!, [], { image: 0, video: 0, text: 0 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].item.targetKind).toBe("storyboard_video");
    expect(generationBatchReservations([script], "project", [{ id: "storyboard-task" }], new Set(["video-batch:video-item"]), new Set())).toEqual({ image: 0, video: 1, text: 0 });
});

test("retrying an inline failed video is eligible even when the old row receipt remains", () => {
    installRuntimeLimits({ video: 1 }, 0);
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, {
        storyboard: {
            rows: [createStoryboardRow(1, {
                id: "shot-failed",
                videoMotionPrompt: "人物转身离开",
                videoGeneration: { taskId: "old-failed-task", taskStatus: "failed", errorDetails: "上一次超时" },
            })],
            visibleColumns: [],
            referenceNodeIds: [],
        },
    });
    const row = script.metadata!.storyboard!.rows[0];
    script.metadata!.generationBatches = [{
        id: "retry-batch",
        projectId: "project",
        sourceNodeId: script.id,
        mode: "storyboard_video",
        status: "queued",
        createdAt: "",
        updatedAt: "",
        items: [{ id: "retry-item", rowId: row.id, nodeId: script.id, targetKind: "storyboard_video", status: "waiting", retryCount: 1 }],
    }];

    expect(generationBatchCandidates([script], "project", freshRuntimeLimits()!, [], { image: 0, video: 0, text: 0 })).toHaveLength(1);
    const reconciled = reconcileGenerationBatches([script], "project", new Set());
    expect(reconciled[0].metadata!.generationBatches![0].items[0].status).toBe("waiting");
});

test("admission, account-wide category counts and pending reservations still apply", () => {
    installRuntimeLimits({ image: 9, video: 9 }, 3);
    const selected = generationBatchCandidates([...fixture("batch_image", 999), ...fixture("storyboard_video", 999)], "project", freshRuntimeLimits()!, [
        { type: "canvas_image", status: "queued" }, { type: "canvas_text", status: "running", operation: "cloud_agent_step" },
    ], { image: 1, video: 0 });
    expect(selected.filter((item) => item.batch.mode === "batch_image")).toHaveLength(1);
    expect(selected.filter((item) => item.batch.mode === "storyboard_video")).toHaveLength(3);
});

test("already submitted, completed and duplicate targets cannot be billed again", () => {
    installRuntimeLimits({ image: 20 }, 0);
    const nodes = fixture("batch_image", 999);
    nodes[1].metadata = { taskId: "persisted" };
    nodes[2].metadata = { status: "success", content: "saved" };
    nodes[0].metadata!.generationBatches!.push({ ...nodes[0].metadata!.generationBatches![0], id: "duplicate" });
    const selected = generationBatchCandidates(nodes, "project", freshRuntimeLimits()!, [], { image: 0, video: 0 });
    expect(selected).toHaveLength(4);
    expect(new Set(selected.map((item) => item.node.id)).size).toBe(4);
});

test("a submitting target reserves its node across batches before the task receipt arrives", () => {
    installRuntimeLimits({ image: 6 }, 0);
    const activeSource = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, {});
    const waitingSource = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, {});
    const target = createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, {});
    activeSource.metadata!.generationBatches = [{
        id: "active-batch", projectId: "project", sourceNodeId: activeSource.id, mode: "batch_image", status: "running", createdAt: "", updatedAt: "",
        items: [{ id: "active-item", rowId: "row-a", nodeId: target.id, status: "submitting", retryCount: 0 }],
    }];
    waitingSource.metadata!.generationBatches = [{
        id: "waiting-batch", projectId: "project", sourceNodeId: waitingSource.id, mode: "batch_image", status: "queued", createdAt: "", updatedAt: "",
        items: [{ id: "waiting-item", rowId: "row-b", nodeId: target.id, status: "waiting", retryCount: 0 }],
    }];

    expect(generationBatchCandidates([activeSource, waitingSource, target], "project", freshRuntimeLimits()!, [], { image: 0, video: 0, text: 0 })).toEqual([]);
});

test("episode pause persists, stops unsubmitted rows and keeps submitted receipts until cancellation is confirmed", () => {
    installRuntimeLimits({ video: 3 }, 0);
    const nodes = fixture("storyboard_video", 999);
    const batch = nodes[0].metadata!.generationBatches![0];
    batch.items[0] = { ...batch.items[0], status: "running", taskId: "running-task" };
    batch.items[1] = { ...batch.items[1], status: "submitting" };
    batch.items[2] = { ...batch.items[2], status: "succeeded", taskId: "done-task" };
    const original = structuredClone(nodes);
    const paused = pauseNodeGenerationBatches(nodes, batch.sourceNodeId);
    const saved = JSON.parse(JSON.stringify(paused)) as CanvasNodeData[];
    expect(saved[0].metadata!.generationBatches![0].paused).toBe(true);
    expect(saved[0].metadata!.generationBatches![0].items.map(item => item.status)).toEqual(["running", "submitting", "succeeded", "cancelled", "cancelled", "cancelled"]);
    expect(generationBatchCandidates(saved, "project", freshRuntimeLimits()!, [], { image: 0, video: 0 })).toEqual([]);
    expect(nodes).toEqual(original);
    expect(paused[1]).toBe(nodes[1]);
});

test("completed model work releases its slot while result saving is still pending", () => {
    installRuntimeLimits({ image: 6 }, 0);
    const nodes = fixture("storyboard_frames", 1);
    const batch = nodes[0].metadata!.generationBatches![0];
    batch.items[0].status = "running";
    batch.items[1].status = "running";
    nodes[1].metadata = { taskId: "finished-model", taskStatus: "running", status: "loading" };
    nodes[2].metadata = { taskId: "still-running", taskStatus: "running", status: "loading" };
    const active = [{ id: "still-running", type: "canvas_image", status: "running" }];
    const inFlight = new Set(batch.items.slice(0, 2).map(item => `${batch.id}:${item.id}`));
    const reservations = generationBatchReservations(nodes, "project", active, inFlight, new Set(["finished-model", "still-running"]));
    expect(reservations).toEqual({ image: 0, video: 0, text: 0 });
    expect(generationBatchCandidates(nodes, "project", freshRuntimeLimits()!, active, reservations)).toHaveLength(4);
});

test("preparing submissions and receipts arriving during the task query reserve capacity exactly once", () => {
    const nodes = fixture("storyboard_frames", 999);
    const batch = nodes[0].metadata!.generationBatches![0];
    nodes[1].metadata = { taskId: "new-receipt", status: "loading" };
    nodes[2].metadata = { taskId: "known-active", status: "loading" };
    nodes[3].metadata = { taskId: "known-finished", status: "loading" };
    const duplicate = { ...batch, id: "duplicate" };
    nodes[0].metadata!.generationBatches!.push(duplicate);
    const inFlight = new Set([batch, duplicate].flatMap(entry => entry.items.map(item => `${entry.id}:${item.id}`)));
    const active = [{ id: "known-active" }];
    const known = new Set(["known-active", "known-finished"]);
    // One new receipt and three references not submitted yet; active work is counted by the backend list.
    expect(generationBatchReservations(nodes, "project", active, inFlight, known)).toEqual({ image: 4, video: 0, text: 0 });
    expect(generationBatchReservations(nodes, "other-project", active, inFlight, known)).toEqual({ image: 0, video: 0, text: 0 });
    expect(generationBatchReservations(nodes.slice(0, -1), "project", active, inFlight, known).image).toBe(3);
});

test("model slots are refilled individually rather than waiting for the slowest frame", () => {
    installRuntimeLimits({ image: 6 }, 0);
    const nodes = fixture("storyboard_frames", 1);
    const batch = nodes[0].metadata!.generationBatches![0];
    const waiting = { ...nodes[1], id: "next-frame", metadata: {} };
    nodes.push(waiting);
    batch.items.push({ ...batch.items[0], id: "next-item", nodeId: waiting.id });
    nodes.slice(1, 7).forEach((node, index) => {
        node.metadata = { taskId: `task-${index}`, status: "loading" };
        batch.items[index].status = "running";
    });
    const inFlight = new Set(batch.items.slice(0, 6).map(item => `${batch.id}:${item.id}`));
    const known = new Set(nodes.flatMap(node => node.metadata?.taskId ? [node.metadata.taskId] : []));
    const active = Array.from({ length: 5 }, (_, index) => ({ id: `task-${index + 1}`, type: "canvas_image", status: "running" }));
    const pending = generationBatchReservations(nodes, "project", active, inFlight, known);
    expect(generationBatchCandidates(nodes, "project", freshRuntimeLimits()!, active, pending).map(candidate => candidate.node.id)).toEqual([waiting.id]);
});
