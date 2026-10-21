import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";

import { generationBatchCandidates, generationBatchKind, generationBatchReservations, generationBatchRetryItems, generationBatchStatus, pauseNodeGenerationBatches, reconcileGenerationBatches } from "@/lib/canvas/canvas-generation-batch";
import { buildGenerationConfig, createGenerationRetryContext, generationTaskMetadata, resetGenerationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { unchangedModeratedPrompt } from "@/lib/generation-error";
import { cancelGenerationTask, listGenerationTasks, type GenerationTask } from "@/services/api/task-center";
import { readRuntimeLimits } from "@/services/runtime-limits";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { getActiveUserScope } from "@/lib/user-scope";
import type { CanvasGenerationBatch, CanvasGenerationBatchItem, CanvasGenerationBatchMode, CanvasNodeData } from "@/types/canvas";

import type { CanvasNodeGenerationOptions } from "./use-canvas-generation-executor";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";

const SCHEDULER_INTERVAL_MS = 2_000;
const MAX_BATCH_HISTORY = 20;

type BatchTarget = Pick<CanvasGenerationBatchItem, "rowId" | "nodeId">;

type UseCanvasGenerationBatchesOptions = {
    projectId: string;
    projectLoaded: boolean;
    nodes: CanvasNodeData[];
    nodesRef: { current: CanvasNodeData[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    handleGenerateNode: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, options?: CanvasNodeGenerationOptions) => Promise<void>;
    persistBatches: () => Promise<void>;
};

export function useCanvasGenerationBatches({ projectId, projectLoaded, nodes, nodesRef, setNodes, handleGenerateNode, persistBatches }: UseCanvasGenerationBatchesOptions) {
    const { message, modal } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const policyErrorRef = useRef("");
    const schedulingRef = useRef(false);
    const controllersRef = useRef(new Map<string, AbortController>());
    const cancellingRef = useRef(new Set<string>());
    const cancellationAttempts = useRef(new Set<string>());
    const owner = useRef({ projectId, scope: getActiveUserScope() });
    owner.current = { projectId, scope: getActiveUserScope() };

    const cancelPausedTask = useCallback(async (sourceNodeId: string, batchId: string, nodeId: string, task: GenerationTask) => {
        const batch = findBatch(nodesRef.current, sourceNodeId, batchId);
        const source = nodesRef.current.find(node => node.id === sourceNodeId);
        const latest = source?.metadata?.generationBatches?.findLast(batch => batch.items.some(item => item.nodeId === nodeId));
        if (!batch?.paused || latest?.id !== batchId || batch.projectId !== projectId || !["queued", "running"].includes(task.status) || cancellingRef.current.has(task.id) || cancellationAttempts.current.has(task.id)) return;
        const scope = getActiveUserScope();
        cancellingRef.current.add(task.id);
        cancellationAttempts.current.add(task.id);
        try {
            const cancelled = await cancelGenerationTask(task.id);
            if (owner.current.projectId !== projectId || getActiveUserScope() !== scope) return;
            setNodes(current => current.map(node => node.id === nodeId && node.metadata?.taskId === task.id ? {
                ...node, metadata: { ...node.metadata, ...generationTaskMetadata(cancelled), status: cancelled.status === "cancelled" ? "idle" : node.metadata.status },
            } : node));
        } catch (error) {
            if (owner.current.projectId === projectId && getActiveUserScope() === scope) message.error(error instanceof Error ? error.message : "部分视频暂停失败，请在详情重试取消");
        } finally { cancellingRef.current.delete(task.id); }
    }, [message, nodesRef, projectId, setNodes]);

    const pauseGenerationBatches = useCallback(async (sourceNodeId: string) => {
        const next = pauseNodeGenerationBatches(nodesRef.current, sourceNodeId);
        nodesRef.current = next;
        setNodes(next);
        const persistence = persistBatches().catch(error => {
            message.error(error instanceof Error ? `暂停状态同步失败：${error.message}` : "暂停状态同步失败，请保存后再关闭画布");
        });
        const source = next.find(node => node.id === sourceNodeId);
        const tasks = new Map<string, { batchId: string; nodeId: string }>();
        for (const batch of source?.metadata?.generationBatches || []) for (const item of batch.items) {
            const node = next.find(node => node.id === item.nodeId);
            if (node?.metadata?.taskId && ["queued", "running"].includes(node.metadata.taskStatus || "")) tasks.set(node.metadata.taskId, { batchId: batch.id, nodeId: node.id });
        }
        // Cancel sequentially to avoid another request burst during a pause.
        for (const [id, entry] of tasks) {
            cancellationAttempts.current.delete(id);
            await cancelPausedTask(sourceNodeId, entry.batchId, entry.nodeId, { id, status: "running" } as GenerationTask);
        }
        await persistence;
    }, [cancelPausedTask, message, nodesRef, persistBatches, setNodes]);

    const updateBatch = useCallback(
        (sourceNodeId: string, batchId: string, updater: (batch: CanvasGenerationBatch) => CanvasGenerationBatch) => {
            setNodes((current) => {
                let changed = false;
                const next = current.map((node) => {
                    if (node.id !== sourceNodeId || !node.metadata?.generationBatches?.length) return node;
                    const batches = node.metadata.generationBatches.map((batch) => {
                        if (batch.id !== batchId) return batch;
                        const updated = updater(batch);
                        if (updated !== batch) changed = true;
                        return updated;
                    });
                    return changed ? { ...node, metadata: { ...node.metadata, generationBatches: batches } } : node;
                });
                return changed ? next : current;
            });
        },
        [setNodes],
    );

    const enqueueGenerationBatch = useCallback(
        (sourceNodeId: string, mode: CanvasGenerationBatchMode, targets: BatchTarget[]) => {
            const sourceNode = nodesRef.current.find((node) => node.id === sourceNodeId);
            if (!sourceNode || !targets.length) return;
            const activeNodeIds = new Set((sourceNode.metadata?.generationBatches || []).filter(batch => !batch.paused).flatMap((batch) => batch.items.filter((item) => ["waiting", "submitting", "queued", "running"].includes(item.status)).map((item) => item.nodeId)));
            const availableTargets = targets.filter((target) => !activeNodeIds.has(target.nodeId));
            if (!availableTargets.length) {
                message.info("所选镜头已在生成批次中");
                return;
            }
            const now = new Date().toISOString();
            const batch: CanvasGenerationBatch = {
                id: nanoid(),
                projectId,
                sourceNodeId,
                mode,
                status: "queued",
                items: availableTargets.map((target) => ({ id: nanoid(), ...target, status: "waiting", retryCount: 0 })),
                createdAt: now,
                updatedAt: now,
            };
            setNodes((current) =>
                current.map((node) =>
                    node.id === sourceNodeId
                        ? {
                              ...node,
                              metadata: {
                                  ...node.metadata,
                                  generationBatches: [...(node.metadata?.generationBatches || []).filter((entry, index, history) => !["completed", "cancelled", "partial_failed"].includes(entry.status) || index >= history.length - MAX_BATCH_HISTORY), batch],
                              },
                          }
                        : node,
                ),
            );
            return batch.id;
        },
        [message, nodesRef, projectId, setNodes],
    );

    const reconcileBatches = useCallback(() => {
        setNodes(current => reconcileGenerationBatches(current, projectId, new Set(controllersRef.current.keys())));
    }, [projectId, setNodes]);

    // Account-wide category counts include other canvases; backend admission remains atomic.
    const scheduleWaitingItems = useCallback(async () => {
        if (!projectLoaded || schedulingRef.current) return;
        const scope = getActiveUserScope();
        schedulingRef.current = true;
        try {
            const currentNodes = nodesRef.current;
            // 没有当前画布的等待项时无需查询任务中心，避免空画布持续轮询。
            const hasWaitingItems = currentNodes.some((sourceNode) =>
                (sourceNode.metadata?.generationBatches || []).some((batch) => batch.projectId === projectId && !batch.paused && batch.status !== "completed" && batch.status !== "cancelled" && batch.items.some((item) => item.status === "waiting")),
            );
            if (!hasWaitingItems) return;

            await readRuntimeLimits();
            policyErrorRef.current = "";
            const submittedTaskIdsAtQuery = new Set(nodesRef.current.flatMap(node => node.metadata?.taskId ? [node.metadata.taskId] : []));
            const tasks = await listGenerationTasks(100, { activeOnly: true }).catch(() => null);
            if (!tasks) return;
            if (owner.current.projectId !== projectId || getActiveUserScope() !== scope) return;
            const pendingReservations = generationBatchReservations(nodesRef.current, projectId, tasks, new Set(controllersRef.current.keys()), submittedTaskIdsAtQuery);
            const candidates = generationBatchCandidates(nodesRef.current, projectId, await readRuntimeLimits(), tasks, pendingReservations);

            for (const { batch, item, node } of candidates) {
                if (owner.current.projectId !== projectId || getActiveUserScope() !== scope) return;
                const key = batchItemKey(batch.id, item.id);
                if (controllersRef.current.has(key) || findBatch(nodesRef.current, batch.sourceNodeId, batch.id)?.paused) continue;
                const generationMode: CanvasNodeGenerationMode = generationBatchKind(batch.mode);
                const generationConfig = buildGenerationConfig(effectiveConfig, node, generationMode);
                if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                    updateBatch(batch.sourceNodeId, batch.id, (current) => withUpdatedItem(current, item.id, { status: "failed", errorDetails: "生成模型未配置，请完成配置后重试" }));
                    continue;
                }
                const prompt = (node.metadata?.composerContent || node.metadata?.prompt || "").trim();
                if (!prompt) {
                    updateBatch(batch.sourceNodeId, batch.id, (current) => withUpdatedItem(current, item.id, { status: "failed", errorDetails: "生成提示词为空" }));
                    continue;
                }
                const controller = new AbortController();
                controllersRef.current.set(key, controller);
                updateBatch(batch.sourceNodeId, batch.id, (current) => withUpdatedItem(current, item.id, { status: "submitting", errorDetails: undefined }));
                void handleGenerateNode(node.id, generationMode, prompt, {
                    controller,
                    waitForTaskCapacity: true,
                    skipDuplicateConfirmation: true,
                    onTaskUpdate: (task) => { void cancelPausedTask(batch.sourceNodeId, batch.id, node.id, task); },
                    retryContext:
                        node.metadata?.retryOf && node.metadata.attemptGroupId && node.metadata.taskClientOperationId
                            ? { retryOf: node.metadata.retryOf, attemptGroupId: node.metadata.attemptGroupId, clientOperationId: node.metadata.taskClientOperationId }
                            : undefined,
                    selectedSkillIds: node.metadata?.skillIds,
                }).finally(() => {
                    controllersRef.current.delete(key);
                    reconcileBatches();
                });
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : "读取系统并发策略失败";
            if (policyErrorRef.current !== detail) message.error(detail);
            policyErrorRef.current = detail;
        } finally {
            schedulingRef.current = false;
        }
    }, [cancelPausedTask, effectiveConfig, handleGenerateNode, isAiConfigReady, message, nodesRef, projectId, projectLoaded, reconcileBatches, updateBatch]);

    const retryFailedBatchItems = useCallback(
        (sourceNodeId: string, batchId: string, itemId?: string) => {
            const batch = findBatch(nodesRef.current, sourceNodeId, batchId);
            if (!batch) return;
            const failedItems = generationBatchRetryItems(nodesRef.current, sourceNodeId, batchId, itemId);
            if (!failedItems.length) return message.info("没有需要重试的失败项");
            const nodeById = new Map(nodesRef.current.map((node) => [node.id, node]));
            const blockedItems = failedItems.filter((item) => {
                const node = nodeById.get(item.nodeId);
                return unchangedModeratedPrompt(node?.metadata, node?.metadata?.composerContent || node?.metadata?.prompt || "");
            });
            const retryableItems = failedItems.filter((item) => !blockedItems.includes(item));
            if (blockedItems.length) message.warning(`${blockedItems.length} 个镜头未通过内容审核，请先修改提示词`);
            if (!retryableItems.length) return;
            const retry = async () => {
                const scope = getActiveUserScope();
                const retryContexts = new Map<string, Awaited<ReturnType<typeof createGenerationRetryContext>>>();
                await Promise.all(
                    retryableItems.map(async (item) => {
                        const retryNode = nodeById.get(item.nodeId);
                        if (!retryNode?.metadata?.taskId) return;
                        retryContexts.set(item.nodeId, await createGenerationRetryContext(retryNode.metadata.taskId, retryNode.metadata.attemptGroupId));
                    }),
                );
                if (owner.current.projectId !== projectId || getActiveUserScope() !== scope) return;
                const latestRetryIds = new Set(generationBatchRetryItems(nodesRef.current, sourceNodeId, batchId, itemId).map(item => item.id));
                if (retryableItems.some(item => !latestRetryIds.has(item.id) || nodesRef.current.find(node => node.id === item.nodeId)?.metadata?.taskId !== nodeById.get(item.nodeId)?.metadata?.taskId)) throw new Error("任务状态已变化，请查看详情后重新重试");
                const retryItemIds = new Set(retryableItems.map((item) => item.id));
                const retryNodeIds = new Set(retryableItems.map((item) => item.nodeId));
                setNodes((current) =>
                    current.map((node) => {
                        if (node.id === sourceNodeId) {
                            const batches = (node.metadata?.generationBatches || []).map((currentBatch) => {
                                if (currentBatch.id !== batchId) return currentBatch;
                                const items = currentBatch.items.map((item) =>
                                    retryItemIds.has(item.id) ? { ...item, status: "waiting" as const, taskId: undefined, errorDetails: undefined, costUncertain: false, retryCount: item.retryCount + 1 } : item,
                                );
                                const nextBatch = { ...currentBatch, paused: false, items, updatedAt: new Date().toISOString() };
                                return { ...nextBatch, status: generationBatchStatus(nextBatch) };
                            });
                            return { ...node, metadata: { ...node.metadata, generationBatches: batches } };
                        }
                        if (!retryNodeIds.has(node.id)) return node;
                        const retryContext = retryContexts.get(node.id);
                        return {
                            ...node,
                            metadata: {
                                ...resetGenerationTaskMetadata(node.metadata),
                                ...(retryContext
                                    ? {
                                          retryOf: retryContext.retryOf,
                                          attemptGroupId: retryContext.attemptGroupId,
                                          taskClientOperationId: retryContext.clientOperationId,
                                      }
                                    : {}),
                            },
                        };
                    }),
                );
                message.success(`已将 ${retryableItems.length} 个失败项重新加入等待队列`);
            };
            if (retryableItems.some((item) => item.costUncertain)) {
                modal.confirm({
                    title: "重试费用状态不确定的任务？",
                    content: "部分上游请求返回 524，原任务可能已经产生费用。重试会再次提交外部模型任务。",
                    okText: "仍然重试",
                    cancelText: "暂不重试",
                    onOk: retry,
                });
                return;
            }
            void retry().catch(error => message.error(error instanceof Error ? error.message : "重试提交失败"));
        },
        [message, modal, nodesRef, projectId, setNodes],
    );

    const stopRemainingBatchItems = useCallback(
        (sourceNodeId: string, batchId: string) => {
            const batch = findBatch(nodesRef.current, sourceNodeId, batchId);
            if (!batch) return;
            const nodeById = new Map(nodesRef.current.map((node) => [node.id, node]));
            // 只允许停止还在本地等待队列中的项目。进入 submitting 后请求可能已经被服务端接收，
            // 即使前端尚未拿到 taskId 也不能再把它标成取消，避免隐藏已计费任务。
            const stoppableItems = batch.items.filter((item) => item.status === "waiting" && !nodeById.get(item.nodeId)?.metadata?.taskId);
            if (!stoppableItems.length) return message.info("没有尚未提交的任务");
            modal.confirm({
                title: "停止剩余任务？",
                content: `将停止 ${stoppableItems.length} 个尚未提交的任务；已经排队或运行的任务会继续。`,
                okText: "停止剩余任务",
                cancelText: "继续生成",
                okButtonProps: { danger: true },
                onOk: () => {
                    const latestNodeById = new Map(nodesRef.current.map((node) => [node.id, node]));
                    const latestBatch = findBatch(nodesRef.current, sourceNodeId, batchId);
                    const latestStoppableItems = latestBatch ? latestBatch.items.filter((item) => item.status === "waiting" && stoppableItems.some((candidate) => candidate.id === item.id) && !latestNodeById.get(item.nodeId)?.metadata?.taskId) : [];
                    const stoppableIds = new Set(latestStoppableItems.map((item) => item.id));
                    updateBatch(sourceNodeId, batchId, (current) => {
                        const items = current.items.map((item) => (stoppableIds.has(item.id) ? { ...item, status: "cancelled" as const, errorDetails: undefined } : item));
                        const nextBatch = { ...current, items, updatedAt: new Date().toISOString() };
                        return { ...nextBatch, status: generationBatchStatus(nextBatch) };
                    });
                },
            });
        },
        [message, modal, nodesRef, updateBatch],
    );

    useEffect(() => {
        if (!projectLoaded) return;
        reconcileBatches();
        // A paused submission may have acquired its task receipt before reload.
        for (const source of nodes) for (const batch of source.metadata?.generationBatches || []) {
            if (!batch.paused || batch.projectId !== projectId) continue;
            for (const item of batch.items) {
                const target = nodes.find(node => node.id === item.nodeId);
                if (target?.metadata?.taskId && ["queued", "running"].includes(target.metadata.taskStatus || "")) {
                    void cancelPausedTask(source.id, batch.id, target.id, { id: target.metadata.taskId, status: "running" } as GenerationTask);
                }
            }
        }
    }, [nodes, projectId, projectLoaded, reconcileBatches, cancelPausedTask]);

    useEffect(() => {
        if (!projectLoaded) return;
        void scheduleWaitingItems();
        const timer = window.setInterval(() => {
            reconcileBatches();
            void scheduleWaitingItems();
        }, SCHEDULER_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [projectLoaded, reconcileBatches, scheduleWaitingItems]);

    return {
        enqueueGenerationBatch,
        retryFailedBatchItems,
        stopRemainingBatchItems,
        pauseGenerationBatches,
    };
}

function batchItemKey(batchId: string, itemId: string) {
    return `${batchId}:${itemId}`;
}

function withUpdatedItem(batch: CanvasGenerationBatch, itemId: string, patch: Partial<CanvasGenerationBatchItem>) {
    const items = batch.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item));
    const nextBatch = { ...batch, items, updatedAt: new Date().toISOString() };
    return { ...nextBatch, status: generationBatchStatus(nextBatch) };
}

function findBatch(nodes: CanvasNodeData[], sourceNodeId: string, batchId: string) {
    return nodes.find((node) => node.id === sourceNodeId)?.metadata?.generationBatches?.find((batch) => batch.id === batchId);
}
