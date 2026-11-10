import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Tooltip } from "antd";
import { Pause, Play, Square, RefreshCw } from "lucide-react";
import { CanvasExecutionJournal } from "./canvas-execution-journal";
import { CanvasRunParameters } from "./canvas-run-parameters";
import { CanvasProductionFlowProgress } from "./canvas-production-flow-progress";
import { getAgentRun, getProductionUnitDetail, controlProductionAgent, type AgentEvent } from "@/services/api/agent";
import { mergeProductionEvents, productionJournalRows, productionParallelSummary, productionRunExternalFailure } from "@/lib/canvas/production-agent-journal";
import { productionPlanPhaseLabels } from "@/lib/production-plan";
import { canCancelProductionAgent, canRetryStoryboardCoordinator, productionParallelWarningText, productionPlanNeedsContinuation } from "@/lib/canvas/production-agent-state";
import type { CanvasNodeData } from "@/types/canvas";
import type { useProductionAgentRuns } from "./use-production-agent-runs";
import { productionFlowDisplay } from "@/lib/canvas/production-flow-display";

export function CanvasProductionAgentDetails({ node, state }: { node: CanvasNodeData; state: ReturnType<typeof useProductionAgentRuns> }) {
    const { modal, message } = App.useApp();
    const [reconciling, setReconciling] = useState(false);
    const [unitsOpen, setUnitsOpen] = useState(false);
    const [unitLimit, setUnitLimit] = useState(30);
    const reconcile = () => modal.confirm({
        title: "重新核对资产总表？",
        content: "保留总纲和已有初次提取，重新检查声音遗漏与重复资产。会调用模型并产生费用；完成前保留原表，完成后采用新清单。",
        okText: "开始核对", cancelText: "取消",
        onOk: async () => {
            if (!runId || reconciling) return;
            setReconciling(true);
            try { await controlProductionAgent(runId, "retry_item", undefined, undefined, ["inventory-reconcile"]); state.refresh(); }
            catch (cause) { message.error(cause instanceof Error ? cause.message : "总表核对启动失败"); throw cause; }
            finally { setReconciling(false); }
        },
    });
    const agent = node.metadata?.shortDrama?.productionAgent;
    const runId = agent?.runId;
    const run = state.runs.find((entry) => entry.id === runId && entry.production?.targetNodeId === node.id);
    const [events, setEvents] = useState<AgentEvent[]>([]);
    const [historyError, setHistoryError] = useState("");
    const [loading, setLoading] = useState(false);
    const [earliest, setEarliest] = useState(false);
    const [order, setOrder] = useState<"desc" | "asc">("desc");
    const historyRequest = useRef<AbortController | null>(null);
    useEffect(() => {
        state.refresh();
    }, [node.id]);
    useEffect(() => {
        setEvents([]);
        setEarliest(false);
        setHistoryError("");
        setLoading(false);
        if (!runId) return;
        const controller = new AbortController();
        historyRequest.current = controller;
        void getAgentRun(runId, controller.signal, { eventLimit: 100 })
            .then(({ run: snapshot }) => {
                if (!controller.signal.aborted && snapshot.id === runId && snapshot.production?.targetNodeId === node.id)
                    setEvents((current) =>
                        mergeProductionEvents(
                            current,
                            (snapshot.events || []).filter((event) => event.runId === runId),
                        ),
                    );
            })
            .catch((cause) => {
                if (!controller.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : "历史记录读取失败");
            });
        return () => {
            controller.abort();
            historyRequest.current?.abort();
        };
    }, [runId]);
    useEffect(() => {
        if (run?.events)
            setEvents((current) =>
                mergeProductionEvents(
                    current,
                    run.events!.filter((event) => event.runId === runId),
                ),
            );
    }, [run?.events, runId]);
    const progress = run?.production;
    const assetGeneration = Boolean(node.metadata?.shortDrama?.assetGroup || node.metadata?.shortDrama?.mediaGroup);
    const externalFailure = Boolean(run && ["failed", "rejected"].includes(run.status) && productionRunExternalFailure(mergeProductionEvents(events, run.events || []), run.id));
    const terminal = run && (externalFailure || run.status === "cancelled" || (["failed", "rejected"].includes(run.status) && progress?.workKind === "plan" && progress.assetsStarted));
    const assetExecutionIncomplete = Boolean(terminal && progress && progress.workKind === "plan" && progress.assetsStarted);
    const planPhaseLabel = progress?.phaseLabel?.trim() || (progress?.phase && productionPlanPhaseLabels[progress.phase]) || "制作方案";
    const planCurrentItem = progress?.currentItem?.trim();
    const parallelWarnings = progress?.parallelItems?.filter((item) => item.severity === "warning" || item.status === "warning") || [];
    const planCount = progress?.documentTotal
        ? `方案文档 ${progress.documentCount || 0}/${progress.documentTotal} · ${progress.inventoryComplete ? `资产 ${progress.assetCount || 0}/${progress.assetTotal || 0}` : `已登记 ${progress.assetTotal || 0} 项资产 · 来源核对 ${progress.inventoryReviewedSections || 0}/${progress.inventorySourceSections || 0}`}`
        : `已保存 ${progress?.processedPages || 0}${progress?.inventoryComplete && progress.totalPages > 0 ? `/${progress.totalPages}` : ""} 份`;
    const active = run?.status === "running" || run?.status === "queued";
    const retryMain = canRetryStoryboardCoordinator(run);
    // A paused production run can be persisted as waiting_user/failed while
    // the production progress still carries the resumable checkpoint. Keep
    // the resume control visible so a run does not become a silent dead end.
    const planNeedsContinuation = productionPlanNeedsContinuation(run);
    const resumable = Boolean(run && (["failed", "rejected", "waiting_user"].includes(run.status) || (active && progress?.paused) || planNeedsContinuation));
    const label = !run
        ? runId
            ? "正在核对后台状态"
            : "提交待确认"
        : progress?.paused
          ? progress.waitingForBoundary
              ? "等待当前模型响应后暂停"
              : "已暂停"
          : run.status === "waiting_user"
            ? progress?.flow?.held
                ? "未完成单元待重试 · 已保存成果保留"
                : progress?.plansStarted
                ? "待处理警告 · 可重试本项"
                : "故事总纲已完成 · 等待启动其余制作方案"
            : assetExecutionIncomplete
              ? "方案已完成 · 资产执行未完成"
              : ["failed", "rejected"].includes(run.status) && !externalFailure
                ? "待恢复"
                : externalFailure
                  ? progress?.workKind === "plan" && progress.assetsStarted
                      ? "方案已完成 · 资产执行未完成"
                      : "待恢复"
                  : run.status === "completed" && planNeedsContinuation
                    ? "方案文档未完成 · 可继续"
                    : run.status === "completed"
                    ? progress?.workKind === "plan"
                        ? progress.assetsStarted
                            ? "所选资产已完成 · 可继续选择"
                            : "方案已完成 · 资产待生成"
                        : "已完成 · 可抽查"
                    : active && progress?.waitingForSharedFacts
                      ? progress.workKind === "storyboard"
                          ? "等待共享制作约束"
                          : "等待共享正文提取"
                      : active
                        ? "后台执行中"
                        : "已停止";
    const error =
        state.nodeErrors[node.id] ||
        (retryMain && !active ? run?.failureMessage : "") ||
        (externalFailure ? (progress?.assetsStarted && progress.workKind === "plan" ? node.metadata?.shortDrama?.assetExecutionError || run?.failureMessage : run?.failureMessage) : "") ||
        (!run ? node.metadata?.errorDetails : "");
    const rows = useMemo(() => {
        const records = productionJournalRows(events, runId, { hideAssistantMessages: true });
        return order === "desc" ? records.reverse() : records;
    }, [events, runId, order]);
    const loadEarlier = async () => {
        if (!runId || loading) return;
        const controller = new AbortController();
        historyRequest.current?.abort();
        historyRequest.current = controller;
        setLoading(true);
        setHistoryError("");
        try {
            const { run: older } = await getAgentRun(runId, controller.signal, { beforeSeq: events[0]?.seq || undefined, eventLimit: 100 });
            if (controller.signal.aborted) return;
            if (older.id !== runId || older.production?.targetNodeId !== node.id) throw new Error("记录与当前节点任务不匹配，请刷新后重试");
            const items = (older.events || []).filter((event) => event.runId === runId);
            setEvents((current) => mergeProductionEvents(current, items));
            setEarliest(items.length === 0 || items[0].seq <= 1);
        } catch (cause) {
            if (!controller.signal.aborted) setHistoryError(cause instanceof Error ? cause.message : "历史记录读取失败");
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    };
    const effort = agent?.request?.reasoningEffort;
    return (
        <section className="canvas-node-inspector-section production-agent-details" aria-label="制作任务执行记录" data-canvas-no-zoom data-canvas-wheel-scroll>
            <div className="production-agent-overview">
                <div className="production-agent-heading">
                    <strong>{node.title || "制作任务"}</strong>
                    <span className="production-agent-status" role="status">
                        {progress?.flow ? productionFlowDisplay(progress.flow, run).label : label}
                    </span>
                </div>
                {run ? (
                    <div className="production-agent-note">
                        {progress?.workKind === "plan"
                            ? `${planCount} · ${planPhaseLabel}${!progress.concurrentItems?.length && planCurrentItem && planCurrentItem !== planPhaseLabel ? ` · ${planCurrentItem}` : ""}`
                            : progress?.workKind === "storyboard"
                              ? `已完成 ${progress.processedPages}/${progress.totalPages} 场 · 详情 ${progress.artifactCount}/${progress.shotTotal ?? progress.artifactCount} 镜头`
                              : `已解析 ${progress?.processedPages || 0}/${progress?.totalPages || 0} 集正文 · 已产出 ${progress?.artifactCount || 0} 项`}
                    </div>
                ) : (
                    <div>{runId ? "正在读取该节点的任务记录" : "尚未取得后台任务回执，可继续提交并核对原任务。"}</div>
                )}
                {progress?.flow && <div className="production-agent-note" role="status">{productionFlowDisplay(progress.flow, run).detail}</div>}
                {active && !progress?.flow && (progress?.executionMode === "episode" || !!progress?.concurrentItems?.length) && (
                    <div className="production-agent-note" role="status">
                        {productionParallelSummary(progress) || `${progress.paused ? "收尾中" : "并行制作"} ${progress.concurrentItems!.length}/${progress.concurrencyLimit ?? "--"} · ${progress.concurrentItems!.join("、")}`}
                    </div>
                )}
                {assetExecutionIncomplete && progress && (
                    <div className="production-agent-note" role="status">
                        资产执行已停止，方案文稿仍然完成；已保存 {progress.assetCount || 0}/{progress.assetTotal || 0} 项。可在对应资产分组详情中重试，已保存内容不会重新生成。
                    </div>
                )}
                {parallelWarnings.length ? (
                    <div className="production-agent-error" role="alert">
                        {parallelWarnings.map((item) => <div key={item.key}>{productionParallelWarningText(item)}</div>)}
                    </div>
                ) : null}
            </div>
            {error && (
                <div className="production-agent-error" role="alert">
                    {state.nodeErrors[node.id] ? `任务操作未成功：${error}。请刷新核对任务状态。` : error}
                </div>
            )}
            {state.readErrors[node.id] && <div role="alert">状态刷新失败：{state.readErrors[node.id]}。上方为最后一次成功读取的状态，暂时无法确认最新进度。</div>}
            {state.syncError && <div role="status" className="production-agent-note">画布同步提醒：{state.syncError}。这不代表生成任务失败，执行状态以上方最近一次后台记录为准。</div>}
            <div className="production-agent-actions">
                {progress?.inventoryReconcileAvailable && (!active || progress.paused) && <Button icon={<RefreshCw size={14} />} loading={reconciling} onClick={reconcile}>重新核对总表</Button>}
                {retryMain && (
                    <Button type={active && !progress?.paused ? "default" : "primary"} loading={!!state.busy[node.id]} icon={<RefreshCw size={14} />} onClick={() => void state.control(node.id, "retry_main")}>
                        重试主任务
                    </Button>
                )}
                {((active || resumable || externalFailure || (!runId && agent?.request)) && (!retryMain || (active && !progress?.paused))) && (
                    <Button type="primary" loading={!!state.busy[node.id]} icon={active && !progress?.paused ? <Pause size={14} /> : <Play size={14} />} onClick={() => void state.control(node.id, active && !progress?.paused ? "pause" : "resume")}>
                        {active && !progress?.paused
                            ? assetGeneration
                                ? "暂停生成"
                                : "暂停任务"
                            : !runId
                              ? assetGeneration
                                  ? "继续生成"
                                  : "继续提交"
                              : progress?.assetsStarted
                                ? `重试上次范围（${progress.selectedAssetKeys?.length || progress.assetTotal || 0}项）`
                                : assetGeneration
                                  ? "继续生成"
                                  : "继续任务"}
                    </Button>
                )}
                {canCancelProductionAgent(run) && (
                    <Button disabled={!!state.busy[node.id]} icon={<Square size={14} />} onClick={() => void state.control(node.id, "cancel")}>
                        取消任务
                    </Button>
                )}
                <Tooltip title="刷新任务状态">
                    <Button aria-label="刷新任务状态" icon={<RefreshCw size={14} />} onClick={state.refresh} />
                </Tooltip>
            </div>
            {progress?.flow && runId && (
                <section aria-label="制作工作单元">
                    <CanvasProductionFlowProgress flow={progress.flow} runId={runId} runStatus={run?.status} paused={progress.paused} onRefresh={state.refresh} />
                    <details onToggle={event => setUnitsOpen(event.currentTarget.open)}><summary>工作单元与原始回执</summary>
                    {unitsOpen && progress.flow.units.slice(0, unitLimit).map((unit) => (
                        <ProductionUnitRow key={unit.id} runId={runId} unit={unit} onRefresh={state.refresh} />
                    ))}
                    {unitsOpen && progress.flow.units.length > unitLimit && <Button size="small" onClick={() => setUnitLimit(value => value + 30)}>显示更多工作单元</Button>}
                    </details>
                </section>
            )}
            <CanvasRunParameters
                items={[
                    { label: "模型", value: run?.model || agent?.request?.model || "未记录" },
                    { label: "推理强度", value: effort ? { low: "低", medium: "中", high: "高" }[effort] : "未记录" },
                    { label: "运行 ID", value: runId },
                ]}
                prompt={agent?.request?.prompt || node.metadata?.prompt || ""}
            />
            <CanvasExecutionJournal rows={rows} order={order} onOrder={setOrder} empty={runId ? "暂无关键进展记录" : "尚未调度模型"}>
                {runId && !earliest && (events[0]?.seq || 0) > 1 && (
                    <Button className="production-agent-history" size="small" type="text" loading={loading} onClick={() => void loadEarlier()}>
                        加载更早记录
                    </Button>
                )}
                {historyError && (
                    <div role="alert">
                        {historyError}
                        <Button loading={loading} onClick={() => void loadEarlier()}>
                            重试读取记录
                        </Button>
                    </div>
                )}
            </CanvasExecutionJournal>
        </section>
    );
}

function ProductionUnitRow({ runId, unit, onRefresh }: {
    runId: string;
    unit: NonNullable<NonNullable<import("@/services/api/agent").AgentRun["production"]>["flow"]>["units"][number];
    onRefresh: () => void;
}) {
    const [detail, setDetail] = useState<Awaited<ReturnType<typeof getProductionUnitDetail>>>();
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const labels: Record<string, string> = { pending: "待执行", running: "执行中", accepted: "已通过", repair: "局部修复中", held: "待重试", split: "已拆分补充" };
    const request = useRef<AbortController | null>(null);
    const row = useRef<HTMLDetailsElement | null>(null);
    useEffect(() => {
        request.current?.abort();
        setDetail(undefined); setError(""); setBusy(false);
        if (row.current?.open) void readDetail();
        return () => request.current?.abort();
    }, [runId, unit.id, unit.generation, unit.status]);
    const readDetail = async () => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setBusy(true); setError("");
        try { const value = await getProductionUnitDetail(runId, unit.id, controller.signal); if (!controller.signal.aborted) setDetail(value); }
        catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取失败"); }
        finally { if (!controller.signal.aborted) setBusy(false); }
    };
    const retry = async () => {
        setBusy(true); setError("");
        try { await controlProductionAgent(runId, "retry_item", undefined, undefined, [unit.key]); onRefresh(); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "重试失败"); }
        finally { setBusy(false); }
    };
    return (
        <details ref={row} onToggle={(event) => { if (event.currentTarget.open && !detail && !busy) void readDetail(); }}>
            <summary>{unit.name} · {labels[unit.status] || unit.status} · 第 {unit.attempts} 次调用</summary>
            {unit.issues.map((issue, index) => <p key={issue.rule + index}>{issue.target}：{issue.message}<br />处理：{issue.action}</p>)}
            {unit.status === "held" && <Tooltip title="仅重试本项，保留已保存内容"><Button aria-label={"重试" + unit.name} icon={<RefreshCw size={14} />} loading={busy} onClick={() => void retry()} /></Tooltip>}
            {error && <p role="alert">{error} <Button icon={<RefreshCw size={14} />} loading={busy} onClick={() => void readDetail()}>重新读取</Button></p>}
            {detail && <>
                <p className="production-agent-note">来源版本：{detail.sourceVersion}</p>
                <details><summary>已保存内容</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(detail.adopted, null, 2)}</pre></details>
                <details><summary>来源与任务范围</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(detail.input, null, 2)}</pre></details>
                {detail.history.map((record) => <details key={record.taskId + record.generation}><summary>执行代次 {record.generation} · {record.taskId}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify({ issues: record.issues, received: record.received, adopted: record.adopted }, null, 2)}</pre></details>)}
            </>}
        </details>
    );
}
