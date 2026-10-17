import type { CanvasGenerationBatch, CanvasGenerationBatchStatus, CanvasGenerationBatchItem, CanvasNodeData } from "@/types/canvas";
import { availableTaskSlots } from "@/lib/task-concurrency";
import type { RuntimeLimits, RuntimeConcurrency } from "@/stores/use-user-store";

export function generationBatchCandidates(nodes: CanvasNodeData[], projectId: string, limits: RuntimeLimits & { concurrency: RuntimeConcurrency }, tasks: Array<{ type: string; operation?: string; status: string }>, pending: { image: number; video: number }) {
    const capacity = (kind: "image" | "video") => availableTaskSlots(limits.activeTaskLimit > 0 ? Math.min(limits.activeTaskLimit, limits.concurrency[kind]) : limits.concurrency[kind], kind, tasks, pending[kind]);
    const slots = { image: capacity("image"), video: capacity("video") };
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const candidates: Array<{ batch: CanvasGenerationBatch; item: CanvasGenerationBatchItem; node: CanvasNodeData }> = [];
    const selected = new Set<string>();
    for (const source of nodes) {
        for (const batch of source.metadata?.generationBatches || []) {
            if (batch.projectId !== projectId || batch.status === "completed" || batch.status === "cancelled") continue;
            const kind = batch.mode === "storyboard_video" ? "video" : "image";
            for (const item of batch.items) {
                if (item.status !== "waiting" || slots[kind] <= 0 || selected.has(item.nodeId)) continue;
                const node = nodeById.get(item.nodeId);
                // A persisted task/result must be reconciled, never submitted again.
                if (!node || node.metadata?.taskId || (node.metadata?.status === "success" && node.metadata.content)) continue;
                candidates.push({ batch, item, node });
                selected.add(item.nodeId);
                slots[kind]--;
            }
        }
    }
    return candidates;
}

const TASK_CAPACITY_MESSAGE = /同时排队或运行的任务最多 \d+ 个/;

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
