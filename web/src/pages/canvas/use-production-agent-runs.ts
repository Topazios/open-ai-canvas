import { createClientId } from "@/lib/client-id";
import { useEffect, useRef, useState } from "react";
import { getAgentRun, controlProductionAgent, cancelAgentRun, reconcileCanvasNodeTasks, type AgentRun } from "@/services/api/agent";
import { prepareProductionAgent, submitProductionAgent } from "@/services/production-agent";
import { applyAgentCanvasPatches, refreshCanvasAfterAgent } from "@/services/user-data-sync";
import { createAgentCanvasSync } from "@/services/agent-canvas-sync";
import { getActiveUserScope } from "@/lib/user-scope";
import { workflowSignature, workflowSourceSignaturesMatch } from "@/lib/canvas/canvas-short-drama-workflow";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

type ProductionAgentRunOptions = {
    config: AiConfig;
    setNodes: (update: CanvasNodeData[] | ((nodes: CanvasNodeData[]) => CanvasNodeData[])) => void;
    save: () => Promise<boolean>;
};

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
        setRuns([]); setNodeErrors({}); setReadErrors({}); setSyncError(""); setBusy({});
        const sync = createAgentCanvasSync({ canvasId, applyPatches: (patches) => applyAgentCanvasPatches(canvasId, patches), refresh: () => refreshCanvasAfterAgent(canvasId), onError: (cause) => { if (!closed) setSyncError(cause instanceof Error ? cause.message : "制作结果同步失败"); } });
        const present = (id?: string) => nodesRef.current.some((node) => node.id === id && node.parentId && nodesRef.current.some((parent) => parent.id === node.parentId));
        const checkNode = async (node: CanvasNodeData, runId: string) => {
            if (checking.has(node.id)) return;
            checking.add(node.id);
            try {
                const { run } = await getAgentRun(runId, controller.signal, { sinceSeq: seen.get(runId), eventLimit: 100 });
                if (closed || !present(node.id) || nodesRef.current.find((entry) => entry.id === node.id)?.metadata?.shortDrama?.productionAgent?.runId !== runId) return;
                if (run.id !== runId || run.production?.targetNodeId !== node.id) throw new Error("任务回执与当前节点不匹配");
                const first = !seen.has(runId);
                for (const event of run.events || []) if (event.seq > (seen.get(runId) || 0)) sync.receive(event);
                seen.set(runId, Math.max(seen.get(runId) || 0, ...(run.events || []).map((event) => event.seq)));
                if (first) sync.reconcile();
                setRuns((current) => [...current.filter((entry) => entry.id !== runId && entry.production?.targetNodeId !== node.id), run]);
                setReadErrors((current) => current[node.id] ? { ...current, [node.id]: "" } : current);
            } catch (cause) {
                if (!closed) setReadErrors((current) => ({ ...current, [node.id]: cause instanceof Error ? cause.message : "制作任务状态暂不可用" }));
            } finally { checking.delete(node.id); }
        };
        const check = () => {
            if (closed) return;
            if (!reconciling && Date.now() - reconciledAt > 10_000) {
                reconciling = true;
                void reconcileCanvasNodeTasks(canvasId).then(() => { reconciledAt = Date.now(); if (!closed) setSyncError(""); })
                    .catch((cause) => { if (!closed) setSyncError(cause instanceof Error ? cause.message : "节点任务清理待重试"); })
                    .finally(() => { reconciling = false; });
            }
            setRuns((current) => current.filter((run) => present(run.production?.targetNodeId) && nodesRef.current.find((node) => node.id === run.production?.targetNodeId)?.metadata?.shortDrama?.productionAgent?.runId === run.id));
            for (const node of nodesRef.current) {
                const runId = node.metadata?.shortDrama?.productionAgent?.runId;
                if (runId && present(node.id)) void checkNode(node, runId);
            }
        };
        refresh.current = check;
        const timer = setInterval(check, 1800);
        check();
        return () => { closed = true; generation.current++; clearInterval(timer); controller.abort(); sync.dispose(); };
    }, [canvasId, scope, nodesRef]);

    const control = async (nodeId: string, action: "pause" | "resume" | "cancel", maxSteps?: number) => {
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
            if (!node || !agent || !node.parentId || !nodesRef.current.some((entry) => entry.id === node.parentId)) throw new Error("任务节点或容器已不存在");
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
                            taskStage: "正在基于新版正文提交分镜",
                            shortDrama: { ...entry.metadata!.shortDrama!, submission: "submitting", productionAgent: { request } },
                        },
                    } : entry));
                    if (!await options.save()) throw new Error("新版分镜任务参数未能保存，尚未重新提交");
                    const { run: nextRun } = await submitProductionAgent(request);
                    if (epoch === generation.current && !nodesRef.current.some((entry) => entry.id === nodeId)) { await cancelAgentRun(nextRun.id); return; }
                    if (epoch === generation.current) setRuns((currentRuns) => [...currentRuns.filter((entry) => entry.id !== nextRun.id && entry.production?.targetNodeId !== nodeId), nextRun]);
                } else if (action === "cancel") await cancelAgentRun(agent.runId);
                else await controlProductionAgent(agent.runId, action, maxSteps);
            } else {
                if (action !== "resume" || !agent.request) throw new Error("任务尚未准备完成，请从制作步骤继续提交");
                if (!workflowSourceSignaturesMatch(data, nodesRef.current)) throw new Error("前置内容已变化，请基于新内容重新生成");
                // Replay only on an explicit command, with the original admission identity.
                const { run } = await submitProductionAgent(agent.request);
                if (epoch === generation.current && !nodesRef.current.some((entry) => entry.id === nodeId)) { await cancelAgentRun(run.id); return; }
                if (epoch === generation.current) setRuns((current) => [...current.filter((entry) => entry.id !== run.id), run]);
            }
            if (epoch !== generation.current) return;
            await refreshCanvasAfterAgent(canvasId);
            refresh.current();
        } catch (cause) {
            if (epoch === generation.current) setNodeErrors((current) => ({ ...current, [nodeId]: cause instanceof Error ? cause.message : "任务操作失败" }));
        } finally {
            locks.current.delete(nodeId);
            if (epoch === generation.current) setBusy((current) => ({ ...current, [nodeId]: false }));
        }
    };
    return { runs, nodeErrors, readErrors, syncError, busy, control, refresh: () => refresh.current() };
}
