import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { App } from "antd";
import { nanoid } from "nanoid";

import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import {
    backendProviderConfig,
    buildGenerationConfig,
    generationTaskMetadata,
    resetGenerationTaskMetadata,
    createGenerationRetryContext,
    logicalModelIDForConfig,
} from "@/lib/canvas/canvas-project-generation";
import {
    cinematicStoryboardColumns,
    createCanvasNode,
    createStoryboardRow,
    expandStoryboardTextMentions,
    storyboardRowsFromTask,
    storyboardPromptTemplateMetadata,
    withStoryboardOutputContract,
} from "@/lib/canvas/canvas-project-domain";
import { buildNodeMentionReferences } from "@/lib/canvas/canvas-resource-references";
import { buildStoryboardAssetCatalog } from "@/lib/canvas/canvas-storyboard-assets";
import { resolveStoryboardGenerationContext } from "@/lib/canvas/canvas-storyboard-context";
import { reconcileStoryboardTargetConnections, storyboardComposerContent, storyboardRowReferenceNodeIds } from "@/lib/canvas/canvas-storyboard-materializer";
import { episodeShotBoundaryImages, storyboardRowIsReady } from "@/lib/canvas/workflow-episode-storyboard";
import { generationErrorMessage } from "@/lib/generation-error";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { navigateToSettings } from "@/lib/settings-navigation";
import type { Skill } from "@/services/api/skills";
import { createGenerationTask, waitForGenerationTask } from "@/services/api/task-center";
import { quoteModel } from "@/services/api/logical-models";
import { skillRuntime } from "@/services/skill-runtime";
import { submitStoryboardTask } from "@/services/storyboard-submission";
import { getActiveUserScope } from "@/lib/user-scope";
import { modelDisplayName, modelOptionName, resolveModelChannel, resolveModelRequestConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { modelQuoteRequest, requestCreditCost } from "@/lib/model-pricing";
import type { LogicalModelQuote } from "@/services/api/logical-models";
import type { ModelRequirements } from "@/lib/model-selection";
import {
    CanvasNodeType,
    type CanvasConnection,
    type CanvasGenerationBatchMode,
    type CanvasNodeData,
    type StoryboardRow,
} from "@/types/canvas";

type UseCanvasStoryboardOptions = {
    projectId: string;
    addedSkills: Skill[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    enqueueGenerationBatch: (sourceNodeId: string, mode: CanvasGenerationBatchMode, targets: Array<{ rowId: string; nodeId: string }>) => string | undefined;
};

const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

export function useCanvasStoryboard({
    projectId,
    addedSkills,
    nodesRef,
    connectionsRef,
    setNodes,
    setConnections,
    setSelectedNodeIds,
    enqueueGenerationBatch,
}: UseCanvasStoryboardOptions) {
    const { message, modal } = App.useApp();
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const storyboardRequests = useRef(new Set<string>());
    const storyboardLifetime = useRef(new AbortController());
    useEffect(() => {
        const controller = new AbortController();
        storyboardLifetime.current = controller;
        return () => controller.abort();
    }, [projectId]);

    const confirmGenerationSubmission = useCallback(async (count: number, model: string, taskLabel: string, capability: ModelRequirements["capability"] = "image", requirements?: ModelRequirements) => {
        if (!count) return false;
        const modelConfig = { ...effectiveConfig, model };
        const channel = resolveModelChannel(modelConfig, model);
        let quote: LogicalModelQuote | undefined;
        let fallbackCredits: number | null = null;
        if (channel.scope === "system") {
            const quoteRequest = modelQuoteRequest(modelConfig, model, capability, requirements);
            if (quoteRequest) {
                try {
                    quote = (await quoteModel(quoteRequest)).quote;
                } catch {
                    // The backend will validate the same price again on submit. Keep the confirmation usable when only the quote preview is unavailable.
                }
            }
            if (!quote) {
                fallbackCredits = requestCreditCost({
                    channelMode: "remote",
                    modelCosts: channel.modelCosts,
                    model: modelOptionName(model),
                    count,
                    seconds: requirements?.videoSeconds || modelConfig.videoSeconds,
                    capability,
                    config: modelConfig,
                    requirements,
                });
            }
        }
        const modelLabel = modelDisplayName(modelConfig, model);
        const quotedAmountMicrocredits = quote ? quote.amountMicrocredits * count : undefined;
        const pricingText = channel.scope !== "system"
            ? "这是外部渠道任务，费用由所选渠道自行结算，平台无法预估。"
            : quote
                ? `${quote.estimated ? "预计" : "本次"}平台费用 ${(quotedAmountMicrocredits || 0) / 1_000_000} 积分。`
                : fallbackCredits !== null
                    ? `平台费用 ${fallbackCredits} 积分。`
                    : "平台任务，当前规格价格将在提交时再次校验。";
        return new Promise<boolean>((resolve) => {
            modal.confirm({
                title: `确认提交 ${count} 个${taskLabel}任务`,
                content: `任务数：${count}；模型：${modelLabel}。${pricingText}`,
                okText: "确认生成",
                cancelText: "取消",
                centered: true,
                onOk: () => resolve(true),
                onCancel: () => resolve(false),
            });
        });
    }, [effectiveConfig, modal]);

    const updateScriptRows = useCallback((nodeId: string, updater: (rows: StoryboardRow[]) => StoryboardRow[]) => {
        setNodes((current) => current.map((node) => node.id === nodeId ? {
            ...node,
            metadata: {
                ...node.metadata,
                storyboard: {
                    rows: updater(node.metadata?.storyboard?.rows || []),
                    visibleColumns: node.metadata?.storyboard?.visibleColumns || ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"],
                    referenceNodeIds: node.metadata?.storyboard?.referenceNodeIds || [],
                },
            },
        } : node));
    }, [setNodes]);

    const replaceScriptRows = useCallback((nodeId: string, rows: StoryboardRow[]) => {
        const rowIds = new Set(rows.map((row) => `row:${row.id}`));
        const storyboardRowIds = new Set(rows.map((row) => row.id));
        const previousRows = new Map((nodesRef.current.find((node) => node.id === nodeId)?.metadata?.storyboard?.rows || []).map((row) => [row.id, row]));
        const nextRows = rows.map((row) => invalidateEditedPromptVariables(previousRows.get(row.id), row));
        setConnections((current) => current
            .filter((connection) => connection.fromNodeId !== nodeId && connection.toNodeId !== nodeId || !connection.storyboardRowId || storyboardRowIds.has(connection.storyboardRowId))
            .filter((connection) => connection.fromNodeId !== nodeId || !connection.fromHandleId?.startsWith("row:") || rowIds.has(connection.fromHandleId))
            .filter((connection) => connection.toNodeId !== nodeId || !connection.toHandleId?.startsWith("row:") || rowIds.has(connection.toHandleId)));
        updateScriptRows(nodeId, () => nextRows);
    }, [nodesRef, setConnections, updateScriptRows]);

    const addScriptRow = useCallback((nodeId: string) => {
        updateScriptRows(nodeId, (rows) => [...rows, createStoryboardRow(rows.length + 1)]);
    }, [updateScriptRows]);

    const updateScriptRow = useCallback((nodeId: string, rowId: string, patch: Partial<StoryboardRow>) => {
        updateScriptRows(nodeId, (rows) => rows.map((row) => row.id === rowId ? invalidateEditedPromptVariables(row, { ...row, ...patch }) : row));
    }, [updateScriptRows]);

    const removeScriptRow = useCallback((nodeId: string, rowId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        const rows = (node?.metadata?.storyboard?.rows || []).filter((row) => row.id !== rowId).map((row, index) => ({ ...row, shotNumber: index + 1 }));
        replaceScriptRows(nodeId, rows);
    }, [nodesRef, replaceScriptRows]);

    const generateScriptRows = useCallback(async (nodeId: string, prompt: string, callerSignal?: AbortSignal) => {
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        if (!scriptNode || !prompt.trim()) return;
        if (storyboardRequests.current.has(nodeId) || scriptNode.metadata?.status === NODE_STATUS_LOADING) { message.warning("当前分镜正在处理，请等待原任务完成"); return false; }
        const lifetimeSignal = storyboardLifetime.current.signal;
        const signal = callerSignal ? AbortSignal.any([lifetimeSignal, callerSignal]) : lifetimeSignal;
        const scope = getActiveUserScope();
        const originalRows = JSON.stringify(scriptNode.metadata?.storyboard?.rows || []);
        const assertCurrent = () => {
            signal.throwIfAborted();
            const current = nodesRef.current.find((node) => node.id === nodeId);
            if (getActiveUserScope() !== scope || !current || JSON.stringify(current.metadata?.storyboard?.rows || []) !== originalRows) throw new Error("画布、账号或分镜内容已变化，未覆盖现有镜头，请重新读取后处理");
        };
        let storyboardContext: ReturnType<typeof resolveStoryboardGenerationContext>;
        try {
            storyboardContext = resolveStoryboardGenerationContext(nodesRef.current);
        } catch (error) {
            message.warning(error instanceof Error ? error.message : "分镜上下文不完整");
            return;
        }
        const shotDuration = scriptNode.metadata?.storyboardShotDuration || "auto";
        const shotDurationSeconds = shotDuration === "auto" ? 0 : Number(shotDuration);
        const shotCount = scriptNode.metadata?.storyboardShotCount || "auto";
        const requestedShotCount = shotCount === "auto" ? 0 : Number(shotCount);
        const expandedPrompt = expandStoryboardTextMentions(prompt, buildNodeMentionReferences(scriptNode, nodesRef.current, connectionsRef.current));
        const generationConfig = buildGenerationConfig(effectiveConfig, scriptNode, "text");
        if (!isAiConfigReady(generationConfig, generationConfig.model)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        storyboardRequests.current.add(nodeId);
        try {
            const skillExecution = await skillRuntime.prepare({
                profile: "shortDrama",
                prompt: expandedPrompt,
                skills: addedSkills,
            });
            assertCurrent();
            setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, composerContent: prompt, status: NODE_STATUS_LOADING, taskStage: "正在创建任务", taskProgress: 0, errorDetails: undefined, ...skillExecution.metadata } } : node));
            assertCurrent();
            // 输入框内容只是剧情，拆镜要求与镜头数、每镜时长都必须随契约一起发出去。
            const storyboardPrompt = withStoryboardOutputContract(skillExecution.prompt, { shotCount: requestedShotCount, shotDurationSeconds });
            const request = {
                projectId,
                type: "canvas_text",
                operation: "storyboard",
                prompt: storyboardPrompt,
                model: generationConfig.model,
                ...(logicalModelIDForConfig(generationConfig) ? { logicalModelId: logicalModelIDForConfig(generationConfig) } : {}),
                input: {
                    mode: "text",
                    prompt: storyboardPrompt,
                    canvasAssets: buildStoryboardAssetCatalog(nodesRef.current),
                    requirements: "输出可直接编辑并用于批量生成图片和视频的分镜表。",
                    projectStyle: storyboardContext.projectStyle,
                    characters: storyboardContext.characters,
                    shotDurationSeconds,
                    shotCount: requestedShotCount,
                    config: backendProviderConfig(generationConfig, "text"),
                    metadata: { nodeId, ...skillExecution.metadata },
                },
            };
            const managed = Boolean(logicalModelIDForConfig(generationConfig) || resolveModelRequestConfig(generationConfig, generationConfig.model).channelId);
            const task = managed ? await submitStoryboardTask(request, { signal, assertCurrent, confirm: (submission) => new Promise<boolean>((resolve) => {
                const quote = submission.quote;
                const dialog = modal.confirm({
                    title: "确认生成分镜",
                    content: `使用 ${modelDisplayName(effectiveConfig, quote.model)} 拆分镜头。${quote.estimated ? "预计" : ""}平台费用 ${quote.amountMicrocredits / 1_000_000} 积分；自定义渠道费用由渠道另计，按用量计费以实际结算为准。${(scriptNode.metadata?.storyboard?.rows || []).length ? "本次将替换现有分镜行，原图片视频保留，镜头关联需要重新核对。" : "确认后生成可编辑的分镜表。"}`,
                    okText: "确认生成", cancelText: "取消", centered: true,
                    onOk: () => resolve(true), onCancel: () => resolve(false),
                    afterClose: () => signal.removeEventListener("abort", cancel),
                });
                const cancel = () => { dialog.destroy(); resolve(false); };
                signal.addEventListener("abort", cancel, { once: true });
                if (signal.aborted) cancel();
            }) }) : await (async () => {
                const confirmed = await confirmGenerationSubmission(1, generationConfig.model, `专业拆镜${(scriptNode.metadata?.storyboard?.rows || []).length ? "（替换现有镜头，保留原媒体）" : ""}`, "text");
                if (!confirmed) return undefined;
                assertCurrent();
                return createGenerationTask(request);
            })();
            if (!task) {
                if (!signal.aborted && scope === getActiveUserScope()) setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: scriptNode.metadata?.status || NODE_STATUS_IDLE, taskStage: undefined } } : node));
                return false;
            }
            assertCurrent();
            setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...generationTaskMetadata(task), status: NODE_STATUS_LOADING } } : node));
            const completed = await waitForGenerationTask(task.id, {
                initialTask: task,
                signal,
                useTextEvents: true,
                onTaskUpdate: (next) => { if (!signal.aborted && scope === getActiveUserScope()) setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...generationTaskMetadata(next), status: NODE_STATUS_LOADING } } : node)); },
            });
            const result = storyboardRowsFromTask(completed);
            assertCurrent();
            replaceScriptRows(nodeId, result.rows);
            setNodes((current) => current.map((node) => node.id === nodeId ? {
                ...node,
                title: result.title || node.title,
                metadata: {
                    ...node.metadata,
                    status: NODE_STATUS_SUCCESS,
                    errorDetails: undefined,
                    ...generationTaskMetadata(completed),
                    storyboard: {
                        rows: result.rows,
                        visibleColumns: cinematicStoryboardColumns(node.metadata?.storyboard?.visibleColumns),
                        referenceNodeIds: node.metadata?.storyboard?.referenceNodeIds || [],
                    },
                },
            } : node));
            message.success(`已生成 ${result.rows.length} 个镜头`);
            return true;
        } catch (error) {
            if (signal.aborted || scope !== getActiveUserScope()) return false;
            const details = generationErrorMessage(error);
            setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: details } } : node));
            message.error(details);
            return false;
        } finally {
            if (signal.aborted && !lifetimeSignal.aborted && scope === getActiveUserScope()) setNodes((current) => current.map((node) => {
                if (node.id !== nodeId) return node;
                const active = node.metadata?.taskStatus === "queued" || node.metadata?.taskStatus === "running";
                return { ...node, metadata: { ...node.metadata, status: active ? NODE_STATUS_LOADING : NODE_STATUS_IDLE, taskStage: active ? "已提交后台任务，等待结果" : undefined } };
            }));
            storyboardRequests.current.delete(nodeId);
        }
    }, [addedSkills, confirmGenerationSubmission, connectionsRef, effectiveConfig, isAiConfigReady, message, modal, nodesRef, projectId, replaceScriptRows, setNodes]);

    const ensureScriptImageNodes = useCallback((nodeId: string, rowIds: string[]) => {
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const rows = (scriptNode?.metadata?.storyboard?.rows || []).filter((row) => rowIds.includes(row.id));
        if (!scriptNode || !rows.length) return [];
        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const startX = scriptNode.position.x + scriptNode.width + 120;
        const nextNodes = [...nodesRef.current];
        let nextConnections = [...connectionsRef.current];
        const targets: Array<{ row: StoryboardRow; node: CanvasNodeData; prompt: string }> = [];
        rows.forEach((row, index) => {
            const prompt = (row.imageGenerationPrompt || row.plotDescription).trim();
            const existing = row.imageNodeId ? nextNodes.find((node) => node.id === row.imageNodeId && node.type === CanvasNodeType.Image) : undefined;
            const existingMetadata = existing?.metadata?.content ? existing.metadata : resetGenerationTaskMetadata(existing?.metadata);
            const referenceIds = storyboardRowReferenceNodeIds(scriptNode, row, nextNodes, nextConnections, false, existing?.id);
            const composerContent = storyboardComposerContent(prompt, referenceIds, nextNodes);
            const imageNode = existing
                ? { ...existing, metadata: { ...existingMetadata, prompt, composerContent, ...storyboardPromptTemplateMetadata(row, "image"), workflowKind: "shot" as const, workflowTitle: `镜头 ${row.shotNumber} 分镜图`, shotIndex: row.shotNumber } }
                : createCanvasNode(CanvasNodeType.Image, { x: startX + imageSpec.width / 2, y: scriptNode.position.y + index * (imageSpec.height + 36) + imageSpec.height / 2 }, { prompt, composerContent, ...storyboardPromptTemplateMetadata(row, "image"), workflowKind: "shot", workflowTitle: `镜头 ${row.shotNumber} 分镜图`, shotIndex: row.shotNumber, status: NODE_STATUS_IDLE });
            if (!existing) {
                imageNode.title = `镜头 ${row.shotNumber} · 分镜图`;
                nextNodes.push(imageNode);
            } else {
                const existingIndex = nextNodes.findIndex((node) => node.id === existing.id);
                nextNodes[existingIndex] = imageNode;
            }
            nextConnections = reconcileStoryboardTargetConnections(nextConnections, scriptNode, row, imageNode.id, referenceIds);
            targets.push({ row, node: imageNode, prompt });
        });
        const imageNodeByRowId = new Map(targets.map((target) => [target.row.id, target.node.id]));
        const scriptIndex = nextNodes.findIndex((node) => node.id === scriptNode.id);
        nextNodes[scriptIndex] = {
            ...scriptNode,
            metadata: {
                ...scriptNode.metadata,
                storyboard: {
                    rows: (scriptNode.metadata?.storyboard?.rows || []).map((row) => ({ ...row, imageNodeId: imageNodeByRowId.get(row.id) || row.imageNodeId })),
                    visibleColumns: scriptNode.metadata?.storyboard?.visibleColumns || ["shotNumber", "durationSeconds", "videoMotionPrompt", "dialogue", "assets"],
                    referenceNodeIds: scriptNode.metadata?.storyboard?.referenceNodeIds || [],
                },
            },
        };
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        setNodes(nextNodes);
        setConnections(nextConnections);
        return targets;
    }, [connectionsRef, nodesRef, setConnections, setNodes]);

    const createScriptImageNodes = useCallback((nodeId: string, rowIds?: string[]) => {
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const rows = scriptNode?.metadata?.storyboard?.rows || [];
        const selectedRows = rowIds?.length ? rows.filter((row) => rowIds.includes(row.id)) : rows;
        if (!scriptNode || !selectedRows.length) return;
        const missing = selectedRows.filter((row) => !(row.imageGenerationPrompt || row.plotDescription).trim());
        if (missing.length) return message.warning(`有 ${missing.length} 个镜头缺少画面描述或图片提示词`);
        const createdCount = selectedRows.filter((row) => !row.imageNodeId || !nodesRef.current.some((node) => node.id === row.imageNodeId && node.type === CanvasNodeType.Image)).length;
        ensureScriptImageNodes(nodeId, selectedRows.map((row) => row.id));
        message.success(createdCount ? `已创建 ${createdCount} 个图片节点` : "已同步现有图片节点的提示词");
    }, [ensureScriptImageNodes, message, nodesRef]);

    const generateScriptImages = useCallback(async (nodeId: string, rowIds: string[]) => {
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const rows = (scriptNode?.metadata?.storyboard?.rows || []).filter((row) => rowIds.includes(row.id));
        if (!scriptNode || !rows.length) return;
        const missing = rows.filter((row) => !(row.imageGenerationPrompt || row.plotDescription).trim());
        if (missing.length) return message.warning(`有 ${missing.length} 个镜头缺少画面描述或图片提示词`);
        const imageModel = effectiveConfig.imageModel || effectiveConfig.model;
        if (!isAiConfigReady(effectiveConfig, imageModel)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        const activeNodeIds = activeGenerationBatchNodeIds(scriptNode, "storyboard_image");
        const targetRows = rows.filter((row) => {
            const imageNode = row.imageNodeId ? nodesRef.current.find((node) => node.id === row.imageNodeId && node.type === CanvasNodeType.Image) : undefined;
            return !imageNode?.metadata?.content && (!imageNode || !activeNodeIds.has(imageNode.id));
        });
        if (!targetRows.length) return message.info("所选分镜图已生成或正在生成");
        if (!await confirmGenerationSubmission(targetRows.length, imageModel, "图片生成", "image", { capability: "image", options: { size: effectiveConfig.size, quality: effectiveConfig.quality } })) return;
        const targets = ensureScriptImageNodes(nodeId, targetRows.map((row) => row.id));
        if (enqueueGenerationBatch(nodeId, "storyboard_image", targets.map((target) => ({ rowId: target.row.id, nodeId: target.node.id })))) message.success("分镜图已加入生成队列");
    }, [effectiveConfig, enqueueGenerationBatch, ensureScriptImageNodes, confirmGenerationSubmission, isAiConfigReady, message, nodesRef]);

    const createAndGenerateScriptVideos = useCallback(async (nodeId: string, rowIds?: string[]) => {
        if (storyboardRequests.current.has(nodeId)) return;
        const signal = storyboardLifetime.current.signal;
        const scope = getActiveUserScope();
        storyboardRequests.current.add(nodeId);
        try {
        const videoModel = effectiveConfig.videoModel || effectiveConfig.model;
        if (!isAiConfigReady(effectiveConfig, videoModel)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        let scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const allRows = scriptNode?.metadata?.storyboard?.rows || [];
        const rows = rowIds?.length ? allRows.filter((row) => rowIds.includes(row.id)) : allRows;
        const describedRows = rows.filter(storyboardRowIsReady);
        const activeRowIds = scriptNode ? activeGenerationBatchRowIds(scriptNode, "storyboard_video") : new Set<string>();
        const targetRows = describedRows.filter((row) => {
            return !row.videoGeneration?.content && !row.videoGeneration?.storageKey && !["queued", "running"].includes(row.videoGeneration?.taskStatus || "") && !activeRowIds.has(row.id);
        });
        if (!targetRows.length) {
            if (describedRows.some((row) => row.videoGeneration?.content || row.videoGeneration?.storageKey)) message.info("镜头视频已存在");
            else message.warning("请先补充镜头画面描述");
            return;
        }
        if (!await confirmGenerationSubmission(targetRows.length, videoModel, "视频生成", "video", { capability: "video", videoSeconds: effectiveConfig.videoSeconds, options: { size: effectiveConfig.size, vquality: effectiveConfig.vquality, videoSeconds: Number(effectiveConfig.videoSeconds), videoGenerateAudio: effectiveConfig.videoGenerateAudio === "true" } })) return;
        signal.throwIfAborted();
        if (scope !== getActiveUserScope()) return;
        const targets = targetRows.map(row => ({ rowId: row.id, nodeId, targetKind: "storyboard_video" as const }));
        if (enqueueGenerationBatch(nodeId, "storyboard_video", targets)) message.success("镜头视频已加入分镜列表生成队列");
        } catch (error) {
            if (!signal.aborted && scope === getActiveUserScope()) message.error(generationErrorMessage(error));
        } finally { storyboardRequests.current.delete(nodeId); }
    }, [confirmGenerationSubmission, effectiveConfig, enqueueGenerationBatch, isAiConfigReady, message, nodesRef]);

    const createScriptActionBoards = useCallback(async (nodeId: string) => {
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const rows = scriptNode?.metadata?.storyboard?.rows || [];
        if (!scriptNode || !rows.length) return;
        const imageModel = effectiveConfig.imageModel || effectiveConfig.model;
        if (!isAiConfigReady(effectiveConfig, imageModel)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        const actionBoardRows = rows.filter((row) => !nodesRef.current.some((node) => node.type === CanvasNodeType.Image && node.metadata?.workflowKind === "action_board" && node.metadata.shotIndex === row.shotNumber && Boolean(node.metadata.content)));
        if (!actionBoardRows.length) {
            message.info("动作拆分板已存在");
            return;
        }
        if (!await confirmGenerationSubmission(actionBoardRows.length, imageModel, "动作板生成", "image", { capability: "image", options: { size: effectiveConfig.size, quality: effectiveConfig.quality } })) return;
        const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const startX = scriptNode.position.x + scriptNode.width + 120;
        const nextNodes = [...nodesRef.current];
        const nextConnections = [...connectionsRef.current];
        const targets: Array<{ row: StoryboardRow; node: CanvasNodeData; prompt: string }> = [];
        actionBoardRows.forEach((row, index) => {
            const prompt = [
                "生成一张电影动作拆分 12 宫格参考图，严格 3 列 4 行，12 个格子清晰分隔，保持同一角色、服装、场景和光线连续。",
                `镜头 ${row.shotNumber}：${row.plotDescription || row.videoMotionPrompt || "根据镜头剧情补全动作"}`,
                row.characters.length ? `角色：${row.characters.map((item) => item.characterName).join("、")}` : "",
                "按时间顺序展示动作起势、推进、转折、落点和结束姿态，不要添加文字、边框标题或额外画面。",
            ].filter(Boolean).join("\n");
            const existingIndex = nextNodes.findIndex((node) => node.type === CanvasNodeType.Image && node.metadata?.workflowKind === "action_board" && node.metadata.shotIndex === row.shotNumber);
            if (existingIndex >= 0 && nextNodes[existingIndex].metadata?.content) return;
            const imageNode = existingIndex >= 0
                ? { ...nextNodes[existingIndex], metadata: { ...resetGenerationTaskMetadata(nextNodes[existingIndex].metadata), prompt } }
                : createCanvasNode(CanvasNodeType.Image, { x: startX + imageSpec.width / 2, y: scriptNode.position.y + index * (imageSpec.height + 36) + imageSpec.height / 2 }, { prompt, workflowKind: "action_board", workflowTitle: `镜头 ${row.shotNumber} 动作板`, shotIndex: row.shotNumber, actionBoardRows: 4, actionBoardColumns: 3, status: NODE_STATUS_IDLE });
            imageNode.title = `镜头 ${row.shotNumber} · 动作板`;
            if (existingIndex >= 0) nextNodes[existingIndex] = imageNode;
            else {
                nextNodes.push(imageNode);
                nextConnections.push({ id: nanoid(), fromNodeId: scriptNode.id, toNodeId: imageNode.id, fromHandleId: `row:${row.id}` });
            }
            targets.push({ row, node: imageNode, prompt });
        });
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        setNodes(nextNodes);
        setConnections(nextConnections);
        if (enqueueGenerationBatch(nodeId, "action_board", targets.map((target) => ({ rowId: target.row.id, nodeId: target.node.id })))) message.success("动作拆分板已加入生成队列");
    }, [connectionsRef, confirmGenerationSubmission, effectiveConfig, enqueueGenerationBatch, isAiConfigReady, message, nodesRef, setConnections, setNodes]);

    const generateScriptVideos = useCallback(async (nodeId: string, rowIds: string[]) => {
        const scriptNode = nodesRef.current.find((node) => node.id === nodeId && node.type === CanvasNodeType.Script);
        const rows = (scriptNode?.metadata?.storyboard?.rows || []).filter((row) => rowIds.includes(row.id));
        if (!scriptNode || !rows.length) return;
        const readyRows = rows.filter((row) => row.imageNodeId && nodesRef.current.some((node) => node.id === row.imageNodeId && node.type === CanvasNodeType.Image && node.metadata?.content));
        if (!readyRows.length) return message.warning("请先生成并检查选中镜头的首帧");
        if (readyRows.length !== rows.length) return message.warning(`${rows.length - readyRows.length} 个选中镜头还没有可用首帧，请全部生成并检查后再确认`);
        const videoModel = effectiveConfig.videoModel || effectiveConfig.model;
        if (!isAiConfigReady(effectiveConfig, videoModel)) {
            navigateToSettings({ continueCreation: true });
            return;
        }
        const activeRowIds = activeGenerationBatchRowIds(scriptNode, "storyboard_video");
        const targetRows = readyRows.filter((row) => {
            return !row.videoGeneration?.content && !row.videoGeneration?.storageKey && !["queued", "running"].includes(row.videoGeneration?.taskStatus || "") && !activeRowIds.has(row.id);
        });
        if (!targetRows.length) return message.info("所选镜头视频已生成或正在生成");
        if (!await confirmGenerationSubmission(targetRows.length, videoModel, "视频生成", "video", { capability: "video", videoSeconds: effectiveConfig.videoSeconds, options: { size: effectiveConfig.size, vquality: effectiveConfig.vquality, videoSeconds: Number(effectiveConfig.videoSeconds), videoGenerateAudio: effectiveConfig.videoGenerateAudio === "true" } })) return;
        if (enqueueGenerationBatch(nodeId, "storyboard_video", targetRows.map(row => ({ rowId: row.id, nodeId, targetKind: "storyboard_video" as const })))) message.success("镜头视频已加入分镜列表生成队列");
    }, [confirmGenerationSubmission, effectiveConfig, enqueueGenerationBatch, isAiConfigReady, message, nodesRef]);

    return {
        addScriptRow,
        createAndGenerateScriptVideos,
        createScriptActionBoards,
        createScriptImageNodes,
        generateScriptImages,
        generateScriptRows,
        generateScriptVideos,
        removeScriptRow,
        replaceScriptRows,
        updateScriptRow,
        updateScriptRows,
    };
}

function invalidateEditedPromptVariables(previous: StoryboardRow | undefined, next: StoryboardRow) {
    if (!previous) return next;
    return {
        ...next,
        imagePromptTemplateVariables: next.imageGenerationPrompt === previous.imageGenerationPrompt ? next.imagePromptTemplateVariables : undefined,
        videoPromptTemplateVariables: next.videoMotionPrompt === previous.videoMotionPrompt ? next.videoPromptTemplateVariables : undefined,
    };
}

function activeGenerationBatchNodeIds(node: CanvasNodeData, mode: CanvasGenerationBatchMode) {
    return new Set((node.metadata?.generationBatches || [])
        .filter((batch) => batch.mode === mode && !batch.paused)
        .flatMap((batch) => batch.items
            .filter((item) => item.status === "waiting" || item.status === "submitting" || item.status === "queued" || item.status === "running")
            .map((item) => item.nodeId)));
}

function activeGenerationBatchRowIds(node: CanvasNodeData, mode: CanvasGenerationBatchMode) {
    return new Set((node.metadata?.generationBatches || [])
        .filter(batch => batch.mode === mode && !batch.paused)
        .flatMap(batch => batch.items.filter(item => item.targetKind === "storyboard_video" && ["waiting", "submitting", "queued", "running"].includes(item.status)).map(item => item.rowId)));
}
