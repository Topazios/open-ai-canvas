import { useEffect, useRef, useState } from "react";
import { getAgentRun, controlProductionAgent, cancelAgentRun, reconcileCanvasNodeTasks, type AgentRun } from "@/services/api/agent";
import { submitProductionAgent } from "@/services/production-agent";
import { applyAgentCanvasPatches, refreshCanvasAfterAgent } from "@/services/user-data-sync";
import { createAgentCanvasSync } from "@/services/agent-canvas-sync";
import { getActiveUserScope } from "@/lib/user-scope";
import { workflowSourceSignaturesMatch } from "@/lib/canvas/canvas-short-drama-workflow";
import type { CanvasNodeData } from "@/types/canvas";

export function useProductionAgentRuns(canvasId: string, nodesRef: { current: CanvasNodeData[] }, submissionLock: { current: boolean }) {
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
            const agent = data?.productionAgent;
            if (!node || !agent || !node.parentId || !nodesRef.current.some((entry) => entry.id === node.parentId)) throw new Error("任务节点或容器已不存在");
            if (agent.runId) {
                if (action === "cancel") await cancelAgentRun(agent.runId);
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
