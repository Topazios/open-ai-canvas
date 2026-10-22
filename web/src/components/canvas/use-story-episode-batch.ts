import { createClientId } from "@/lib/client-id";
import { useEffect, useRef, useState } from "react";
import { buildStoryDevelopmentPrompt, storyDocumentSignature, storySourceState } from "@/lib/canvas/canvas-story-development";
import { getActiveUserScope } from "@/lib/user-scope";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { ApiError } from "@/services/api/request";
import { cancelGenerationTask, createGenerationTask, listGenerationTasks, queryGenerationTask } from "@/services/api/task-center";
import { createStorySessionStore, receiveStoryTask, recoverStorySession, storyDraftKey, storyJobActive, storyTaskMatches, type StoryEpisodeBatch, type StorySession } from "@/services/story-development-session";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData, StoryDevelopmentData } from "@/types/canvas";

type PreparedBatch = { nodes: CanvasNodeData[]; targets: CanvasNodeData[]; skipped: number[] };
type Options = {
    node: CanvasNodeData; nodes: CanvasNodeData[]; canvasId: string; config: AiConfig; model: string;
    session: StorySession; current: { current: StorySession }; ready: boolean;
    update: (patch: Partial<StorySession>) => Promise<void>;
    onPrepare: (start: number, count: number, excludedIds: string[]) => Promise<PreparedBatch>;
    onSave: (original: CanvasNodeData, title: string, content: string, data: StoryDevelopmentData) => CanvasNodeData;
    onPersist: () => Promise<boolean>;
};
type BatchRow = { nodeId: string; episodeNumber: number; status: string; error?: string };
const labels: Record<string, string> = { pending: "待提交", submitting: "提交中", unknown: "提交待确认", queued: "已排队", running: "生成中", ready: "结果待写回", succeeded: "已写回画布", failed: "生成失败", cancelled: "已停止", conflict: "待检查", replaced: "已另行处理", deleted: "节点已删除" };

export function useStoryEpisodeBatch(options: Options) {
    const ref = useRef(options); ref.current = options;
    const [scope] = useState(getActiveUserScope);
    const alive = useRef(false);
    const working = useRef(false);
    const [submitting, setSubmitting] = useState(false);
    const [rows, setRows] = useState<BatchRow[]>([]);
    const [error, setError] = useState("");
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const valid = () => alive.current && getActiveUserScope() === scope;
    const store = (id: string) => createStorySessionStore(scope, ref.current.canvasId, id);
    const read = async (node: CanvasNodeData) => {
        if (node.id === ref.current.node.id) return ref.current.current.current;
        const saved = await store(node.id).read();
        return { ...recoverStorySession(saved, node, ref.current.model), revision: saved?.revision || 0 };
    };
    const write = async (id: string, value: StorySession) => {
        if (!valid()) throw new Error("批次已挂起，请重新打开后继续");
        if (id === ref.current.node.id) { await ref.current.update(value); return ref.current.current.current; }
        const revision = await store(id).write(value, value.revision);
        return { ...value, revision };
    };
    const saveResult = async (node: CanvasNodeData, value: StorySession) => {
        if (value.job?.status !== "succeeded" || value.job.appliedToCanvas) return value;
        const desired = { ...node, title: value.title, metadata: { ...node.metadata, content: value.content, richText: undefined, storyDevelopment: value.data } };
        const alreadySaved = storyDocumentSignature(node) === storyDocumentSignature(desired);
        if (!alreadySaved && storyDocumentSignature(node) !== value.baseSignature) throw new Error("正文已被其他操作修改，生成结果保留在本机，打开后合并");
        const saved = alreadySaved ? node : ref.current.onSave(node, value.title, value.content, value.data);
        if (!await ref.current.onPersist()) throw new Error("生成正文已保留在本机，云端保存失败，恢复连接后继续保存");
        const latest = await read(node);
        if (latest.job?.operationId !== value.job.operationId) return latest;
        if (latest.title !== value.title || storyDraftKey(latest) !== storyDraftKey(value)) throw new Error("保存期间正文已修改，本机草稿保留，请打开后合并");
        return write(node.id, { ...latest, baseSignature: storyDocumentSignature(saved), data: structuredClone(saved.metadata!.storyDevelopment!), dirty: false, job: { ...latest.job, appliedToCanvas: true } });
    };

    const dispatch = async (batch: StoryEpisodeBatch, fallbackNodes: CanvasNodeData[] = []) => {
        for (const item of batch.items) {
            if (!valid() || ref.current.current.current.episodeBatch?.stopped) break;
            const node = ref.current.nodes.find((entry) => entry.id === item.nodeId) || fallbackNodes.find((entry) => entry.id === item.nodeId);
            if (!node) continue;
            let value = await read(node);
            if (value.job?.operationId === item.operationId && value.job.status !== "pending") continue;
            if (value.job?.operationId !== item.operationId && (storyJobActive(value.job) || value.content.trim() || value.preview)) throw new Error(`第 ${item.episodeNumber} 集已有正文、草稿或任务，未重复提交`);
            const prompt = buildStoryDevelopmentPrompt(value.data, ref.current.nodes.length >= fallbackNodes.length ? ref.current.nodes : fallbackNodes, value.content, ref.current.current.current.instruction);
            const input = await prepareBackendGenerationTask({ projectId: ref.current.canvasId, mode: "text", prompt, config: { ...ref.current.config, model: ref.current.model }, streamText: true, clientOperationId: item.operationId,
                metadata: { source: "canvas-story-development", stage: "body", storyNodeId: node.id, pipelineId: value.data.pipelineId, episodeNumber: item.episodeNumber, storyBatchId: batch.id } });
            const latestDraft = await read(node);
            if (latestDraft.title !== value.title || storyDraftKey(latestDraft) !== storyDraftKey(value) || latestDraft.job?.operationId !== value.job?.operationId) throw new Error(`第 ${item.episodeNumber} 集在提交前已修改，草稿保留，请检查后继续`);
            value = latestDraft;
            value = await write(node.id, { ...value, job: { operationId: item.operationId, status: "submitting", draw: false, topicCount: 4, draft: storyDraftKey(value), signatures: storySourceState(value.data, ref.current.nodes.length >= fallbackNodes.length ? ref.current.nodes : fallbackNodes).signatures, batchOwnerNodeId: ref.current.node.id } });
            // The durable submitting marker precedes POST; uncertain receipts are never reposted.
            try {
                const task = await createGenerationTask(input);
                const latest = await read(node);
                if (latest.job?.operationId === item.operationId) await write(node.id, receiveStoryTask(latest, task));
            } catch (failure) {
                const latest = await read(node);
                if (latest.job?.operationId !== item.operationId || latest.job.taskId || !valid()) continue;
                const rejected = failure instanceof ApiError && [400, 401, 403, 404, 422, 429].includes(failure.status || 0);
                await write(node.id, { ...latest, job: { ...latest.job, status: rejected ? "failed" : "unknown", error: failure instanceof Error ? failure.message : "提交结果待确认" } });
            }
        }
    };
    const run = async (start?: number, count?: number) => {
        if (working.current || !valid()) return;
        working.current = true; setSubmitting(true); setError("");
        try {
            let batch = ref.current.current.current.episodeBatch;
            let fallback: CanvasNodeData[] = [];
            if (start !== undefined && count !== undefined) {
                const excluded: string[] = [];
                for (const node of ref.current.nodes.filter((entry) => entry.metadata?.storyDevelopment?.pipelineId === ref.current.current.current.data.pipelineId && entry.metadata.storyDevelopment.stage === "body")) {
                    const value = await read(node);
                    if (value.content.trim() || value.preview || storyJobActive(value.job)) excluded.push(node.id);
                }
                if (batch && !batch.stopped) {
                    for (const item of batch.items) {
                        const node = ref.current.nodes.find((entry) => entry.id === item.nodeId);
                        if (!node) continue;
                        const value = await read(node);
                        if ((value.job?.operationId === item.operationId && (storyJobActive(value.job) || (value.job.status === "succeeded" && !value.job.appliedToCanvas))) || (!value.job && !value.content.trim())) throw new Error("当前批次尚未结束，请先继续或停止当前批次");
                    }
                }
                const prepared = await ref.current.onPrepare(start, count, excluded);
                if (!prepared.targets.length) throw new Error("所选集已有正文、草稿或运行中的任务，无需重复生成");
                fallback = prepared.nodes;
                batch = { id: createClientId(), items: prepared.targets.map((node) => ({ nodeId: node.id, episodeNumber: node.metadata!.storyDevelopment!.episodeNumber!, operationId: createClientId() })), skipped: prepared.skipped };
                await ref.current.update({ episodeBatch: batch, batchStart: start, batchCount: count });
            }
            if (batch && !batch.stopped) await dispatch(batch, fallback);
        } catch (failure) { if (valid()) setError(failure instanceof Error ? failure.message : "批次提交失败，未完成项可继续提交"); }
        finally { working.current = false; if (alive.current) setSubmitting(false); }
    };

    useEffect(() => {
        if (!options.ready || (!options.session.episodeBatch && !options.session.job?.batchOwnerNodeId)) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            const batch = ref.current.current.current.episodeBatch;
            const own = ref.current.current.current.job;
            const items = batch?.items || (own?.batchOwnerNodeId ? [{ nodeId: ref.current.node.id, episodeNumber: ref.current.current.current.data.episodeNumber!, operationId: own.operationId }] : []);
            const result: BatchRow[] = [];
            for (const item of items) {
                if (!valid() || controller.signal.aborted) return;
                const node = ref.current.nodes.find((entry) => entry.id === item.nodeId);
                if (!node) { result.push({ ...item, status: "deleted" }); continue; }
                try {
                    let value = await read(node);
                    if (value.job?.operationId !== item.operationId) { result.push({ ...item, status: value.job || value.content.trim() ? "replaced" : batch?.stopped ? "cancelled" : "pending" }); continue; }
                    if (node.id !== ref.current.node.id && storyJobActive(value.job) && value.job.status !== "pending") {
                        let id = value.job.taskId;
                        if (!id) id = (await listGenerationTasks(100, { projectId: ref.current.canvasId }, undefined, controller.signal)).find((task) => storyTaskMatches(task, item.operationId))?.id;
                        if (id) {
                            const task = await queryGenerationTask(id, { signal: controller.signal });
                            if (!valid() || controller.signal.aborted) return;
                            const latest = await read(node);
                            if (latest.job?.operationId === item.operationId) {
                                const next = receiveStoryTask(latest, task);
                                value = next === latest ? latest : await write(node.id, next);
                            }
                        }
                    }
                    if (!valid() || controller.signal.aborted) return;
                    if (!working.current) value = await saveResult(ref.current.nodes.find((entry) => entry.id === node.id) || node, value);
                    result.push({ ...item, status: value.job!.status === "succeeded" && !value.job!.appliedToCanvas ? "ready" : value.job!.status, error: value.job?.error });
                } catch (failure) { result.push({ ...item, status: "conflict", error: failure instanceof Error ? failure.message : "状态暂不可用" }); }
            }
            if (valid() && !controller.signal.aborted) { setRows(result); timer = setTimeout(() => void poll(), 2500); }
        };
        void poll();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [options.ready, options.session.episodeBatch?.id, options.session.job?.batchOwnerNodeId]);

    const stop = async () => {
        if (working.current) return;
        const batch = ref.current.current.current.episodeBatch;
        if (!batch) return;
        working.current = true; setSubmitting(true); setError("");
        try {
            await ref.current.update({ episodeBatch: { ...batch, stopped: true } });
            for (const item of batch.items) {
                const node = ref.current.nodes.find((entry) => entry.id === item.nodeId);
                if (!node) continue;
                const value = await read(node);
                if (value.job?.operationId !== item.operationId || !storyJobActive(value.job)) continue;
                if (value.job.taskId) {
                    const task = await cancelGenerationTask(value.job.taskId);
                    const latest = await read(node);
                    if (latest.job?.operationId === item.operationId) await write(node.id, receiveStoryTask(latest, task));
                }
                else if (value.job.status === "pending") await write(node.id, { ...value, job: { ...value.job, status: "cancelled" } });
                else setError("存在提交结果待确认的任务，请在任务中心核对后停止");
            }
        } catch (failure) { setError(failure instanceof Error ? failure.message : "停止批次失败"); }
        finally { working.current = false; if (alive.current) setSubmitting(false); }
    };
    return { rows: rows.map((row) => ({ ...row, label: labels[row.status] || row.status })), submitting, error, run, stop };
}
