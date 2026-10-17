import { useEffect, useRef, useState } from "react";
import { getAgentRun } from "@/services/api/agent";
import { queryTaskExecutionDetails } from "@/services/api/task-center";
import { withRuntimeConcurrency } from "@/services/runtime-limits";
import { useUserStore } from "@/stores/use-user-store";
import { mergeProductionEvents } from "@/lib/canvas/production-agent-journal";
import type { GroupSessionTarget, GroupSessionSnapshot } from "@/lib/canvas/canvas-group-session";

export function useCanvasGroupSession(groupId: string, targets: GroupSessionTarget[]) {
    const userId = useUserStore(state => state.user?.id);
    const [snapshots, setSnapshots] = useState<Record<string, GroupSessionSnapshot>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [revision, setRevision] = useState(0);
    const [historyDepth, setHistoryDepth] = useState(100);
    const cache = useRef<Record<string, GroupSessionSnapshot>>({});
    const scope = `${userId || ""}:${groupId}`;
    const signature = JSON.stringify(targets);
    useEffect(() => { cache.current = {}; setSnapshots({}); setErrors({}); setHistoryDepth(100); }, [scope]);
    useEffect(() => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const current: GroupSessionTarget[] = JSON.parse(signature);
        let first = true;
        const poll = async () => {
            setLoading(true);
            await Promise.allSettled(current.map(async target => {
                const old = cache.current[target.key];
                const status = old?.kind === "task" ? old.detail.task.status : old?.run.status;
                if (!first && status && !["queued", "running", "waiting_approval"].includes(status)) return;
                try {
                    const snapshot = await withRuntimeConcurrency("resourceDownload", async (): Promise<GroupSessionSnapshot> => {
                        if (target.kind === "task") {
                            const detail = await queryTaskExecutionDetails(target.id, controller.signal);
                            if (detail.task.id !== target.id) throw new Error("任务记录与当前分组不匹配");
                            return { kind: "task", detail };
                        }
                        const { run } = await getAgentRun(target.id, controller.signal, { eventLimit: 100 });
                        if (run.id !== target.id || run.production?.targetNodeId !== target.nodeId) throw new Error("制作记录与当前节点不匹配");
                        let events = mergeProductionEvents(old?.kind === "agent" ? old.run.events || [] : [], (run.events || []).filter(event => event.runId === target.id));
                        // Fetch older records only when the user explicitly expands history.
                        while (events.length < historyDepth && events.length && events[0].seq > 1) {
                            const { run: older } = await getAgentRun(target.id, controller.signal, { beforeSeq: events[0].seq, eventLimit: 100 });
                            if (older.id !== target.id || older.production?.targetNodeId !== target.nodeId) throw new Error("历史记录与当前节点不匹配");
                            const merged = mergeProductionEvents(events, older.events || []);
                            if (merged.length === events.length) break;
                            events = merged;
                        }
                        return { kind: "agent", run: { ...run, events } };
                    }, controller.signal);
                    if (controller.signal.aborted) return;
                    cache.current[target.key] = snapshot;
                    setSnapshots(value => ({ ...value, [target.key]: snapshot }));
                    setErrors(value => { const next = { ...value }; delete next[target.key]; return next; });
                } catch (error) {
                    if (!controller.signal.aborted) setErrors(value => ({ ...value, [target.key]: error instanceof Error ? error.message : "执行记录读取失败" }));
                }
            }));
            if (controller.signal.aborted) return;
            first = false;
            setLoading(false);
            const pending = current.some(target => {
                const snapshot = cache.current[target.key];
                const status = snapshot?.kind === "task" ? snapshot.detail.task.status : snapshot?.run.status;
                return !status || ["queued", "running", "waiting_approval"].includes(status);
            });
            if (pending) timer = setTimeout(() => void poll(), 4000);
        };
        void poll();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [scope, signature, revision, historyDepth]);
    return { snapshots, errors, loading, refresh: () => setRevision(value => value + 1), loadEarlier: () => setHistoryDepth(value => value + 100) };
}
