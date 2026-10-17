import { useEffect, useRef, useState } from "react";
import { workflowBodyTaskInput } from "@/lib/canvas/canvas-short-drama-workflow";
import { App } from "antd";
import { createWorkflowDocuments, groupExistingWorkflowEpisodes, groupSelectedWorkflowDocuments, workflowGenerationSources, workflowSignatureMatches, workflowSourceSignaturesMatch, type WorkflowGenerationRequest } from "@/lib/canvas/canvas-short-drama-workflow";
import { createWorkflowImages, workflowImageReferences } from "@/lib/canvas/canvas-workflow-images";
import { compactWorkflowNodes, markWorkflowSubmissionBlocked } from "@/lib/canvas/canvas-workflow-persistence";
import { workflowRequestWithCurrentSettings } from "@/lib/canvas/canvas-global-settings";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { shortDramaStep } from "@/lib/short-drama-steps";
import { mergedImageCapabilityConfig, modelCompatibilityError } from "@/lib/model-selection";
import { getActiveUserScope } from "@/lib/user-scope";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { cancelGenerationTask, createGenerationTask, waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { cancelAgentRun, reconcileCanvasNodeTasks } from "@/services/api/agent";
import { ApiError } from "@/services/api/request";
import { prepareProductionAgent, submitProductionAgent } from "@/services/production-agent";
import { refreshCanvasAfterAgent } from "@/services/user-data-sync";
import { withRuntimeConcurrency } from "@/services/runtime-limits";
import { selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";
import type { CanvasConnection, CanvasNodeData, Position } from "@/types/canvas";

type Options = {
    projectId: string; config: AiConfig;
    nodesRef: { current: CanvasNodeData[] }; connectionsRef: { current: CanvasConnection[] };
    setNodes: (update: CanvasNodeData[] | ((nodes: CanvasNodeData[]) => CanvasNodeData[])) => void;
    setConnections: (connections: CanvasConnection[]) => void;
    save: () => Promise<boolean>; center: () => Position; focus: (id: string) => void;
    bindTask: (id: string, task: GenerationTask) => void;
    applyResult: (id: string, task: GenerationTask) => Promise<void>;
};

const workflowSubmitGapMs = 220;
const workflowSubmitRetryDelaysMs = [500, 1_000, 2_000] as const;

function waitWithWorkflowAbort(delay: number, signal: AbortSignal) {
    if (delay <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            error ? reject(error) : resolve();
        };
        const abort = () => finish(new DOMException("已取消", "AbortError"));
        const timer = window.setTimeout(() => finish(), delay);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
    });
}

function waitForWorkflowSubmitGap(lastSubmittedAt: number, signal: AbortSignal) {
    const remaining = workflowSubmitGapMs - (Date.now() - lastSubmittedAt);
    return waitWithWorkflowAbort(Math.max(0, remaining), signal);
}

function retryableWorkflowSubmitError(error: unknown) {
    if (error instanceof ApiError) return error.retryable || /database is (?:locked|busy)|sqlite_busy|sqlite_locked/i.test(`${error.reason || ""} ${error.message}`);
    return /database is (?:locked|busy)|sqlite_busy|sqlite_locked/i.test(error instanceof Error ? error.message : String(error));
}

async function createWorkflowTaskWithBackoff(input: Parameters<typeof createGenerationTask>[0], signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await createGenerationTask(input);
        } catch (error) {
            if (!retryableWorkflowSubmitError(error) || attempt >= workflowSubmitRetryDelaysMs.length) throw error;
            const retryAfter = error instanceof ApiError ? error.retryAfterMs : undefined;
            const delay = Math.max(retryAfter || 0, workflowSubmitRetryDelaysMs[attempt]);
            await waitWithWorkflowAbort(delay, signal);
        }
    }
}

export function useShortDramaWorkflowGeneration(options: Options) {
    const ref = useRef(options); ref.current = options;
    const { message } = App.useApp();
    const [submitting, setSubmitting] = useState(false);
    const lock = useRef(false);
    const lifetime = useRef(new AbortController());
    const scope = getActiveUserScope();
    useEffect(() => {
        const controller = new AbortController(); lifetime.current = controller;
        return () => controller.abort();
    }, [options.projectId, scope]);

    const submit = async (ids: string[]) => {
        const context = ref.current;
        const compacted = compactWorkflowNodes(context.nodesRef.current);
        if (compacted.some((node, index) => node !== context.nodesRef.current[index])) context.setNodes(compacted);
        const signal = lifetime.current.signal;
        const valid = () => !signal.aborted && context.projectId === ref.current.projectId && getActiveUserScope() === scope;
        let lastSubmittedAt = 0;
        const patch = (id: string, update: (node: CanvasNodeData) => CanvasNodeData) => {
            if (valid()) context.setNodes((nodes) => nodes.map((node) => node.id === id ? update(node) : node));
        };
        for (const id of ids) {
            if (!valid()) break;
            const node = context.nodesRef.current.find((entry) => entry.id === id);
            const data = node?.metadata?.shortDrama;
            if (!node || data?.submission !== "planned") continue;
            const sources = workflowGenerationSources(data, context.nodesRef.current, context.connectionsRef.current);
            if (sources.some((source) => !workflowSignatureMatches(source, data.sourceSignatures[source.id] || ""))) throw new Error("前置内容已变化，未提交节点保留，请重新生成");
            if (Object.entries(data.sourceSignatures).some(([sourceId, signature]) => {
                const source = context.nodesRef.current.find((entry) => entry.id === sourceId);
                return !source || !workflowSignatureMatches(source, signature);
            })) throw new Error("前置内容已变化，未提交节点保留，请重新生成");
            const validateAfterSave = async () => {
                let referencesCurrent = true;
                if (data.mediaKind === "image" || data.assetRevision) {
                    try { workflowGenerationSources(data, context.nodesRef.current, context.connectionsRef.current); }
                    catch { referencesCurrent = false; }
                }
                if (referencesCurrent && workflowSourceSignaturesMatch(data, context.nodesRef.current)) return;
                // Saving may rebase a newer source document. Do not submit the old
                // prompt, and do not let background recovery replay its marker.
                patch(id, (current) => ({ ...current, metadata: { ...current.metadata, status: "error", taskStage: "前置内容已变化", shortDrama: { ...current.metadata!.shortDrama!, submission: "rejected" } } }));
                if (valid()) await context.save();
                throw new Error("前置内容在保存期间已更新，尚未提交生成，请基于新内容重新生成");
            };
            if (data.productionAgent) {
                const request = await prepareProductionAgent(context.projectId, node, context.config);
                if (!valid() || !context.nodesRef.current.some((entry) => entry.id === id)) break;
                patch(id, (current) => ({ ...current, metadata: { ...current.metadata, status: "loading", errorDetails: undefined, taskStage: "正在提交制作 Agent", shortDrama: { ...data, submission: "submitting", productionAgent: { ...data.productionAgent!, request } } } }));
                if (!await context.save()) {
                    patch(id, (current) => ({ ...current, metadata: { ...current.metadata, status: "error", taskStage: "等待云端保存", errorDetails: "制作任务尚未保存，未向模型提交请求", shortDrama: { ...data, submission: "planned" } } }));
                    throw new Error("制作任务尚未保存，未向模型提交请求");
                }
                await validateAfterSave();
                try {
                    if (!valid() || !context.nodesRef.current.some((entry) => entry.id === id)) break;
                    await waitForWorkflowSubmitGap(lastSubmittedAt, signal);
                    const { run } = await withRuntimeConcurrency("agent", () => submitProductionAgent(request), signal);
                    lastSubmittedAt = Date.now();
                    if (valid() && !context.nodesRef.current.some((entry) => entry.id === id)) {
                        await cancelAgentRun(run.id);
                        if (await context.save()) await reconcileCanvasNodeTasks(context.projectId, [id]);
                        continue;
                    }
                    if (valid()) await refreshCanvasAfterAgent(context.projectId);
                } catch (error) {
                    if (valid()) {
                        patch(id, (current) => ({ ...current, metadata: { ...current.metadata, status: "error", taskStage: "制作任务提交待确认", errorDetails: error instanceof Error ? error.message : "提交失败，请在节点详情继续" } }));
                        await context.save();
                    }
                    if (valid()) message.warning(error instanceof Error ? error.message : "制作任务回执待确认，重新打开画布后将核对原任务");
                }
                continue;
            }
            const mode = data.mediaKind === "image" ? "image" : "text";
            const selectedModel = node.metadata!.model!;
            if (!selectableModelsByCapability(context.config, mode).includes(selectedModel)) throw new Error(mode === "image" ? "请选择可用的生图模型" : "请选择可用的文本模型");
            const referenceImages = mode === "image" ? workflowImageReferences(node, context.nodesRef.current) : [];
            if (mode === "image") {
                const problem = modelCompatibilityError(context.config, selectedModel, { capability: "image", input: { textCount: 1, imageCount: referenceImages.length, videoCount: 0, audioCount: 0, characterCount: 0 }, imageSize: node.metadata?.size });
                if (problem) throw new Error(problem);
            }
            const textInput = workflowBodyTaskInput(node, context.nodesRef.current, context.connectionsRef.current);
            const input = await prepareBackendGenerationTask({ projectId: context.projectId, mode, prompt: textInput.prompt, workflowBatch: mode === "text" ? textInput.workflowBatch : undefined,
                config: { ...context.config, model: selectedModel, ...(mode === "image" ? { imageModel: selectedModel, size: node.metadata?.size || context.config.size, quality: node.metadata?.quality || context.config.quality, transparentBackground: node.metadata?.transparentBackground || "false", count: "1" } : {}) },
                referenceImages, reasoningEffort: mode === "text" ? node.metadata!.reasoningEffort || "medium" : undefined, streamText: mode === "text" && !textInput.workflowBatch, clientOperationId: data.operationId,
                metadata: { source: "canvas-short-drama-workflow", nodeId: id, pipelineId: data.pipelineId, workflowStage: data.stage, workflowStep: data.step, episodeNumber: data.episodeNumber } });
            if (!valid() || !context.nodesRef.current.some((entry) => entry.id === id)) break;
            patch(id, (current) => ({ ...current, metadata: { ...current.metadata, status: "loading", errorDetails: undefined, taskStage: "正在提交", taskClientOperationId: data.operationId, shortDrama: { ...data, submission: "submitting" } } }));
            // Persist the uncertain-submit marker before POST. A reload must never replay it.
            if (!await context.save()) {
                patch(id, (current) => ({ ...current, metadata: { ...current.metadata, status: "error", taskStage: "等待云端保存", errorDetails: "节点未保存到云端，尚未提交生成任务", shortDrama: { ...data, submission: "planned" } } }));
                throw new Error("节点未保存到云端，尚未提交生成任务，请恢复保存后继续");
            }
            await validateAfterSave();
            if (!valid() || !context.nodesRef.current.some((entry) => entry.id === id)) break;
            try {
                await waitForWorkflowSubmitGap(lastSubmittedAt, signal);
                const task = await withRuntimeConcurrency(mode, () => createWorkflowTaskWithBackoff(input, signal), signal);
                lastSubmittedAt = Date.now();
                if (!valid()) break;
                if (!context.nodesRef.current.some((entry) => entry.id === id)) {
                    if (["queued", "running"].includes(task.status)) await cancelGenerationTask(task.id);
                    if (await context.save()) await reconcileCanvasNodeTasks(context.projectId, [id]);
                    continue;
                }
                context.bindTask(id, task);
                patch(id, (current) => ({ ...current, metadata: { ...current.metadata, shortDrama: { ...data, submission: "submitted" } } }));
                const monitor = async () => {
                    try {
                        const done = task.status === "succeeded" ? task : await waitForGenerationTask(task.id, { signal, initialTask: task, onTaskUpdate: (update) => { if (valid()) context.bindTask(id, update); } });
                        if (!valid() || !context.nodesRef.current.some((entry) => entry.id === id)) return;
                        await context.applyResult(id, done);
                        if (valid()) await context.save();
                    } catch (error) {
                        if (valid()) message.warning(error instanceof Error ? error.message : "任务状态暂不可用，请到任务中心查看");
                    }
                };
                void monitor();
            } catch (error) {
                if (!valid()) break;
                const rejected = error instanceof ApiError && [400, 401, 403, 404, 422, 429].includes(error.status || 0);
                patch(id, (current) => ({ ...current, metadata: { ...current.metadata, status: rejected ? "error" : "loading", errorDetails: rejected ? (error as Error).message : undefined, taskStage: rejected ? "提交失败" : "提交结果待确认，请在任务中心核对", shortDrama: { ...data, submission: rejected ? "rejected" : "unknown" } } }));
                message.warning(rejected ? "任务提交失败，原节点已保留" : "提交回执待确认，未重复提交；刷新可恢复原任务");
            }
        }
    };

    const run = (request: WorkflowGenerationRequest) => {
        if (lock.current) throw new Error("上一批生成请求正在提交，请稍后再试");
        const context = ref.current;
        const signal = lifetime.current.signal;
        const valid = () => !signal.aborted && context.projectId === ref.current.projectId && getActiveUserScope() === scope;
        const mode = shortDramaStep(request.step)?.mediaOutput === "image" ? "image" : "text";
        if (!selectableModelsByCapability(context.config, mode).includes(request.model)) throw new Error(mode === "image" ? "请选择可用的生图模型" : "请选择可用的文本模型");
        lock.current = true; setSubmitting(true);
        const execute = async () => {
            let createdIds: string[] = [];
            try {
                // Let the dialog unmount before constructing nodes; the canvas owns the work.
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                if (!valid()) return;
                // Resolve at creation time so an older dialog cannot pin new work to obsolete settings.
                const currentRequest = workflowRequestWithCurrentSettings(request, useCanvasStore.getState().openProject(context.projectId)?.globalSettings);
                const prepared = mode === "image"
                    ? createWorkflowImages(currentRequest, context.nodesRef.current, context.connectionsRef.current, context.center(), mergedImageCapabilityConfig(context.config, request.model))
                    : createWorkflowDocuments(currentRequest, context.nodesRef.current, context.connectionsRef.current, context.center());
                context.setNodes(prepared.nodes); context.setConnections(prepared.connections);
                createdIds = prepared.created.map((node) => node.id);
                context.focus(prepared.created[0].id);
                if (!await context.save()) throw new Error("结果节点已保留，云端保存失败，尚未发起生成；恢复后可右键继续提交");
                if (valid()) await submit(prepared.created.map((node) => node.id));
            } catch (error) {
                if (valid()) {
                    const reason = error instanceof Error ? error.message : "生成提交失败，请检查节点状态后重试";
                    context.setNodes((nodes) => markWorkflowSubmissionBlocked(nodes, createdIds, reason));
                    message.error(reason);
                }
            } finally { lock.current = false; setSubmitting(false); }
        };
        void execute();
    };
    const resume = async (id: string) => {
        if (lock.current) return;
        lock.current = true; setSubmitting(true);
        let ids: string[] = [];
        const context = ref.current;
        const signal = lifetime.current.signal;
        try {
            const node = ref.current.nodesRef.current.find((node) => node.id === id);
            const data = node?.metadata?.shortDrama;
            ids = data?.role === "collection" ? data.sourceNodeIds : node?.type === "frame"
                ? ref.current.nodesRef.current.filter(member => member.parentId === id && member.metadata?.shortDrama?.submission === "planned").map(member => member.id) : [id];
            await submit(ids);
        }
        catch (error) {
            if (!signal.aborted && getActiveUserScope() === scope && context.projectId === ref.current.projectId) {
                const reason = error instanceof Error ? error.message : "提交失败";
                context.setNodes((nodes) => markWorkflowSubmissionBlocked(nodes, ids, reason));
                message.error(reason);
            }
        }
        finally { lock.current = false; setSubmitting(false); }
    };
    const groupEpisodes = async (id: string | string[], targetId?: string) => {
        try {
            const context = ref.current;
            const result = Array.isArray(id) ? groupSelectedWorkflowDocuments(id, context.nodesRef.current, context.connectionsRef.current, targetId) : groupExistingWorkflowEpisodes(id, context.nodesRef.current, context.connectionsRef.current);
            context.setNodes(result.nodes); context.setConnections(result.connections); context.focus(result.collection.id);
            if (!await context.save()) message.warning("分组已在本地保留，云端尚未保存");
            return result.collection.id;
        } catch (error) { message.error(error instanceof Error ? error.message : "分组失败"); }
    };
    return { run, resume, groupEpisodes, submitting, submissionLock: lock };
}
