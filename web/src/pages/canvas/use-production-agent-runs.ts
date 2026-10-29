import { createClientId } from "@/lib/client-id";
import { useEffect, useRef, useState } from "react";
import { getAgentRun, controlProductionAgent, cancelAgentRun, reconcileCanvasNodeTasks, type AgentRun, type ProductionAgentControlAction, type ProductionAssetModelSelection } from "@/services/api/agent";
import { prepareProductionAgent, submitProductionAgent } from "@/services/production-agent";
import { applyAgentCanvasPatches, refreshCanvasAfterAgent } from "@/services/user-data-sync";
import { createAgentCanvasSync } from "@/services/agent-canvas-sync";
import { getActiveUserScope } from "@/lib/user-scope";
import { workflowSignature, workflowSourceSignaturesMatch } from "@/lib/canvas/canvas-short-drama-workflow";
import { bindProductionAgentRun, productionAgentNodePresent, productionPlanCanvasNeedsRefresh } from "@/lib/canvas/production-agent-state";
import { productionRunExternalFailure } from "@/lib/canvas/production-agent-journal";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { AgentEvent } from "@/services/api/agent";

type ProductionAgentRunOptions = {
    config: AiConfig;
    setNodes: (update: CanvasNodeData[] | ((nodes: CanvasNodeData[]) => CanvasNodeData[])) => void;
    save: () => Promise<boolean>;
};

const terminalAgentStatuses = new Set<AgentRun["status"]>(["completed", "failed", "cancelled", "rejected", "waiting_user"]);

function completedPlanDocumentIds(events: AgentEvent[]) {
    const ids = new Set<string>();
    for (const event of events) {
        const patch = event.payload.canvasPatch;
        if (!patch || typeof patch !== "object" || !Array.isArray((patch as { nodes?: unknown }).nodes)) continue;
        for (const change of (patch as { nodes: Array<{ after?: CanvasNodeData | null }> }).nodes) {
            const node = change.after;
            const workflow = node?.metadata?.shortDrama;
            if (node?.metadata?.status === "success" && node.metadata.content?.trim() &&
                (workflow?.planSection || workflow?.planAsset || workflow?.assetIdentity || workflow?.bibleSection)) ids.add(node.id);
        }
    }
    return ids;
}

async function loadRunEventsForPlanRecovery(run: AgentRun, signal: AbortSignal) {
    const events = new Map((run.events || []).map((event) => [event.seq, event]));
    const expected = run.production?.workKind === "plan" ? run.production.documentTotal || 0 : 0;
    let truncated = run.eventsTruncated === true;
    while (truncated && expected > completedPlanDocumentIds([...events.values()]).size) {
        const firstSeq = Math.min(...events.keys());
        if (!Number.isFinite(firstSeq) || firstSeq <= 1) break;
        const page = (await getAgentRun(run.id, signal, { beforeSeq: firstSeq, eventLimit: 500 })).run;
        const earlier = page.events || [];
        if (!earlier.length || earlier[earlier.length - 1].seq >= firstSeq) break;
        for (const event of earlier) events.set(event.seq, event);
        truncated = page.eventsTruncated === true || (page.eventSeqBase || 0) > 0;
    }
    return [...events.values()].sort((left, right) => left.seq - right.seq);
}

function terminalAgentMessage(run: AgentRun) {
    if (run.failureMessage?.trim()) return run.failureMessage.trim();
    const terminalEvent = [...(run.events || [])].reverse().find((event) => ["run_failed", "error"].includes(event.type));
    const payload = terminalEvent?.payload || {};
    const detail = payload.failureMessage || payload.error || payload.text || payload.reason;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    return run.status === "rejected" ? "制作 Agent 请求被拒绝" : "制作 Agent 执行失败，请在详情中查看执行记录后重试";
}

/** Project a terminal Agent receipt onto its original workflow node. */
export function applyProductionAgentTerminalState(node: CanvasNodeData, run: AgentRun): CanvasNodeData {
    const data = node.metadata?.shortDrama;
    if (!data || data.productionAgent?.runId !== run.id) return node;
    if (!terminalAgentStatuses.has(run.status)) {
        return node.metadata?.generationWarning ? bindProductionAgentRun(node, run) : node;
    }
    const failedStatus = run.status === "failed" || run.status === "rejected";
    const externalFailure = failedStatus && productionRunExternalFailure(run.events, run.id);
    const cancelled = run.status === "cancelled";
    const assetExecutionStatus = externalFailure || cancelled ? run.status as "failed" | "rejected" | "cancelled" : undefined;
    const assetExecutionOnly = Boolean(assetExecutionStatus && data.step === "story.plan" && run.production?.workKind === "plan" && run.production.planReady === true && run.production.assetsStarted === true);
    const executionFailure = externalFailure || cancelled;
    const metadata = {
        ...node.metadata,
        status: assetExecutionOnly ? "success" as const : externalFailure ? "error" as const : cancelled || failedStatus || run.status === "waiting_user" ? "idle" as const : "success" as const,
        taskStage: assetExecutionOnly ? "制作方案已完成 · 资产执行未完成" : externalFailure ? "制作 Agent 已停止" : cancelled ? "制作 Agent 已取消" : failedStatus || run.status === "waiting_user" ? "制作 Agent 已暂停" : "制作 Agent 已完成",
        errorDetails: externalFailure && !assetExecutionOnly ? terminalAgentMessage(run) : undefined,
        generationWarning: undefined,
        shortDrama: {
            ...data,
            submission: executionFailure && !assetExecutionOnly ? "rejected" as const : "submitted" as const,
            ...(assetExecutionOnly && assetExecutionStatus ? { assetExecutionStatus, assetExecutionError: terminalAgentMessage(run) } : {}),
        },
    };
    return { ...node, metadata };
}

/**
 * A storyboard run is bound to an immutable episode body version. When that
 * body is edited while the Agent is running, the old run must stay immutable,
 * but the user should be able to retry the same node against the new version.
 */
export function rebaseStoryboardAgentNode(node: CanvasNodeData, nodes: CanvasNodeData[]): CanvasNodeData {
    const data = node.metadata?.shortDrama;
    if (!data || data.step !== "direction.shots" || !data.productionAgent?.runId) throw new Error("当前节点不是可重新绑定的分镜任务");
    const sourceSignatures = Object.fromEntries(Object.keys(data.sourceSignatures).map((sourceId) => {
        const source = nodes.find((candidate) => candidate.id === sourceId);
        if (!source) throw new Error("分镜来源节点已删除，请重新创建当前集分镜");
        return [sourceId, workflowSignature(source)];
    }));
    const nextData = {
        ...data,
        sourceSignatures,
        operationId: createClientId(),
        productionAgent: {},
        submission: "planned" as const,
    };
    return {
        ...node,
        metadata: {
            ...node.metadata,
            status: "idle",
            taskStage: "准备基于新版正文重试",
            errorDetails: undefined,
            generationWarning: undefined,
            taskId: undefined,
            taskClientOperationId: undefined,
            taskStatus: undefined,
            taskProgress: undefined,
            taskMediaStage: undefined,
            taskCanRecoverMedia: undefined,
            taskProvider: undefined,
            taskStartedAt: undefined,
            taskCompletedAt: undefined,
            taskDurationMs: undefined,
            taskErrorCode: undefined,
            taskOfficialStatus: undefined,
            taskReceiptRecorded: undefined,
            taskCreatedAt: undefined,
            taskUpdatedAt: undefined,
            shortDrama: nextData,
        },
    };
}

export function useProductionAgentRuns(canvasId: string, nodesRef: { current: CanvasNodeData[] }, submissionLock: { current: boolean }, options: ProductionAgentRunOptions) {
    const [runs, setRuns] = useState<AgentRun[]>([]);
    const [nodeErrors, setNodeErrors] = useState<Record<string, string>>({});
    const [readErrors, setReadErrors] = useState<Record<string, string>>({});
    const [syncError, setSyncError] = useState("");
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const locks = useRef(new Set<string>());
    const scope = getActiveUserScope();
    const generation = useRef(0);
    const refresh = useRef<() => void>(() => {});
    useEffect(() => {
        generation.current++;
        let closed = false;
        const checking = new Set<string>();
        const seen = new Map<string, number>();
        const controller = new AbortController();
        let reconciling = false;
        let reconciledAt = 0;
        const terminalized = new Map<string, string>();
        const planCanvasRefreshes = new Set<string>();
        setRuns([]); setNodeErrors({}); setReadErrors({}); setSyncError(""); setBusy({});
        const sync = createAgentCanvasSync({ canvasId, applyPatches: (patches) => applyAgentCanvasPatches(canvasId, patches), refresh: () => refreshCanvasAfterAgent(canvasId), onError: (cause) => { if (!closed) setSyncError(cause instanceof Error ? cause.message : "制作结果同步失败"); }, onSynced: () => { if (!closed) setSyncError(""); } });
        const present = (id?: string) => productionAgentNodePresent(nodesRef.current, id);
        const checkNode = async (node: CanvasNodeData, runId: string) => {
            if (checking.has(node.id)) return;
            checking.add(node.id);
            try {
                const { run } = await getAgentRun(runId, controller.signal, { sinceSeq: seen.get(runId), eventLimit: 500 });
                if (closed || !present(node.id) || nodesRef.current.find((entry) => entry.id === node.id)?.metadata?.shortDrama?.productionAgent?.runId !== runId) return;
                if (run.id !== runId || run.production?.targetNodeId !== node.id) throw new Error("任务回执与当前节点不匹配");
                const first = !seen.has(runId);
                const events = first ? await loadRunEventsForPlanRecovery(run, controller.signal) : run.events || [];
                for (const event of events) if (event.seq > (seen.get(runId) || 0)) sync.receive(event);
                seen.set(runId, Math.max(seen.get(runId) || 0, ...(run.events || []).map((event) => event.seq)));
                if (first) sync.reconcile();
                if (productionPlanCanvasNeedsRefresh(nodesRef.current, run)) {
                    const key = `${runId}:${run.production?.documentCount}`;
                    if (!planCanvasRefreshes.has(key)) {
                        planCanvasRefreshes.add(key);
                        sync.reconcile();
                    }
                }
                setRuns((current) => [...current.filter((entry) => entry.id !== runId && entry.production?.targetNodeId !== node.id), run]);
                setReadErrors((current) => current[node.id] ? { ...current, [node.id]: "" } : current);
                const receipt = `${run.status}:${run.updatedAt}`;
                if (!terminalAgentStatuses.has(run.status)) {
                    terminalized.delete(runId);
                    if (nodesRef.current.find(entry => entry.id === node.id)?.metadata?.generationWarning) {
                        options.setNodes(current => current.map(entry => entry.id === node.id ? applyProductionAgentTerminalState(entry, run) : entry));
                    }
                }
                if (terminalAgentStatuses.has(run.status)) {
                    const currentNode = nodesRef.current.find((entry) => entry.id === node.id);
                    const terminalNode = currentNode ? applyProductionAgentTerminalState(currentNode, run) : undefined;
                    if (currentNode && terminalNode && (terminalNode.metadata?.status !== currentNode.metadata?.status || terminalNode.metadata?.taskStage !== currentNode.metadata?.taskStage || terminalNode.metadata?.errorDetails !== currentNode.metadata?.errorDetails || JSON.stringify(terminalNode.metadata?.generationWarning) !== JSON.stringify(currentNode.metadata?.generationWarning) || terminalNode.metadata?.shortDrama?.submission !== currentNode.metadata?.shortDrama?.submission)) {
                        options.setNodes((current) => current.map((entry) => entry.id === node.id ? applyProductionAgentTerminalState(entry, run) : entry));
                    }
                    if (terminalized.get(runId) !== receipt) {
                        terminalized.set(runId, receipt);
                        sync.reconcile();
                    }
                }
            } catch (cause) {
                if (!closed) setReadErrors((current) => ({ ...current, [node.id]: cause instanceof Error ? cause.message : "制作任务状态暂不可用" }));
            } finally { checking.delete(node.id); }
        };
        const check = () => {
            if (closed) return;
            if (!reconciling && Date.now() - reconciledAt > 10_000) {
                reconciling = true;
                void reconcileCanvasNodeTasks(canvasId).then(() => { reconciledAt = Date.now(); })
                    .catch((cause) => { if (!closed) setSyncError(cause instanceof Error ? cause.message : "节点任务清理待重试"); })
                    .finally(() => { reconciling = false; });
            }
            setRuns((current) => current.filter((run) => present(run.production?.targetNodeId) && nodesRef.current.find((node) => node.id === run.production?.targetNodeId)?.metadata?.shortDrama?.productionAgent?.runId === run.id));
            for (const node of nodesRef.current) {
                const runId = node.metadata?.shortDrama?.productionAgent?.runId;
                if (runId && present(node.id)) void checkNode(node, runId);
            }
        };
        refresh.current = () => { planCanvasRefreshes.clear(); check(); };
        const timer = setInterval(check, 1800);
        check();
        return () => { closed = true; generation.current++; clearInterval(timer); controller.abort(); sync.dispose(); };
    }, [canvasId, scope, nodesRef]);

    const control = async (nodeId: string, action: ProductionAgentControlAction | "cancel", maxSteps?: number, assetKeys?: string[], planSections?: import("@/services/api/agent").ProductionPlanScope[], modelSelection?: ProductionAssetModelSelection, assetKinds?: string[]) => {
        if (locks.current.has(nodeId) || submissionLock.current) return;
        const epoch = generation.current;
        locks.current.add(nodeId);
        setBusy((current) => ({ ...current, [nodeId]: true }));
        setNodeErrors((current) => ({ ...current, [nodeId]: "" }));
        try {
            const node = nodesRef.current.find((entry) => entry.id === nodeId);
            const data = node?.metadata?.shortDrama;
            if (action === "resume" && data?.step === "assets.reconcile") throw new Error("旧正文资产校核已停用，请改用正文质量审核；已有内容和执行记录保留");
            const agent = data?.productionAgent;
            if (!node || !agent || !productionAgentNodePresent(nodesRef.current, nodeId)) throw new Error("任务节点或容器已不存在");
            if (agent.runId) {
                const run = runs.find((entry) => entry.id === agent.runId);
                const canRebaseStoryboard = action === "resume" && data.step === "direction.shots" &&
                    (run?.status === "failed" || node.metadata?.status === "error") &&
                    !workflowSourceSignaturesMatch(data, nodesRef.current);
                if (canRebaseStoryboard) {
                    await cancelAgentRun(agent.runId);
                    const rebased = rebaseStoryboardAgentNode(node, nodesRef.current);
                    options.setNodes((current) => current.map((entry) => entry.id === nodeId ? rebased : entry));
                    if (!await options.save()) throw new Error("分镜节点已重置，但新版正文尚未保存到云端，请保存成功后重试");
                    const current = nodesRef.current.find((entry) => entry.id === nodeId);
                    if (!current) throw new Error("分镜节点已被删除");
                    const request = await prepareProductionAgent(canvasId, current, options.config);
                    options.setNodes((currentNodes) => currentNodes.map((entry) => entry.id === nodeId ? {
                        ...entry,
                        metadata: {
                            ...entry.metadata,
                            status: "loading",
                            generationWarning: undefined,
                            taskStage: "正在基于新版正文提交分镜",
                            shortDrama: { ...entry.metadata!.shortDrama!, submission: "submitting", productionAgent: { request } },
                        },
                    } : entry));
                    if (!await options.save()) throw new Error("新版分镜任务参数未能保存，尚未重新提交");
                    const { run: nextRun } = await submitProductionAgent(request);
                    if (epoch === generation.current && !nodesRef.current.some((entry) => entry.id === nodeId)) { await cancelAgentRun(nextRun.id); return; }
                    if (epoch === generation.current) {
                        options.setNodes((current) => current.map((entry) => entry.id === nodeId ? bindProductionAgentRun(entry, nextRun, request) : entry));
                        setRuns((currentRuns) => [...currentRuns.filter((entry) => entry.id !== nextRun.id && entry.production?.targetNodeId !== nodeId), nextRun]);
                    }
                } else if (action === "cancel") await cancelAgentRun(agent.runId);
                else await controlProductionAgent(agent.runId, action, maxSteps, assetKeys, planSections, modelSelection, assetKinds);
            } else {
                if (action !== "resume" || !agent.request) throw new Error("任务尚未准备完成，请从制作步骤继续提交");
                if (!workflowSourceSignaturesMatch(data, nodesRef.current)) throw new Error("前置内容已变化，请基于新内容重新生成");
                // Replay only on an explicit command, with the original admission identity.
                const { run } = await submitProductionAgent(agent.request);
                if (epoch === generation.current && !nodesRef.current.some((entry) => entry.id === nodeId)) { await cancelAgentRun(run.id); return; }
                if (epoch === generation.current) {
                    options.setNodes((current) => current.map((entry) => entry.id === nodeId ? bindProductionAgentRun(entry, run, agent.request) : entry));
                    setRuns((current) => [...current.filter((entry) => entry.id !== run.id), run]);
                }
            }
            if (epoch !== generation.current) return;
            await refreshCanvasAfterAgent(canvasId);
            refresh.current();
            return { success: true };
        } catch (cause) {
            const error = cause instanceof Error ? cause.message : "任务操作失败";
            if (epoch === generation.current) {
                setNodeErrors((current) => ({ ...current, [nodeId]: error }));
                return { error };
            }
        } finally {
            locks.current.delete(nodeId);
            if (epoch === generation.current) setBusy((current) => ({ ...current, [nodeId]: false }));
        }
    };
    return { runs, nodeErrors, readErrors, syncError, busy, control, refresh: () => refresh.current() };
}
