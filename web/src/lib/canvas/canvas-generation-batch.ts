import type { CanvasGenerationBatch, CanvasGenerationBatchStatus, CanvasGenerationBatchItem, CanvasNodeData } from "@/types/canvas";
import { availableTaskSlots } from "@/lib/task-concurrency";
import type { RuntimeLimits, RuntimeConcurrency } from "@/stores/use-user-store";
import { storyboardFramePrerequisite, storyboardFrameWaitingReason } from "./storyboard-frame-continuity";
import { resetGenerationTaskMetadata } from "./canvas-task-state";

export const generationBatchKind = (mode: CanvasGenerationBatch["mode"]) => mode === "storyboard_video" ? "video" : mode === "storyboard_keyframes" ? "text" : "image";

export function generationBatchTargetKey(item: Pick<CanvasGenerationBatchItem, "nodeId" | "rowId" | "targetKind">) {
    return item.targetKind === "storyboard_video" ? `storyboard_video:${item.nodeId}:${item.rowId}` : `node:${item.nodeId}`;
}

function inlineStoryboardVideoState(source: CanvasNodeData, item: CanvasGenerationBatchItem) {
    if (item.targetKind !== "storyboard_video") return undefined;
    return source.metadata?.storyboard?.rows.find(row => row.id === item.rowId)?.videoGeneration;
}

export function generationBatchReservations(nodes: CanvasNodeData[], projectId: string, tasks: Array<{ id: string }>, inFlightItemKeys: ReadonlySet<string>, submittedTaskIdsAtQuery: ReadonlySet<string>) {
    const reservations = { image: 0, video: 0, text: 0 };
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const activeIds = new Set(tasks.map(task => task.id));
    const counted = new Set<string>();
    for (const source of nodes) for (const batch of source.metadata?.generationBatches || []) {
        if (batch.projectId !== projectId) continue;
        for (const item of batch.items) {
            if (!inFlightItemKeys.has(`${batch.id}:${item.id}`) || counted.has(generationBatchTargetKey(item))) continue;
            const node = nodeById.get(item.nodeId);
            if (!node) continue;
            counted.add(generationBatchTargetKey(item));
            const inline = inlineStoryboardVideoState(node, item);
            // 分镜视频任务绑定在行内，脚本节点本身可能仍保留拆解任务，不能把它当成视频任务回执。
            const taskId = inline?.taskId || (item.targetKind === "storyboard_video" ? undefined : node.metadata?.taskId);
            // 回填/保存仍在执行不占模型名额；查询期间新收到的回执则预占到下次核对。
            if (!taskId || (!activeIds.has(taskId) && !submittedTaskIdsAtQuery.has(taskId))) reservations[generationBatchKind(batch.mode)]++;
        }
    }
    return reservations;
}

export function generationBatchCandidates(nodes: CanvasNodeData[], projectId: string, limits: RuntimeLimits & { concurrency: RuntimeConcurrency }, tasks: Array<{ type: string; operation?: string; status: string }>, pending: { image: number; video: number; text?: number }) {
    const capacity = (kind: "image" | "video" | "text") => availableTaskSlots(limits.activeTaskLimit > 0 ? Math.min(limits.activeTaskLimit, limits.concurrency[kind]) : limits.concurrency[kind], kind, tasks, pending[kind] || 0);
    const slots = { image: capacity("image"), video: capacity("video"), text: capacity("text") };
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const candidates: Array<{ batch: CanvasGenerationBatch; item: CanvasGenerationBatchItem; node: CanvasNodeData }> = [];
    const selected = new Set<string>();
    for (const source of nodes) {
        const latest = new Map((source.metadata?.generationBatches || []).flatMap(batch => batch.items.map(item => [generationBatchTargetKey(item), batch.id] as const)));
        for (const batch of source.metadata?.generationBatches || []) {
            if (batch.projectId !== projectId || batch.paused || batch.status === "completed" || batch.status === "cancelled") continue;
            const kind = generationBatchKind(batch.mode);
            for (const item of batch.items) {
                if (item.status !== "waiting" || slots[kind] <= 0 || selected.has(generationBatchTargetKey(item)) || latest.get(generationBatchTargetKey(item)) !== batch.id) continue;
                const node = nodeById.get(item.nodeId);
                // A persisted task/result must be reconciled, never submitted again.
                const inline = node ? inlineStoryboardVideoState(node, item) : undefined;
                const isInlineStoryboardVideo = item.targetKind === "storyboard_video";
                const inlineTaskIsTerminal = inline?.taskStatus === "failed" || inline?.taskStatus === "cancelled";
                const hasPersistedTask = item.taskId || (isInlineStoryboardVideo ? Boolean(inline?.taskId && !inlineTaskIsTerminal) : Boolean(node?.metadata?.taskId || node?.metadata?.taskReceiptRecorded));
                const hasPersistedResult = isInlineStoryboardVideo
                    ? Boolean(inline?.content || inline?.storageKey || inline?.taskStatus === "succeeded")
                    : Boolean(node?.metadata?.content || node?.metadata?.storageKey);
                const hasActiveInlineTask = isInlineStoryboardVideo && ["queued", "running"].includes(inline?.taskStatus || "");
                const hasFailedNormalNode = !isInlineStoryboardVideo && (node?.metadata?.taskStatus === "cancelled" || node?.metadata?.status === "error");
                if (!node || hasPersistedTask || hasPersistedResult || hasActiveInlineTask || hasFailedNormalNode) continue;
                if (batch.mode === "storyboard_image" && !storyboardFramePrerequisite(node, nodes).ready) continue;
                candidates.push({ batch, item, node });
                selected.add(generationBatchTargetKey(item));
                slots[kind]--;
            }
        }
    }
    return candidates;
}

export function generationBatchRetryItems(nodes: CanvasNodeData[], sourceNodeId: string, batchId: string, itemId?: string) {
    const batches = nodes.find(node => node.id === sourceNodeId)?.metadata?.generationBatches || [];
    const batch = batches.find(entry => entry.id === batchId);
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    return (batch?.items || []).filter(item => {
        if (item.status !== "failed" || itemId && item.id !== itemId || batches.findLast(entry => entry.items.some(target => generationBatchTargetKey(target) === generationBatchTargetKey(item)))?.id !== batchId) return false;
        const node = nodeById.get(item.nodeId);
        const metadata = node?.metadata;
        const inline = node ? inlineStoryboardVideoState(node, item) : undefined;
        const isInlineStoryboardVideo = item.targetKind === "storyboard_video";
        const targetTaskId = inline?.taskId || (isInlineStoryboardVideo ? undefined : metadata?.taskId);
        if (!node || inline?.content || inline?.storageKey || !isInlineStoryboardVideo && (metadata?.content || metadata?.storageKey || metadata?.taskReceiptRecorded && !metadata.taskId) || item.taskId && item.taskId !== targetTaskId) return false;
        if (["queued", "running", "succeeded", "cancelled"].includes(inline?.taskStatus || (!isInlineStoryboardVideo ? metadata?.taskStatus : "") || "") || !isInlineStoryboardVideo && metadata?.status === "loading" && metadata.taskStatus !== "failed") return false;
        return batch?.mode !== "storyboard_image" || storyboardFrameWaitingReason(node, nodes) === undefined;
    });
}

export function reconcileGenerationBatches(nodes: CanvasNodeData[], projectId: string, inFlightItemKeys: ReadonlySet<string>) {
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const restoredNodes = new Map<string, CanvasNodeData>();
    let changed = false;
    const next = nodes.map(source => {
        const batches = source.metadata?.generationBatches;
        if (!batches?.length) return source;
        let sourceChanged = false;
        const latest = new Map(batches.flatMap(batch => batch.items.map(item => [generationBatchTargetKey(item), batch.id] as const)));
        const generationBatches = batches.map(batch => {
            if (batch.projectId !== projectId) return batch;
            let batchChanged = false;
            const items = batch.items.map(item => {
                if (item.status === "succeeded" || item.status === "cancelled" || latest.get(generationBatchTargetKey(item)) !== batch.id) return item;
                const node = nodeById.get(item.nodeId);
                const inline = node ? inlineStoryboardVideoState(node, item) : undefined;
                const inFlight = inFlightItemKeys.has(`${batch.id}:${item.id}`);
                const waitingReason = node && batch.mode === "storyboard_image" && !batch.paused && !item.taskId && !inFlight && (item.status !== "failed" || node.metadata?.status === "error")
                    ? storyboardFrameWaitingReason(node, nodes) : undefined;
                let patch: Partial<CanvasGenerationBatchItem> | undefined;
                if (waitingReason !== undefined) {
                    patch = { status: "waiting", errorDetails: waitingReason || undefined, costUncertain: false };
                    if (node!.metadata?.status === "error") restoredNodes.set(node!.id, { ...node!, metadata: resetGenerationTaskMetadata(node!.metadata) });
                } else if (item.status === "failed") {
                    return item;
                } else if (!node) {
                    patch = { status: "failed", errorDetails: "目标节点已不存在" };
                } else if (inline && (inline.taskStatus === "succeeded" || inline.content || inline.storageKey)) {
                    patch = { status: "succeeded", taskId: inline.taskId, errorDetails: undefined, costUncertain: false };
                } else if (item.targetKind !== "storyboard_video" && node?.metadata?.status === "success" && (node.metadata.content || node.metadata.storageKey)) {
                    patch = { status: "succeeded", taskId: node.metadata.taskId, errorDetails: undefined, costUncertain: false };
                } else if ((inline?.taskStatus === "cancelled" || inline?.taskStatus === "failed") && !(item.status === "waiting" && !item.taskId)) {
                    const errorDetails = inline.errorDetails || "生成失败";
                    patch = { status: inline.taskStatus === "cancelled" ? "cancelled" : "failed", taskId: inline.taskId, errorDetails, costUncertain: isGenerationCostUncertainError(new Error(errorDetails)) };
                } else if (item.targetKind !== "storyboard_video" && (node?.metadata?.taskStatus === "cancelled" || node?.metadata?.status === "error")) {
                    const errorDetails = node.metadata.errorDetails || "生成失败";
                    patch = { status: node.metadata.taskStatus === "cancelled" ? "cancelled" : "failed", taskId: node.metadata.taskId, errorDetails, costUncertain: isGenerationCostUncertainError(new Error(errorDetails)) };
                } else if ((inline?.taskId && inline.taskStatus !== "failed" && inline.taskStatus !== "cancelled") || (item.targetKind !== "storyboard_video" && node?.metadata?.taskId)) {
                    const taskStatus = inline?.taskStatus || node?.metadata?.taskStatus;
                    // Model success still waits for the media to be saved on the node. For an inline
                    // storyboard video, only the row task is valid; the script task is unrelated.
                    const taskId = inline?.taskId || (item.targetKind === "storyboard_video" ? undefined : node.metadata?.taskId);
                    if (taskId) patch = { taskId, status: taskStatus === "queued" ? "queued" : taskStatus === "failed" ? "failed" : "running", errorDetails: undefined };
                } else if (item.status === "submitting" && !inFlight) {
                    patch = { status: "waiting", errorDetails: undefined };
                } else if (batch.mode === "storyboard_image" && item.status === "waiting") {
                    const dependency = storyboardFramePrerequisite(node, nodes);
                    patch = { errorDetails: dependency.ready ? undefined : dependency.reason };
                }
                if (!patch || !Object.entries(patch).some(([key, value]) => item[key as keyof CanvasGenerationBatchItem] !== value)) return item;
                batchChanged = true;
                return { ...item, ...patch };
            });
            const nextBatch = batchChanged ? { ...batch, items } : batch;
            const status = generationBatchStatus(nextBatch);
            if (!batchChanged && status === batch.status) return batch;
            sourceChanged = true;
            return { ...nextBatch, status, updatedAt: new Date().toISOString() };
        });
        if (!sourceChanged) return source;
        changed = true;
        return { ...source, metadata: { ...source.metadata, generationBatches } };
    });
    return restoredNodes.size ? next.map(node => restoredNodes.get(node.id) || node) : changed ? next : nodes;
}

const TASK_CAPACITY_MESSAGE = /同时排队或运行的任务最多 \d+ 个/;

export function pauseNodeGenerationBatches(nodes: CanvasNodeData[], sourceNodeId: string) {
    return nodes.map(node => node.id !== sourceNodeId ? node : {
        ...node, metadata: { ...node.metadata, generationBatches: (node.metadata?.generationBatches || []).map(batch => {
            const items = batch.items.map(item => item.status === "waiting" ? { ...item, status: "cancelled" as const } : item);
            return { ...batch, paused: true, items, status: generationBatchStatus({ ...batch, items }), updatedAt: new Date().toISOString() };
        }) },
    });
}

export function isGenerationTaskCapacityError(error: unknown) {
    return error instanceof Error && TASK_CAPACITY_MESSAGE.test(error.message);
}

export function isGenerationCostUncertainError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error || "");
    return /(?:^|\D)524(?:\D|$)|费用状态不确定|扣费状态不确定|可能已经产生费用/i.test(message);
}

export function generationBatchStatus(batch: CanvasGenerationBatch): CanvasGenerationBatchStatus {
    const statuses = batch.items.map((item) => item.status);
    if (statuses.length > 0 && statuses.every((status) => status === "succeeded")) return "completed";
    if (statuses.some((status) => status === "waiting" || status === "submitting" || status === "queued" || status === "running")) {
        return statuses.some((status) => status !== "waiting") ? "running" : "queued";
    }
    if (statuses.some((status) => status === "failed")) return "partial_failed";
    return "cancelled";
}
