import { expect, test } from "bun:test";
import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { failedStoryboardBoundaryImages, materializeStoryboardFrames, storyboardBoundaryFrames } from "@/lib/canvas/episode-storyboard-frames";
import { storyboardFramePrerequisite, storyboardContinuitySnapshot } from "@/lib/canvas/storyboard-frame-continuity";
import { ensureStoryboardFramesGroup, reconcileStoryboardFramesGroups } from "@/lib/canvas/storyboard-frame-groups";
import { storyboardFrameIsCurrent } from "@/lib/canvas/workflow-episode-storyboard";
import { buildNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { generationBatchCandidates, generationBatchRetryItems, reconcileGenerationBatches } from "@/lib/canvas/canvas-generation-batch";
import { freshRuntimeLimits } from "@/services/runtime-limits";
import { installRuntimeLimits } from "./fixtures/runtime-limits";
import { CanvasNodeType, StoryboardFrameKind, StoryboardStartFrameMode, type CanvasNodeData, type CanvasGenerationBatch } from "@/types/canvas";
import { pauseNodeGenerationBatches } from "@/lib/canvas/canvas-generation-batch";

function fixture(independent = false) {
    const rows = [1, 2, 3].map(i => createStoryboardRow(i, { id: `shot-${i}`, shotCode: `S1-${i}`, durationSeconds: 10, videoMotionPrompt: `人物抬手后坐下，镜头${i}，保持原服装和房间。`, startFrameMode: independent ? StoryboardStartFrameMode.Independent : undefined }));
    const script = createCanvasNode(CanvasNodeType.Script, { x: 0, y: 0 }, { storyboard: { rows, visibleColumns: [], referenceNodeIds: [] }, shortDrama: { stage: "storyboard", step: "direction.shots", role: "document", pipelineId: "p", episodeNumber: 1, sourceNodeIds: [], sourceSignatures: {} } });
    const result = materializeStoryboardFrames(script, rows.map(row => ({ row, frames: storyboardBoundaryFrames(row) })), [script], [], "image", { size: "9:16", quality: "standard", transparentBackground: "false" });
    const batch: CanvasGenerationBatch = { id: "frames", projectId: "project", sourceNodeId: script.id, mode: "storyboard_image", status: "queued", createdAt: "", updatedAt: "", items: result.targets.map(target => ({ ...target, id: target.nodeId, status: "waiting", retryCount: 0 })) };
    const nodes = result.nodes.map(node => node.id === script.id ? { ...node, metadata: { ...node.metadata, generationBatches: [batch] } } : node);
    return { ...result, script: nodes.find(node => node.id === script.id)!, nodes };
}
const complete = (nodes: CanvasNodeData[], id: string) => nodes.map(node => node.id === id ? { ...node, metadata: { ...node.metadata, status: "success" as const, content: "blob:preview", storageKey: `resource:${id}` } } : node);
const candidates = (nodes: CanvasNodeData[]) => generationBatchCandidates(nodes, "project", freshRuntimeLimits()!, [], { image: 0, video: 0 });

test("continuous boundaries wait for actual images, then use the shared previous tail without duplicate charges", () => {
    installRuntimeLimits({ image: 6, text: 3, video: 2 }, 0);
    const f = fixture();
    expect(f.targets).toHaveLength(4);
    expect(candidates(f.nodes).map(item => item.node.id)).toEqual([f.targets[0].nodeId]);
    const end = f.nodes.find(node => node.id === f.targets[1].nodeId)!;
    expect(() => buildNodeGenerationContext(end.id, f.nodes, f.connections, end.metadata!.composerContent!, [])).toThrow("等待首帧");
    let nodes = complete(f.nodes, f.targets[0].nodeId);
    expect(candidates(nodes).map(item => item.node.id)).toEqual([end.id]);
    const context = buildNodeGenerationContext(end.id, nodes, f.connections, end.metadata!.composerContent!, []);
    expect(context.referenceImages.map(image => image.id)).toEqual([f.targets[0].nodeId]);
    expect(context.prompt).toContain("当前镜头连续性参考");
    expect(context.prompt).toContain("人物身份及其他未变化项继续保持");
    nodes = complete(nodes, end.id);
    expect(candidates(nodes).map(item => item.node.id)).toEqual([f.targets[2].nodeId]);
    const next = nodes.find(node => node.id === f.targets[2].nodeId)!;
    expect(buildNodeGenerationContext(next.id, nodes, f.connections, next.metadata!.composerContent!, []).referenceImages[0].id).toBe(end.id);
});

test("independent scenes use all global image slots and failures block only their own dependents", () => {
    installRuntimeLimits({ image: 6, text: 3, video: 2 }, 0);
    const f = fixture(true);
    expect(candidates(f.nodes)).toHaveLength(3);
    let nodes = f.nodes;
    for (const target of f.targets.filter((_, index) => index % 2 === 0)) nodes = complete(nodes, target.nodeId);
    expect(candidates(nodes)).toHaveLength(3);
    const failedStart = f.targets[0].nodeId;
    nodes = nodes.map(node => node.id === failedStart ? { ...node, metadata: { ...node.metadata, content: undefined, storageKey: undefined, status: "error" as const, taskId: "failed", taskStatus: "failed" as const } } : node);
    expect(candidates(nodes)).toHaveLength(2);
    expect(storyboardFramePrerequisite(nodes.find(node => node.id === f.targets[1].nodeId)!, nodes).reason).toContain("先重试首帧");
    expect(candidates(JSON.parse(JSON.stringify(nodes)))).toHaveLength(2);
});

test("failed root retries in place while unsubmitted descendants recover to waiting and advance on actual images", () => {
    installRuntimeLimits({ image: 6, text: 3, video: 2 }, 0);
    const f = fixture();
    const rootId = f.targets[0].nodeId;
    const failed = f.nodes.map(node => {
        if (node.metadata?.storyboardFrame) return { ...node, metadata: { ...node.metadata, status: "error" as const,
            errorDetails: node.id === rootId ? "read tcp: i/o timeout" : "首帧生成失败，请先重试首帧",
            ...(node.id === rootId ? { taskId: "failed-root", taskStatus: "failed", taskReceiptRecorded: true, taskProgress: 100, taskStage: "failed", taskCompletedAt: "old-time", taskClientOperationId: "old-operation", attemptGroupId: "old-attempt" } : {}),
        } };
        return node.id === f.script.id ? { ...node, metadata: { ...node.metadata, generationBatches: node.metadata!.generationBatches!.map(batch => ({ ...batch, status: "partial_failed" as const, items: batch.items.map(item => ({ ...item, status: "failed" as const, ...(item.nodeId === rootId ? { taskId: "failed-root" } : {}) })) })) } } : node;
    });
    const recovered = reconcileGenerationBatches(JSON.parse(JSON.stringify(failed)), "project", new Set());
    let script = recovered.find(node => node.id === f.script.id)!;
    expect(script.metadata!.generationBatches![0].items.map(item => item.status)).toEqual(["failed", "waiting", "waiting", "waiting"]);
    expect(recovered.find(node => node.id === rootId)).toEqual(failed.find(node => node.id === rootId));
    expect(recovered.filter(node => f.targets.slice(1).some(target => target.nodeId === node.id)).every(node => node.metadata?.status === "idle" && !node.metadata.errorDetails)).toBe(true);
    expect(candidates(recovered)).toEqual([]);
    expect(failedStoryboardBoundaryImages(script, failed).map(node => node.id)).toEqual([rootId]);
    expect(failedStoryboardBoundaryImages(script, recovered).map(node => node.id)).toEqual([rootId]);

    const retry = materializeStoryboardFrames(script, script.metadata!.storyboard!.rows.map(row => ({ row, frames: storyboardBoundaryFrames(row) })), recovered, f.connections, "retry-model", { size: "9:16", quality: "standard", transparentBackground: "false" }, { failedOnly: true });
    expect(retry.targets.map(target => target.nodeId)).toEqual([rootId]);
    const metadata = retry.nodes.find(node => node.id === rootId)!.metadata!;
    expect(metadata.status).toBe("idle");
    for (const key of ["taskId", "taskStatus", "taskReceiptRecorded", "taskProgress", "taskStage", "taskCompletedAt", "taskClientOperationId", "attemptGroupId"]) expect(metadata[key as keyof typeof metadata]).toBeUndefined();
    script = retry.nodes.find(node => node.id === f.script.id)!;
    const retryBatch: CanvasGenerationBatch = { ...script.metadata!.generationBatches![0], id: "retry-root", status: "queued", items: [{ ...retry.targets[0], id: "retry-item", status: "waiting", retryCount: 1 }] };
    let nodes = retry.nodes.map(node => node.id === script.id ? { ...node, metadata: { ...node.metadata, generationBatches: [...node.metadata!.generationBatches!, retryBatch] } } : node);
    expect(candidates(nodes).map(item => item.node.id)).toEqual([rootId]);
    for (let index = 0; index < f.targets.length; index++) {
        nodes = reconcileGenerationBatches(complete(nodes, f.targets[index].nodeId), "project", new Set());
        expect(candidates(nodes).map(item => item.node.id)).toEqual(f.targets.slice(index + 1, index + 2).map(target => target.nodeId));
    }
    const batches = nodes.find(node => node.id === script.id)!.metadata!.generationBatches!;
    expect(batches[0].items[0]).toMatchObject({ status: "failed", taskId: "failed-root" });
    expect(batches[0].items.slice(1).every(item => item.status === "succeeded")).toBe(true);
    expect(batches[1].status).toBe("completed");
    expect(reconcileGenerationBatches(nodes, "project", new Set())).toBe(nodes);
});

test("dependency recovery preserves own tasks, receipts, results, cancellations and unrelated failures", () => {
    const f = fixture(true);
    const [root, paid, receipt, result, cancelled, invalid] = f.targets.map(target => target.nodeId);
    const nodes = f.nodes.map(node => {
        if (!node.metadata?.storyboardFrame) return node;
        return { ...node, metadata: { ...node.metadata, status: "error" as const, errorDetails: "首帧生成失败，请先重试首帧",
            ...(node.id === root ? { taskId: "root-task", taskStatus: "failed" } : {}),
            ...(node.id === paid ? { taskId: "paid-task", taskStatus: "failed", taskReceiptRecorded: true } : {}),
            ...(node.id === receipt ? { taskReceiptRecorded: true } : {}),
            ...(node.id === result ? { status: "success" as const, storageKey: "resource:result" } : {}),
            ...(node.id === cancelled ? { taskStatus: "cancelled" } : {}),
            ...(node.id === invalid ? { errorDetails: "提示词超长" } : {}),
        } };
    });
    const recovered = reconcileGenerationBatches(nodes, "project", new Set());
    for (const target of f.targets) expect(recovered.find(node => node.id === target.nodeId)).toBe(nodes.find(node => node.id === target.nodeId));
    expect(recovered.find(node => node.id === f.script.id)!.metadata!.generationBatches![0].items.map(item => item.status)).toEqual(["failed", "failed", "failed", "succeeded", "cancelled", "failed"]);
    expect(candidates(recovered)).toEqual([]);
    const script = recovered.find(node => node.id === f.script.id)!;
    expect(failedStoryboardBoundaryImages(script, recovered).some(node => node.id === cancelled)).toBe(false);
});

test("dependency errors recover after the anchor finished, but paused and in-flight batches keep their state", () => {
    installRuntimeLimits({ image: 6 }, 0);
    const f = fixture(true);
    let nodes = complete(f.nodes, f.targets[0].nodeId);
    const endId = f.targets[1].nodeId;
    nodes = nodes.map(node => node.id === endId ? { ...node, metadata: { ...node.metadata, status: "error" as const, errorDetails: "等待首帧完成后保持画面一致性" } } : node);
    const recovered = reconcileGenerationBatches(nodes, "project", new Set());
    expect(candidates(recovered).some(item => item.node.id === endId)).toBe(true);
    expect(reconcileGenerationBatches(nodes, "other-project", new Set())).toBe(nodes);
    const paused = pauseNodeGenerationBatches(nodes, f.script.id);
    expect(reconcileGenerationBatches(paused, "project", new Set()).find(node => node.id === endId)).toBe(nodes.find(node => node.id === endId));
    const submitting = nodes.map(node => node.id === f.script.id ? { ...node, metadata: { ...node.metadata, generationBatches: node.metadata!.generationBatches!.map(batch => ({ ...batch, items: batch.items.map(item => item.nodeId === endId ? { ...item, status: "submitting" as const } : item) })) } } : node);
    expect(reconcileGenerationBatches(submitting, "project", new Set([`frames:${endId}`])).find(node => node.id === endId)).toBe(nodes.find(node => node.id === endId));
});

test("failed-only restores orphaned pending descendants without duplicating active, cancelled or independent chains", () => {
    installRuntimeLimits({ image: 6 }, 0);
    const f = fixture();
    const rootId = f.targets[0].nodeId;
    const nodes = f.nodes.map(node => node.id === rootId ? { ...node, metadata: { ...node.metadata, status: "error" as const, errorDetails: "upstream temporarily unavailable", taskId: "root-failed", taskStatus: "failed" } } : node.id === f.script.id ? { ...node, metadata: { ...node.metadata, generationBatches: [] } } : node);
    const script = nodes.find(node => node.id === f.script.id)!;
    const requests = script.metadata!.storyboard!.rows.map(row => ({ row, frames: storyboardBoundaryFrames(row) }));
    const retry = materializeStoryboardFrames(script, requests, nodes, f.connections, "image", { size: "9:16", quality: "standard", transparentBackground: "false" }, { failedOnly: true });
    expect(retry.targets.map(target => target.nodeId)).toEqual(f.targets.map(target => target.nodeId));
    expect(retry.nodes.find(node => node.id === rootId)!.metadata!.taskId).toBeUndefined();
    expect(nodes.find(node => node.id === rootId)!.metadata!.taskId).toBe("root-failed");
    expect(retry.nodes.filter(node => node.metadata?.storyboardFrame)).toHaveLength(4);
    expect(retry.targets.slice(1).every(target => !storyboardFramePrerequisite(retry.nodes.find(node => node.id === target.nodeId)!, retry.nodes).ready)).toBe(true);

    const independent = fixture(true);
    const independentRoot = independent.targets[0].nodeId;
    const independentNodes = independent.nodes.map(node => node.id === independentRoot ? { ...node, metadata: { ...node.metadata, status: "error" as const, taskId: "independent-failed", taskStatus: "failed" } } : node.id === independent.script.id ? { ...node, metadata: { ...node.metadata, generationBatches: [] } } : node);
    const independentScript = independentNodes.find(node => node.id === independent.script.id)!;
    const result = materializeStoryboardFrames(independentScript, independentScript.metadata!.storyboard!.rows.map(row => ({ row, frames: storyboardBoundaryFrames(row) })), independentNodes, independent.connections, "image", { size: "9:16", quality: "standard", transparentBackground: "false" }, { failedOnly: true });
    expect(result.targets.map(target => target.nodeId)).toEqual(independent.targets.slice(0, 2).map(target => target.nodeId));

    const cancelled = nodes.map(node => node.id === script.id ? { ...node, metadata: { ...node.metadata, generationBatches: [{ ...f.script.metadata!.generationBatches![0], items: [{ ...f.script.metadata!.generationBatches![0].items[1], status: "cancelled" as const }] }] } } : node);
    const cancelledScript = cancelled.find(node => node.id === script.id)!;
    expect(materializeStoryboardFrames(cancelledScript, requests, cancelled, f.connections, "image", { size: "9:16", quality: "standard", transparentBackground: "false" }, { failedOnly: true }).targets.map(target => target.nodeId)).toEqual([rootId]);
});

test("retry selection excludes dependency errors and superseded paid attempts while retaining genuine root errors", () => {
    const f = fixture();
    const rootId = f.targets[0].nodeId, endId = f.targets[1].nodeId;
    const nodes = f.nodes.map(node => node.metadata?.storyboardFrame ? { ...node, metadata: { ...node.metadata, status: "error" as const,
        errorDetails: node.id === rootId ? "read tcp: socket forcibly closed" : "首帧生成失败，请先重试首帧",
        ...(node.id === rootId ? { taskId: "root-failed", taskStatus: "failed" } : {}),
    } } : node.id === f.script.id ? { ...node, metadata: { ...node.metadata, generationBatches: node.metadata!.generationBatches!.map(batch => ({ ...batch, status: "partial_failed" as const, items: batch.items.map(item => ({ ...item, status: "failed" as const })) })) } } : node);
    expect(generationBatchRetryItems(nodes, f.script.id, "frames").map(item => item.nodeId)).toEqual([rootId]);
    const paid = nodes.map(node => node.id === endId ? { ...node, metadata: { ...node.metadata, taskId: "paid-end", taskStatus: "failed", taskReceiptRecorded: true } } : node);
    expect(generationBatchRetryItems(paid, f.script.id, "frames").map(item => item.nodeId)).toEqual([rootId, endId]);
    const retry: CanvasGenerationBatch = { ...f.script.metadata!.generationBatches![0], id: "new-root", items: [{ ...f.script.metadata!.generationBatches![0].items[0], status: "running", taskId: "running-root" }] };
    const superseded = paid.map(node => node.id === rootId ? { ...node, metadata: { ...node.metadata, taskId: "running-root", taskStatus: "running", status: "loading" as const } } : node.id === f.script.id ? { ...node, metadata: { ...node.metadata, generationBatches: [...node.metadata!.generationBatches!, retry] } } : node);
    expect(generationBatchRetryItems(superseded, f.script.id, "frames").map(item => item.nodeId)).toEqual([endId]);
    const reconciled = reconcileGenerationBatches(superseded, "project", new Set());
    expect(reconciled.find(node => node.id === rootId)).toBe(superseded.find(node => node.id === rootId));
    expect(reconciled.find(node => node.id === endId)).toBe(superseded.find(node => node.id === endId));
});

test("failed-only clears a stale failed taskId from a dependency descendant while retaining the failed root", () => {
    const f = fixture();
    const rootId = f.targets[0].nodeId, descendantId = f.targets[1].nodeId;
    const nodes = f.nodes.map(node => {
        if (node.id === rootId) return { ...node, metadata: { ...node.metadata, status: "error" as const, errorDetails: "read tcp: socket forcibly closed", taskId: "root-failed", taskStatus: "failed" } };
        if (node.id === descendantId) return { ...node, metadata: { ...node.metadata, status: "error" as const, errorDetails: "首帧生成失败，请先重试首帧", taskId: "stale-descendant", taskStatus: "failed" } };
        if (node.id === f.script.id) return { ...node, metadata: { ...node.metadata, generationBatches: node.metadata!.generationBatches!.map(batch => ({ ...batch, status: "partial_failed" as const, items: batch.items.map(item => item.nodeId === rootId ? { ...item, status: "failed" as const, taskId: "root-failed" } : item.nodeId === descendantId ? { ...item, status: "failed" as const, taskId: "stale-descendant" } : item) })) } };
        return node;
    });
    const script = nodes.find(node => node.id === f.script.id)!;
    const retried = materializeStoryboardFrames(script, script.metadata!.storyboard!.rows.map(row => ({ row, frames: storyboardBoundaryFrames(row) })), nodes, f.connections, "retry-model", { size: "9:16", quality: "standard", transparentBackground: "false" }, { failedOnly: true });
    expect(retried.targets.map(target => target.nodeId)).toEqual([rootId, descendantId]);
    expect(retried.nodes.find(node => node.id === rootId)!.metadata!.taskId).toBeUndefined();
    expect(retried.nodes.find(node => node.id === descendantId)!.metadata!.taskId).toBeUndefined();
    expect(retried.nodes.find(node => node.id === descendantId)!.metadata!.status).toBe("idle");
});

test("continuity snapshots survive URL refresh and reject a changed or removed anchor", () => {
    const f = fixture();
    let nodes = complete(f.nodes, f.targets[0].nodeId);
    const end = nodes.find(node => node.id === f.targets[1].nodeId)!;
    const snapshot = storyboardContinuitySnapshot(end, nodes)!;
    nodes = nodes.map(node => node.id === end.id ? { ...node, metadata: { ...node.metadata, storyboardFrame: { ...node.metadata!.storyboardFrame!, continuityReference: snapshot } } } : node);
    const row = f.script.metadata!.storyboard!.rows[0];
    const frame = row.frames!.find(frame => frame.kind === "end")!;
    expect(storyboardFrameIsCurrent(row, frame, nodes)).toBe(true);
    expect(storyboardFrameIsCurrent(row, frame, nodes.map(node => node.id === snapshot.nodeId ? { ...node, metadata: { ...node.metadata, content: "blob:refreshed" } } : node))).toBe(true);
    expect(storyboardFrameIsCurrent(row, frame, nodes.map(node => node.id === snapshot.nodeId ? { ...node, metadata: { ...node.metadata, storageKey: "resource:new" } } : node))).toBe(false);
    expect(storyboardFrameIsCurrent(row, frame, nodes.filter(node => node.id !== snapshot.nodeId))).toBe(false);
});

test("one episode reuses a stable group across storyboard versions without reusing their images", () => {
    const f = fixture();
    const nextScript = { ...f.script, id: "new-script", metadata: { ...f.script.metadata, storyboard: { ...f.script.metadata!.storyboard!, rows: f.script.metadata!.storyboard!.rows.map(row => ({ ...row, id: `new-${row.id}`, frames: undefined })) } } };
    const next = materializeStoryboardFrames(nextScript, nextScript.metadata.storyboard.rows.map(row => ({ row, frames: storyboardBoundaryFrames(row) })), [...f.nodes, nextScript], f.connections, "image", { size: "9:16", quality: "standard", transparentBackground: "false" });
    expect(next.nodes.filter(node => node.metadata?.storyboardFramesGroup)).toHaveLength(1);
    expect(next.targets.every(target => !f.targets.some(old => old.nodeId === target.nodeId))).toBe(true);
    expect(next.connections.some(edge => edge.fromNodeId === nextScript.id && edge.toNodeId === cleanGroupId(f.nodes))).toBe(true);
    expect(storyboardFramePrerequisite(next.nodes.find(node => node.id === next.targets[1].nodeId)!, complete(next.nodes, f.targets[0].nodeId)).ready).toBe(false);
    const clean = ensureStoryboardFramesGroup(f.script, [], []);
    expect(ensureStoryboardFramesGroup(f.script, [], []).group.id).toBe(clean.group.id);
    const other = { ...f.script, metadata: { ...f.script.metadata, shortDrama: { ...f.script.metadata!.shortDrama!, pipelineId: "other" } } };
    expect(ensureStoryboardFramesGroup(other, f.nodes, []).group.id).not.toBe(clean.group.id);
});

const cleanGroupId = (nodes: CanvasNodeData[]) => nodes.find(node => node.metadata?.storyboardFramesGroup)!.id;

test("keyframes share their own start anchor and become parallel after it succeeds", () => {
    installRuntimeLimits({ image: 6, text: 3, video: 2 }, 0);
    const f = fixture(true), row = f.script.metadata!.storyboard!.rows[0];
    const result = materializeStoryboardFrames(f.script, [{ row, frames: [1, 2].map(i => ({ id: `key-${i}`, kind: StoryboardFrameKind.Key, timeSeconds: i, prompt: `人物在第${i}秒抬手`, sourcePromptHash: row.frames![0].sourcePromptHash })) }], f.nodes, f.connections, "image", { size: "9:16", quality: "standard", transparentBackground: "false" });
    const keyNodes = result.targets.map(target => result.nodes.find(node => node.id === target.nodeId)!);
    expect(keyNodes).toHaveLength(2);
    expect(keyNodes.every(node => !storyboardFramePrerequisite(node, result.nodes).ready)).toBe(true);
    const ready = complete(result.nodes, f.targets[0].nodeId);
    expect(keyNodes.every(node => storyboardFramePrerequisite(node, ready).reference?.id === f.targets[0].nodeId)).toBe(true);
    const paused = pauseNodeGenerationBatches(f.nodes, f.script.id);
    expect(candidates(JSON.parse(JSON.stringify(paused)))).toHaveLength(0);
});

test("changing a completed anchor preserves old outputs but makes every downstream boundary a new version", () => {
    const f = fixture();
    let nodes = f.nodes;
    for (const target of f.targets) {
        const image = nodes.find(node => node.id === target.nodeId)!;
        const snapshot = storyboardContinuitySnapshot(image, nodes);
        nodes = complete(nodes, target.nodeId).map(node => node.id === image.id ? { ...node, metadata: { ...node.metadata, storyboardFrame: { ...node.metadata!.storyboardFrame!, continuityReference: snapshot } } } : node);
    }
    nodes = nodes.map(node => node.id === f.targets[0].nodeId ? { ...node, metadata: { ...node.metadata, storageKey: "resource:replacement" } } : node);
    const script = nodes.find(node => node.id === f.script.id)!;
    const rows = script.metadata!.storyboard!.rows;
    expect(rows.slice(1).every(row => !storyboardFrameIsCurrent(row, row.frames![0], nodes))).toBe(true);
    const next = materializeStoryboardFrames(script, rows.map(row => ({ row, frames: storyboardBoundaryFrames(row) })), nodes, f.connections, "image", { size: "9:16", quality: "standard", transparentBackground: "false" });
    expect(next.targets).toHaveLength(3);
    expect(next.targets.every(target => !f.targets.some(old => old.nodeId === target.nodeId))).toBe(true);
    expect(f.targets.every(target => next.nodes.some(node => node.id === target.nodeId && node.metadata?.content))).toBe(true);
});

test("loading duplicate episode groups preserves media IDs, tasks and version owners and reconnects their edges", () => {
    const f = fixture();
    const group = f.nodes.find(node => node.metadata?.storyboardFramesGroup)!;
    const duplicate = { ...group, id: "duplicate-group", metadata: { ...group.metadata, storyboardFramesGroup: { scriptId: "deleted-old-script" } } };
    const old = { ...f.nodes.find(node => node.id === f.targets[0].nodeId)!, id: "old-image", parentId: duplicate.id, metadata: { ...f.nodes.find(node => node.id === f.targets[0].nodeId)!.metadata, taskId: "paid-old-task", storyboardFrame: { ...f.nodes.find(node => node.id === f.targets[0].nodeId)!.metadata!.storyboardFrame!, scriptId: "deleted-old-script" } } };
    const fixed = reconcileStoryboardFramesGroups([...f.nodes, duplicate, old], [...f.connections, { id: "duplicate-edge", fromNodeId: f.script.id, toNodeId: duplicate.id }]);
    expect(fixed.nodes.filter(node => node.metadata?.storyboardFramesGroup)).toHaveLength(1);
    expect(fixed.nodes.find(node => node.id === old.id)).toEqual({ ...old, parentId: group.id });
    expect(fixed.connections.some(edge => edge.toNodeId === duplicate.id)).toBe(false);
    expect(reconcileStoryboardFramesGroups(fixed.nodes, fixed.connections).nodes).toBe(fixed.nodes);
});
