import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Segmented, Tooltip } from "antd";
import { Pause, Play, Square, RefreshCw, ChevronRight, Check, CircleAlert, Wrench, SlidersHorizontal } from "lucide-react";
import { AIMessageMarkdown } from "@/components/ai/ai-message-markdown";
import { getAgentRun, type AgentEvent } from "@/services/api/agent";
import { mergeProductionEvents, productionJournalRows } from "@/lib/canvas/production-agent-journal";
import type { CanvasNodeData } from "@/types/canvas";
import type { useProductionAgentRuns } from "./use-production-agent-runs";

export function CanvasProductionAgentDetails({ node, state }: { node: CanvasNodeData; state: ReturnType<typeof useProductionAgentRuns> }) {
    const agent = node.metadata?.shortDrama?.productionAgent;
    const runId = agent?.runId;
    const run = state.runs.find((entry) => entry.id === runId && entry.production?.targetNodeId === node.id);
    const [events, setEvents] = useState<AgentEvent[]>([]);
    const [historyError, setHistoryError] = useState("");
    const [loading, setLoading] = useState(false);
    const [earliest, setEarliest] = useState(false);
    const [order, setOrder] = useState<"desc" | "asc">("desc");
    const historyRequest = useRef<AbortController | null>(null);
    useEffect(() => { state.refresh(); }, [node.id]);
    useEffect(() => {
        setEvents([]); setEarliest(false); setHistoryError(""); setLoading(false);
        if (!runId) return;
        const controller = new AbortController();
        historyRequest.current = controller;
        void getAgentRun(runId, controller.signal, { eventLimit: 100 }).then(({ run: snapshot }) => {
            if (!controller.signal.aborted && snapshot.id === runId && snapshot.production?.targetNodeId === node.id) setEvents((current) => mergeProductionEvents(current, (snapshot.events || []).filter((event) => event.runId === runId)));
        }).catch((cause) => { if (!controller.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : "历史记录读取失败"); });
        return () => { controller.abort(); historyRequest.current?.abort(); };
    }, [runId]);
    useEffect(() => { if (run?.events) setEvents((current) => mergeProductionEvents(current, run.events!.filter((event) => event.runId === runId))); }, [run?.events, runId]);
    const progress = run?.production;
    const active = run?.status === "running" || run?.status === "queued";
    const label = !run ? runId ? "正在核对后台状态" : "提交待确认"
        : progress?.paused ? progress.waitingForBoundary ? "等待当前模型响应后暂停" : "已暂停"
        : run.status === "failed" ? "待恢复"
        : run.status === "completed" ? "已完成 · 待人工验收"
        : active && progress?.waitingForSharedFacts ? "等待共享正文提取"
        : active ? "后台执行中" : "已停止";
    const error = state.nodeErrors[node.id] || run?.failureMessage || (!run ? node.metadata?.errorDetails : "");
    const rows = useMemo(() => {
        const records = productionJournalRows(events, runId);
        return order === "desc" ? records.reverse() : records;
    }, [events, runId, order]);
    const loadEarlier = async () => {
        if (!runId || loading) return;
        const controller = new AbortController();
        historyRequest.current?.abort(); historyRequest.current = controller;
        setLoading(true); setHistoryError("");
        try {
            const { run: older } = await getAgentRun(runId, controller.signal, { beforeSeq: events[0]?.seq || undefined, eventLimit: 100 });
            if (controller.signal.aborted) return;
            if (older.id !== runId || older.production?.targetNodeId !== node.id) throw new Error("记录与当前节点任务不匹配，请刷新后重试");
            const items = (older.events || []).filter((event) => event.runId === runId);
            setEvents((current) => mergeProductionEvents(current, items));
            setEarliest(items.length === 0 || items[0].seq <= 1);
        } catch (cause) { if (!controller.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : "历史记录读取失败"); }
        finally { if (!controller.signal.aborted) setLoading(false); }
    };
    const effort = agent?.request?.reasoningEffort;
    return <section className="canvas-node-inspector-section production-agent-details" aria-label="制作任务执行记录" data-canvas-no-zoom data-canvas-wheel-scroll>
        <div className="production-agent-overview">
            <div className="production-agent-heading"><strong>{node.title || "制作任务"}</strong><span className="production-agent-status" role="status">{label}</span></div>
            {run ? <div className="production-agent-note">已解析 {progress?.processedPages || 0}/{progress?.totalPages || 0} 集正文 · 已产出 {progress?.artifactCount || 0} 项</div> : <div>{runId ? "正在读取该节点的任务记录" : "尚未取得后台任务回执，可继续提交并核对原任务。"}</div>}
        </div>
        {error && <div className="production-agent-error" role="alert">{error}</div>}
        {state.readErrors[node.id] && <div role="alert">状态核对失败：{state.readErrors[node.id]}</div>}
        {state.syncError && <div role="alert">{state.syncError}</div>}
        <div className="production-agent-actions">
            {(active || run?.status === "failed" || (!runId && agent?.request)) && <Button type="primary" loading={!!state.busy[node.id]} icon={active && !progress?.paused ? <Pause size={14} /> : <Play size={14} />} onClick={() => void state.control(node.id, active && !progress?.paused ? "pause" : "resume")}>{active && !progress?.paused ? "暂停任务" : !runId ? "继续提交" : "继续任务"}</Button>}
            {active && <Button disabled={!!state.busy[node.id]} icon={<Square size={14} />} onClick={() => void state.control(node.id, "cancel")}>取消任务</Button>}
            <Tooltip title="刷新任务状态"><Button aria-label="刷新任务状态" icon={<RefreshCw size={14} />} onClick={state.refresh} /></Tooltip>
        </div>
        <details className="production-agent-parameters">
            <summary><SlidersHorizontal size={14} /><span>运行参数</span><ChevronRight size={14} className="production-agent-chevron" /></summary>
            <dl>
                <div><dt>模型</dt><dd>{run?.model || agent?.request?.model || "未记录"}</dd></div>
                <div><dt>推理强度</dt><dd>{effort ? ({ low: "低", medium: "中", high: "高" })[effort] : "未记录"}</dd></div>
                <div className="production-agent-prompt"><dt>提示词</dt><dd>{agent?.request?.prompt || node.metadata?.prompt || "未记录"}</dd></div>
            </dl>
        </details>
        <div className="production-agent-journal-heading"><strong>执行记录</strong><Segmented aria-label="执行记录排序" size="small" value={order} onChange={(value) => setOrder(value as "desc" | "asc")} options={[{ label: "最新在前", value: "desc" }, { label: "最早在前", value: "asc" }]} /></div>
        {runId && !earliest && (events[0]?.seq || 0) > 1 && <Button className="production-agent-history" size="small" type="text" loading={loading} onClick={() => void loadEarlier()}>加载更早记录</Button>}
        {historyError && <div role="alert">{historyError}<Button loading={loading} onClick={() => void loadEarlier()}>重试读取记录</Button></div>}
        <div className="production-agent-journal" aria-label="逐次执行记录">
            {rows.length === 0 ? <p className="production-agent-note">{runId ? "暂无关键进展记录" : "尚未调度模型"}</p> : rows.map((row) => row.kind === "message" ? <div className="production-agent-commentary" key={`${runId}:${row.id}`} data-event-seq={row.id}>
                <AIMessageMarkdown components={{ pre: ({ children }) => <pre>{children}</pre>, table: ({ children }) => <table>{children}</table>, img: ({ alt }) => <span>{alt}</span> }}>{row.detail}</AIMessageMarkdown>
            </div> : row.detail === row.title || !row.detail ? <div className="production-agent-event" key={`${runId}:${row.id}`} data-event-seq={row.id}>
                <div className="production-agent-event-line"><Check size={14} /><span>{row.title}</span><time dateTime={row.time}>{new Date(row.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
            </div> : <details className={`production-agent-event${row.failed ? " production-agent-error" : ""}`} key={`${runId}:${row.id}`} data-event-seq={row.id}>
                <summary>{row.failed ? <CircleAlert size={14} /> : row.kind === "tool" ? <Wrench size={14} /> : <Check size={14} />}<span>{row.title}</span><time dateTime={row.time} title={new Date(row.time).toLocaleString()}>{new Date(row.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><ChevronRight size={14} className="production-agent-chevron" /></summary>
                <div className="production-agent-event-detail">{row.detail || "本条记录没有附加说明"}</div>
            </details>)}
        </div>
    </section>;
}
