import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationBatchMode, type CanvasNodeData } from "@/types/canvas";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { createGenerationRetryContext, resetGenerationTaskMetadata } from "@/lib/canvas/canvas-project-generation";
import { failedStoryboardBoundaryImagesForRow, materializeStoryboardFrames, shotKeyframes, storyboardBoundaryFrames, storyboardFrameHash, storyboardKeyframePrompt, type StoryboardFrameGenerationOptions } from "@/lib/canvas/episode-storyboard-frames";
import { reconcileStoryboardFramesGroups } from "@/lib/canvas/storyboard-frame-groups";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { getActiveUserScope } from "@/lib/user-scope";
import { useEffectiveConfig, useConfigStore } from "@/stores/use-config-store";
import { mergedImageCapabilityConfig } from "@/lib/model-selection";
import { normalizeImageValue } from "@/lib/model-capabilities";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { ShortDramaStep } from "@/lib/short-drama-steps";
import { queryGenerationTask } from "@/services/api/task-center";
import { storyboardRowIsReady } from "@/lib/canvas/workflow-episode-storyboard";
import { selectStoryboardFrameModel, storyboardFrameGenerationConfig } from "@/lib/canvas/storyboard-frame-model";

type Options = {
    projectId: string;
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    retry: (node: CanvasNodeData) => Promise<void>;
    enqueue: (id: string, mode: CanvasGenerationBatchMode, targets: { rowId: string; nodeId: string }[]) => string | undefined;
    save: () => Promise<boolean>;
};
export function useEpisodeStoryboardFrames({ projectId, nodesRef, connectionsRef, setNodes, setConnections, retry: retryGeneration, enqueue, save }: Options) {
    const config = useEffectiveConfig(),
        { message, modal } = App.useApp();
    const locks = useRef(new Set<string>());
    const selectModel = useCallback(
        (scriptId: string, kind: "text" | "image", model: string) => {
            useConfigStore.getState().rememberModel(kind, model);
            setNodes((current) => selectStoryboardFrameModel(current, scriptId, kind, model));
        },
        [setNodes],
    );
    const lifetime = useRef(new AbortController());
    useEffect(() => {
        const controller = new AbortController();
        lifetime.current = controller;
        return () => controller.abort();
    }, [projectId]);
    const confirm = useCallback(
        (count: number, label: string, retry = false) =>
            new Promise<boolean>((resolve) => {
                const signal = lifetime.current.signal;
                const dialog = modal.confirm({
                    title: `确认${label}`,
                    content: `本次提交 ${count} 个${label}任务，沿用系统并发与正常计费。${retry ? "仅重试失败图片，保留已生成和在途图片。上游超时不代表未生成或未扣费，请核对原任务后确认；重试可能再次产生费用。" : ""}`,
                    okText: "确认生成",
                    cancelText: "取消",
                    onOk: () => resolve(true),
                    onCancel: () => resolve(false),
                    afterClose: () => signal.removeEventListener("abort", cancel),
                });
                const cancel = () => {
                    dialog.destroy();
                    resolve(false);
                };
                signal.addEventListener("abort", cancel, { once: true });
                if (signal.aborted) cancel();
            }),
        [modal],
    );
    const extract = useCallback(
        async (scriptId: string, rowId: string) => {
            const key = `${scriptId}:frames`,
                signal = lifetime.current.signal,
                scope = getActiveUserScope();
            if (locks.current.has(key)) return;
            locks.current.add(key);
            try {
                const script = nodesRef.current.find((node) => node.id === scriptId),
                    row = script?.metadata?.storyboard?.rows.find((row) => row.id === rowId);
                if (!script || !row || !storyboardRowIsReady(row)) throw new Error("当前分镜详情尚未完成");
                const existing = nodesRef.current.find((node) => node.id === row.framePlanNodeId);
                if (isCanvasNodeGenerating(existing)) return;
                if ((script.metadata?.generationBatches || []).some((batch) => !batch.paused && batch.items.some((item) => item.nodeId === existing?.id && ["waiting", "submitting", "queued", "running"].includes(item.status)))) {
                    message.info("关键帧提取已在队列中");
                    return;
                }
                const textConfig = storyboardFrameGenerationConfig(config, script, "text");
                if (!useConfigStore.getState().isAiConfigReady(textConfig, textConfig.model)) throw new Error("请选择可用文本模型提取关键帧");
                if (!(await confirm(1, "关键帧提取"))) return;
                const current = nodesRef.current.find((node) => node.id === scriptId)?.metadata?.storyboard?.rows.find((row) => row.id === rowId);
                if (signal.aborted || scope !== getActiveUserScope()) return;
                if (!current || storyboardFrameHash(current) !== storyboardFrameHash(row)) throw new Error("分镜已变化，请重新提取");
                const task = existing?.metadata?.taskId ? await queryGenerationTask(existing.metadata.taskId) : undefined;
                if (task && ["queued", "running"].includes(task.status)) throw new Error("原提取任务仍在执行，请在详情暂停或等待完成");
                const retry = task && ["failed", "cancelled"].includes(task.status) ? await createGenerationRetryContext(task.id, existing?.metadata?.attemptGroupId) : undefined;
                if (signal.aborted || scope !== getActiveUserScope()) return;
                const latest = nodesRef.current.find((node) => node.id === scriptId);
                const latestRow = latest?.metadata?.storyboard?.rows.find((item) => item.id === rowId);
                if (!latest || !latestRow || storyboardFrameHash(latestRow) !== storyboardFrameHash(row) || latestRow.framePlanNodeId !== row.framePlanNodeId) throw new Error("分镜或提取任务已变化，请重新提取");
                const reconciled = reconcileStoryboardFramesGroups(nodesRef.current, connectionsRef.current);
                const base = existing || createCanvasNode(CanvasNodeType.Text, script.position);
                const prompt = storyboardKeyframePrompt(row);
                const plan = {
                    ...base,
                    parentId: undefined,
                    width: 280,
                    height: 280,
                    title: `${row.shotCode || row.shotNumber} · 关键帧提取`,
                    metadata: {
                        ...resetGenerationTaskMetadata(base.metadata),
                        content: undefined,
                        richText: undefined,
                        prompt,
                        composerContent: prompt,
                        model: textConfig.model,
                        textCount: 1,
                        status: "idle" as const,
                        ...(retry ? { retryOf: retry.retryOf, attemptGroupId: retry.attemptGroupId, taskClientOperationId: retry.clientOperationId } : {}),
                        storyboardFramePlan: { scriptId, rowId, sourcePromptHash: storyboardFrameHash(row) },
                        shortDrama: {
                            stage: "storyboard" as const,
                            step: ShortDramaStep.Keyframes,
                            pipelineId: script.metadata!.shortDrama!.pipelineId,
                            role: "document" as const,
                            sourceNodeIds: [scriptId],
                            sourceSignatures: {},
                            episodeNumber: script.metadata?.shortDrama?.episodeNumber,
                        },
                    },
                };
                let next = reconciled.nodes.map((node) =>
                    node.id === scriptId
                        ? { ...node, metadata: { ...node.metadata, storyboard: { ...node.metadata!.storyboard!, rows: node.metadata!.storyboard!.rows.map((row) => (row.id === rowId ? { ...row, framePlanNodeId: plan.id } : row)) } } }
                        : node.id === plan.id
                          ? plan
                          : node,
                );
                if (!existing) next = [...next, plan];
                setNodes(next);
                setConnections(reconciled.connections);
                if (!(await save())) throw new Error("关键帧提取节点已保留，保存失败后可再次提取");
                if (!signal.aborted && scope === getActiveUserScope()) {
                    enqueue(scriptId, "storyboard_keyframes", [{ rowId, nodeId: plan.id }]);
                    await save();
                }
            } catch (error) {
                if (!signal.aborted && scope === getActiveUserScope()) message.error(error instanceof Error ? error.message : "关键帧提取失败");
            } finally {
                locks.current.delete(key);
            }
        },
        [config, confirm, connectionsRef, enqueue, message, nodesRef, save, setConnections, setNodes],
    );
    const generateFrames = useCallback(
        async (scriptId: string, rowId?: string, kind: "boundary" | "keyframes" = "boundary", options: StoryboardFrameGenerationOptions = {}) => {
            const key = `${scriptId}:frames`,
                signal = lifetime.current.signal,
                scope = getActiveUserScope();
            if (locks.current.has(key)) return;
            locks.current.add(key);
            try {
                const prepare = () => {
                    const script = nodesRef.current.find((node) => node.id === scriptId);
                    if (!script) throw new Error("分镜列表已删除");
                    const imageConfig = storyboardFrameGenerationConfig(config, script, "image");
                    if (!useConfigStore.getState().isAiConfigReady(imageConfig, imageConfig.model)) throw new Error("请先选择可用的生图模型");
                    const settings = normalizeImageValue(mergedImageCapabilityConfig(imageConfig, imageConfig.model), {
                        size: useCanvasStore.getState().openProject(projectId)?.globalSettings?.aspectRatio || config.size,
                        quality: config.quality,
                        transparentBackground: "false",
                        count: "1",
                    });
                    const rows = script.metadata!.storyboard!.rows.filter((row) => (!rowId || row.id === rowId) && storyboardRowIsReady(row));
                    if (rowId && !rows.length) throw new Error("当前分镜已删除");
                    if (kind === "keyframes" && !rowId) throw new Error("请选择需要生成关键帧的分镜");
                    const requests = rows.map((row) => {
                        const keyframes = kind === "keyframes" ? shotKeyframes(row, nodesRef.current) : undefined;
                        if (keyframes?.error) throw new Error(keyframes.error);
                        if (kind === "keyframes" && !keyframes?.frames.length) throw new Error("请先提取当前镜头关键帧");
                        return { row, frames: keyframes?.frames || storyboardBoundaryFrames(row) };
                    });
                    const selectedNodes = selectStoryboardFrameModel(nodesRef.current, scriptId, "image", imageConfig.model);
                    return materializeStoryboardFrames(script, requests, selectedNodes, connectionsRef.current, imageConfig.model, settings, options);
                };
                const preview = prepare();
                const requestedRow = rowId ? nodesRef.current.find((node) => node.id === scriptId)?.metadata?.storyboard?.rows.find((row) => row.id === rowId) : undefined;
                const requestedRowHash = requestedRow ? storyboardFrameHash(requestedRow) : undefined;
                if (rowId && kind === "boundary" && !options.failedOnly) {
                    const script = nodesRef.current.find((node) => node.id === scriptId);
                    const failed = script ? failedStoryboardBoundaryImagesForRow(script, rowId, nodesRef.current) : [];
                    if (failed.length) {
                        if (!(await confirm(failed.length, "失败首尾帧重试", true))) return;
                        if (signal.aborted || scope !== getActiveUserScope()) return;
                        const latestScript = nodesRef.current.find((node) => node.id === scriptId);
                        const latestRow = latestScript?.metadata?.storyboard?.rows.find((row) => row.id === rowId);
                        if (!latestScript || !latestRow || storyboardFrameHash(latestRow) !== requestedRowHash) throw new Error("分镜已变化，请重新确认重试");
                        const currentFailures = failedStoryboardBoundaryImagesForRow(latestScript, rowId, nodesRef.current);
                        if (currentFailures.length !== failed.length || currentFailures.some((image) => !failed.some((previous) => previous.id === image.id && previous.metadata?.taskId === image.metadata?.taskId)))
                            throw new Error("失败画面状态已变化，请重新确认重试");
                        message.info(`正在重新提交 ${currentFailures.length} 张失败首尾帧；任务状态与请求结果可在画面详情和请求明细中查看`);
                        for (const image of currentFailures) void retryGeneration(image).catch((error) => message.error(error instanceof Error ? error.message : `重试 ${image.title} 失败`));
                        return;
                    }
                }
                const currentSnapshot = () => JSON.stringify(nodesRef.current.find((node) => node.id === scriptId)?.metadata?.storyboard?.rows.map((row) => [row.id, storyboardFrameHash(row), row.framePlanNodeId, row.startFrameMode]));
                const snapshot = currentSnapshot();
                if (!preview.targets.length) {
                    if (options.failedOnly) {
                        message.info("没有可重试的当前版本失败首尾帧");
                        return;
                    }
                    if (preview.blockedRows.length) {
                        message.info("前序分镜详情尚未完成，请等待后再生成共享首尾帧");
                        return;
                    }
                    setNodes(preview.nodes);
                    setConnections(preview.connections);
                    if (!(await save())) throw new Error("首尾帧关联保存失败，请重试");
                    message.info("已关联现有画面；生成失败的画面可在详情重试");
                    return;
                }
                if (!(await confirm(preview.targets.length, options.failedOnly ? "失败首尾帧重试" : kind === "keyframes" ? "关键帧生图" : "首尾帧生图", options.failedOnly))) return;
                if (signal.aborted || scope !== getActiveUserScope()) return;
                if (snapshot !== currentSnapshot()) throw new Error("分镜或关键帧方案已变化，请重新确认生成");
                let prepared = prepare();
                if (prepared.targets.length > preview.targets.length) throw new Error("待生成画面已变化，请重新确认生成数量");
                const retries = new Map<string, Awaited<ReturnType<typeof createGenerationRetryContext>>>();
                for (const target of prepared.targets) {
                    const image = nodesRef.current.find((node) => node.id === target.nodeId);
                    if (!image?.metadata?.taskId) continue;
                    const task = await queryGenerationTask(image.metadata.taskId);
                    if (task.status !== "cancelled" && task.status !== "failed") throw new Error("原画面任务状态已变化，请查看详情后重新生成");
                    retries.set(image.id, await createGenerationRetryContext(task.id, image.metadata.attemptGroupId));
                }
                if (signal.aborted || scope !== getActiveUserScope()) return;
                if (snapshot !== currentSnapshot()) throw new Error("分镜已变化，请重新确认生成");
                prepared = prepare();
                if (
                    prepared.targets.length > preview.targets.length ||
                    prepared.targets.some((target) => {
                        const taskId = nodesRef.current.find((node) => node.id === target.nodeId)?.metadata?.taskId;
                        return taskId && retries.get(target.nodeId)?.retryOf !== taskId;
                    })
                )
                    throw new Error("画面任务已变化，请重新确认生成");
                prepared.nodes = prepared.nodes.map((node) => {
                    const retry = retries.get(node.id);
                    return retry ? { ...node, metadata: { ...resetGenerationTaskMetadata(node.metadata), status: "idle", retryOf: retry.retryOf, attemptGroupId: retry.attemptGroupId, taskClientOperationId: retry.clientOperationId } } : node;
                });
                setNodes(prepared.nodes);
                setConnections(prepared.connections);
                if (!(await save())) throw new Error("画面节点已保留，保存失败后请再次生成");
                if (signal.aborted || scope !== getActiveUserScope()) return;
                enqueue(scriptId, "storyboard_image", prepared.targets);
                await save();
            } catch (error) {
                if (!signal.aborted && scope === getActiveUserScope()) message.error(error instanceof Error ? error.message : "画面生成失败");
            } finally {
                locks.current.delete(key);
            }
        },
        [config, confirm, connectionsRef, enqueue, message, nodesRef, projectId, save, setConnections, setNodes],
    );
    const retryFrame = useCallback(
        async (node: CanvasNodeData) => {
            const binding = node.metadata?.storyboardFrame;
            if (!binding) return;
            const signal = lifetime.current.signal,
                scope = getActiveUserScope();
            try {
                const row = nodesRef.current.find((node) => node.id === binding.scriptId)?.metadata?.storyboard?.rows.find((row) => row.id === binding.rowId);
                if (!row || binding.sourcePromptHash !== storyboardFrameHash(row)) throw new Error("分镜已修改，请生成当前版本的画面");
                if (isCanvasNodeGenerating(node) || node.metadata?.content || node.metadata?.storageKey) return;
                if (!(await confirm(1, "首尾帧重试", true))) return;
                if (signal.aborted || scope !== getActiveUserScope()) return;
                await retryGeneration(node);
            } catch (error) {
                if (!signal.aborted && scope === getActiveUserScope()) message.error(error instanceof Error ? error.message : "画面重试失败");
            }
        },
        [confirm, message, nodesRef, retryGeneration],
    );
    return { extractStoryboardKeyframes: extract, generateStoryboardFrames: generateFrames, retryStoryboardFrame: retryFrame, selectStoryboardFrameModel: selectModel };
}
