import { useMemo, useState } from "react";
import { Button, Segmented } from "antd";
import { ChevronRight, Pause, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { productionPlanAssetAction, productionPlanMissingDocumentNote, productionPlanNeedsContinuation } from "@/lib/canvas/production-agent-state";
import { groupExecutionRows, groupMemberState, groupSessionMembers, groupSessionTargets, groupSessionHasEarlier } from "@/lib/canvas/canvas-group-session";
import { nodeWorkflow, workflowContinuationRange, workflowEpisodeProgress } from "@/lib/canvas/canvas-short-drama-workflow";
import { ShortDramaStep } from "@/lib/short-drama-steps";
import { productionPlanPhaseLabels } from "@/lib/production-plan";
import { productionParallelSummary, productionRunExternalFailure } from "@/lib/canvas/production-agent-journal";
import { isPlanPlaceholder } from "@/lib/canvas/plan-placeholder";
import type { CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import { canCancelGenerationTask } from "@/lib/generation-task-display";
import type { useProductionAgentRuns } from "./use-production-agent-runs";
import { CanvasExecutionJournal } from "./canvas-execution-journal";
import { CanvasRunParameters } from "./canvas-run-parameters";
import { useCanvasGroupSession } from "./use-canvas-group-session";

const parallelStateLabels: Record<string, string> = {
    running: "执行中",
    queued: "排队中",
    retrying: "重试中",
    error: "执行失败",
    failed: "执行失败",
    succeeded: "已完成",
    cancelled: "已取消",
    warning: "内容待处理",
};
const assetKindLabels: Record<string, string> = { character: "人物", environment: "场景", prop: "道具", special: "特殊资产", sound: "声音" };

type ParallelDetail = { status?: string; attempts?: number; validationAttempts?: number; retryAt?: number; validationIssues?: string[] };

// 把后端进度里的尝试次数、本地校验失败原因和下次重试时间拼成一行可读说明。
function parallelDetailText(item?: ParallelDetail): string {
    if (!item) return "";
    const parts: string[] = [];
    if (item.attempts && item.attempts > 0) parts.push("第 " + item.attempts + " 次尝试");
    if (item.validationIssues?.length) parts.push("本地校验未通过：" + item.validationIssues.join("；"));
    if (item.retryAt && item.retryAt > Date.now()) parts.push(Math.max(1, Math.ceil((item.retryAt - Date.now()) / 1000)) + " 秒后重试");
    return parts.join(" · ");
}

export function CanvasGroupTaskDetails({
    node,
    nodes,
    submitting,
    onResume,
    onContinueGeneration,
    onRetry,
    onCancel,
    agentState,
    onNewVersionGeneration,
}: {
    node: CanvasNodeData;
    nodes: CanvasNodeData[];
    submitting: boolean;
    onResume: (id: string) => void;
    onRetry: (node: CanvasNodeData) => void;
    onCancel: (task: GenerationTask) => void;
    agentState: ReturnType<typeof useProductionAgentRuns>;
    onContinueGeneration?: (id: string) => void;
    onNewVersionGeneration?: (id: string) => void;
}) {
    const members = useMemo(() => groupSessionMembers(node, nodes), [node, nodes]);
    const visibleMembers = members.filter((member) => member.metadata?.shortDrama?.assetKey !== "$summary");
    const targets = useMemo(() => groupSessionTargets(members, node, nodes), [members, node, nodes]);
    const session = useCanvasGroupSession(node.id, targets);
    const [order, setOrder] = useState<"asc" | "desc">("desc");
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [visibleByKey, setVisibleByKey] = useState<Record<string, number>>({});
    const target = targets.find((item) => item.coordinator) || targets.find((item) => item.kind === "agent" && item.scoped);
    const controlled = nodes.find((member) => member.id === target?.nodeId);
    const snapshot = target ? session.snapshots[target.key] : undefined;
    const run = snapshot?.kind === "agent" ? snapshot.run : undefined;
    const externalFailure = Boolean(run && ["failed", "rejected"].includes(run.status) && productionRunExternalFailure(run.events, run.id));
    const planRun = agentState.runs.find((entry) => entry.production?.targetNodeId === node.metadata?.shortDrama?.assetGroup?.manifestId);
    // 快照还没读到时，用列表里同一容器的运行记录，保证并行明细先可见。
    const progress = run?.production || planRun?.production;
    const parallelItems = progress?.parallelItems;
    // 占位节点没有自己的任务记录，按资产或文档 key 对应容器并行明细里的状态。
    const parallelStatusOf = (member: CanvasNodeData) => {
        const key = member.metadata?.shortDrama?.assetKey;
        return key ? parallelItems?.find((item) => item.key === key)?.status : undefined;
    };
    const parallelItemOf = (member: CanvasNodeData) => {
        const key = member.metadata?.shortDrama?.assetKey;
        return key ? parallelItems?.find((item) => item.key === key) : undefined;
    };
    // 失败、带警告放弃的文档都给出重试入口；系统本身会自动重试，这里只是抽查时的便捷入口。
    const retryableItem = (item?: { status?: string; abandoned?: boolean }) => Boolean(item && (item.abandoned || ["error", "warning", "failed"].includes(item.status || "")));
    const retryItem = async (assetKey: string) => {
        if (!controlled) return;
        await agentState.control(controlled.id, "retry_item", undefined, undefined, [assetKey]);
        session.refresh();
    };
    const planAssetAction = productionPlanAssetAction(node, planRun);
    const activeRun = run || planRun;
    const active = activeRun && ["running", "queued"].includes(activeRun.status);
    const planNeedsContinuation = productionPlanNeedsContinuation(run);
    const resumable = Boolean(run && (["failed", "rejected", "waiting_user", "cancelled"].includes(run.status) || planNeedsContinuation));
    const parallelWarnings = progress?.parallelItems?.filter((item) => item.severity === "warning" || item.status === "warning") || [];
    const retired = node.metadata?.shortDrama?.step === "assets.reconcile";
    const workflow = nodeWorkflow(node);
    const assetGeneration = Boolean(workflow?.assetGroup || workflow?.mediaGroup);
    const assetGroupKind = workflow?.planGroup?.kind;
    const activityLabel = assetGeneration && progress?.assetsStarted
        ? `生成${assetKindLabels[assetGroupKind || ""] || "资产"}资产`
        : progress?.phaseLabel?.trim() || (progress?.phase && productionPlanPhaseLabels[progress.phase]) || "制作方案";
    const bodyProgress = workflow?.step === ShortDramaStep.Body && workflow?.role === "collection" ? workflowEpisodeProgress(nodes, workflow.pipelineId, undefined, node.id) : undefined;
    const continuation = bodyProgress ? workflowContinuationRange(bodyProgress) : undefined;
    const canContinueBody = Boolean(continuation && (bodyProgress!.missing > 0 || bodyProgress!.failed > 0 || bodyProgress!.pending > 0));
    const pending = members.filter((member) => member.metadata?.shortDrama?.submission === "planned");
    const counts = visibleMembers.reduce<Record<string, number>>((result, member) => {
        const key = targets.find((item) => item.nodeId === member.id)?.key;
        const state = groupMemberState(member, key ? session.snapshots[key] : undefined, snapshot, parallelStatusOf(member));
        result[state] = (result[state] || 0) + 1;
        return result;
    }, {});
    const rowMembers = useMemo(() => {
        const known = new Set(members.map((member) => member.id));
        return [...members, ...targets.map((item) => nodes.find((entry) => entry.id === item.nodeId)).filter((entry): entry is CanvasNodeData => !!entry && !known.has(entry.id))];
    }, [members, targets, nodes]);
    const items = useMemo(() => {
        type TaskItem = { key: string; target?: (typeof targets)[number]; member: CanvasNodeData };
        // 协调节点($summary)只用于容器级控制，不进入任务列表
        const result = targets.flatMap<TaskItem>((item) => {
            const member = rowMembers.find((entry) => entry.id === item.nodeId);
            return member && member.metadata?.shortDrama?.assetKey !== "$summary" ? [{ key: item.key, target: item, member }] : [];
        });
        const covered = new Set(result.map((item) => item.member.id));
        visibleMembers.forEach((member) => {
            if (!covered.has(member.id)) result.push({ key: "node:" + member.id, member });
        });
        return result;
    }, [targets, rowMembers, visibleMembers]);
    // 旧画布没有占位节点时，用并行明细生成只读任务行，保证执行中的任务可见。
    const fallbackRows = useMemo(() => {
        if (items.length) return [];
        return (parallelItems || []).map((item) => ({
            key: "parallel:" + item.key,
            itemKey: item.key,
            title: item.name || item.key,
            state: parallelStateLabels[item.status] || "排队中",
            detail: parallelDetailText(item),
            retryable: retryableItem(item),
        }));
    }, [items.length, parallelItems]);
    const displayCounts = items.length
        ? counts
        : fallbackRows.reduce<Record<string, number>>((result, row) => {
              result[row.state] = (result[row.state] || 0) + 1;
              return result;
          }, {});
    const truncated = targets.some((item) => {
        const value = session.snapshots[item.key];
        return value?.kind === "task" && value.detail.truncated;
    });
    return (
        <section className="canvas-node-inspector-section production-agent-details" aria-label="分组统一详情会话" data-canvas-no-zoom data-canvas-wheel-scroll>
            <div className="production-agent-overview">
                <div className="production-agent-heading">
                    <strong>{node.title}</strong>
                    <span className="production-agent-status">{items.length || fallbackRows.length} 个任务</span>
                </div>
                <div className="production-agent-note" role="status">
                    {Object.entries(displayCounts)
                        .map(([label, count]) => `${label} ${count}`)
                        .join(" · ")}
                </div>
                {run && snapshot ? (
                    <div className="production-agent-note" role="status">
                        {groupMemberState(controlled || node, snapshot)} ·{" "}
                        {progress?.workKind === "plan"
                            ? `${activityLabel} · 已保存 ${progress.documentCount ?? progress.processedPages ?? 0}${progress.documentTotal ? `/${progress.documentTotal}` : ""} 份文档 · ${progress.assetCount || 0} 项资产`
                            : progress?.workKind === "storyboard"
                              ? `已完成 ${progress.processedPages}/${progress.totalPages} 场 · 已保存 ${progress.artifactCount} 镜头`
                              : `已解析 ${progress?.processedPages || 0}/${progress?.totalPages || 0} 集正文 · 已产出 ${progress?.artifactCount || 0} 项`}
                        {progress?.waitingForSharedFacts ? " · 等待共享前置任务" : ""}
                    </div>
                ) : target?.kind === "agent" && session.loading ? (
                    <div className="production-agent-note" role="status">
                        正在核对后台任务状态
                    </div>
                ) : null}
                {active && (progress?.executionMode === "episode" || !!progress?.concurrentItems?.length) && (
                    <div className="production-agent-note" role="status">
                        {productionParallelSummary(progress) || `${progress.paused ? "收尾中" : "并行制作"} ${progress.concurrentItems!.length}/${progress.concurrencyLimit ?? "--"} · ${progress.concurrentItems!.join("、")}`}
                    </div>
                )}
                {parallelWarnings.length ? (
                    <div className="production-agent-error" role="alert">
                        {parallelWarnings.map((item) => item.name).join("、")} 未通过本地校验，系统已自动重试并先跳过，不影响其他文档；可在对应任务里点击“重试此项”再次生成。
                    </div>
                ) : null}
                {planNeedsContinuation ? (
                    <div className="production-agent-error" role="alert">
                        {productionPlanMissingDocumentNote(run)}
                    </div>
                ) : null}
                {externalFailure && progress?.assetsStarted && (
                    <div className="production-agent-note" role="status">
                        任务已停止，资产已保存 {progress.assetCount || 0}/{progress.assetTotal || 0} 项。可在对应资产分组详情中重试，已保存内容不会重新生成。
                    </div>
                )}
            </div>
            <div className="production-agent-actions">
                {pending.length > 0 && !retired ? (
                    <Button icon={<Play size={14} />} loading={submitting} disabled={submitting || !!active} onClick={() => onResume(node.id)}>
                        {active ? "后台生成中" : assetGeneration ? "继续生成" : "继续提交"}{active ? "" : `（${pending.length}）`}
                    </Button>
                ) : null}
                {canContinueBody && onContinueGeneration ? (
                    <Button icon={<Play size={14} />} loading={submitting} disabled={submitting} onClick={() => onContinueGeneration(node.id)}>
                        继续生成{continuation ? `（第 ${continuation.start} 集起，默认 ${continuation.count} 集）` : ""}
                    </Button>
                ) : null}
                {workflow?.step === ShortDramaStep.Body && workflow.role === "collection" && onNewVersionGeneration ? (
                    <Button icon={<RotateCcw size={14} />} loading={submitting} disabled={submitting} onClick={() => onNewVersionGeneration(node.id)}>
                        生成新版正文
                    </Button>
                ) : null}
                <Button aria-label="刷新分组记录" title="刷新分组记录" loading={session.loading} icon={<RefreshCw size={14} />} onClick={session.refresh} />
                {controlled && run && (active || externalFailure || resumable) && (!workflow?.planGroup || active || resumable) && (!retired || active || resumable) ? (
                    <Button
                        loading={agentState.busy[controlled.id]}
                        icon={active && !run.production?.paused ? <Pause size={14} /> : <Play size={14} />}
                        onClick={async () => {
                            await agentState.control(controlled.id, active && !run.production?.paused ? "pause" : "resume");
                            session.refresh();
                        }}
                    >
                        {active && !run.production?.paused
                            ? assetGeneration
                                ? "暂停生成"
                                : "暂停任务"
                            : run.status === "cancelled" ? "继续制作" : progress?.assetsStarted
                              ? `重试上次范围（${progress.selectedAssetKeys?.length || progress.assetTotal || 0}项）`
                              : assetGeneration
                                ? "继续生成"
                                : "继续任务"}
                    </Button>
                ) : null}
                {controlled && active ? (
                    <Button
                        disabled={agentState.busy[controlled.id]}
                        icon={<Square size={14} />}
                        onClick={async () => {
                            await agentState.control(controlled.id, "cancel");
                            session.refresh();
                        }}
                    >
                        取消任务
                    </Button>
                ) : null}
            </div>
            {controlled && agentState.nodeErrors[controlled.id] ? (
                <div role="alert" className="production-agent-error">
                    {agentState.nodeErrors[controlled.id]}
                </div>
            ) : null}
            {planAssetAction?.targetNodeId && controlled?.id !== planAssetAction.targetNodeId && agentState.nodeErrors[planAssetAction.targetNodeId] ? (
                <div role="alert" className="production-agent-error">
                    {agentState.nodeErrors[planAssetAction.targetNodeId]}
                </div>
            ) : null}
            {externalFailure && run?.failureMessage ? (
                <div role="alert" className="production-agent-error">
                    {run.failureMessage}
                </div>
            ) : null}
            {agentState.syncError ? (
                <div role="alert" className="production-agent-error">
                    {agentState.syncError}
                </div>
            ) : null}
            <div className="production-agent-journal-heading">
                <strong>任务</strong>
                {targets.length ? (
                    <Segmented
                        aria-label="执行记录排序"
                        size="small"
                        value={order}
                        onChange={(value) => setOrder(value as "desc" | "asc")}
                        options={[
                            { label: "最新在前", value: "desc" },
                            { label: "最早在前", value: "asc" },
                        ]}
                    />
                ) : null}
            </div>
            <div className="production-agent-tasks" aria-label="任务列表">
                {items.length === 0 && fallbackRows.length === 0 ? <p className="production-agent-note">{session.loading ? "正在读取任务" : "本组暂无任务"}</p> : null}
                {fallbackRows.map((row) => (
                    <div key={row.key} className="production-agent-task">
                        <div className="production-agent-task-summary">
                            <span className="production-agent-task-title">{row.title}</span>
                            <span className="production-agent-task-state">{row.state}</span>
                            {controlled && active && ["执行中", "排队中", "重试中"].includes(row.state) ? (
                                <Button size="small" title="取消此任务及本轮全部子任务" aria-label={`取消${row.title}及本轮全部子任务`} icon={<Square size={14} />} loading={agentState.busy[controlled.id]} disabled={agentState.busy[controlled.id]} onClick={() => void agentState.control(controlled.id, "cancel").then(session.refresh)}>
                                    取消
                                </Button>
                            ) : null}
                            {row.detail ? <span className="production-agent-note" role="status">{row.detail}</span> : null}
                            {row.retryable && controlled ? (
                                <Button size="small" icon={<RotateCcw size={14} />} disabled={agentState.busy[controlled.id]} onClick={() => void retryItem(row.itemKey)}>
                                    重试此项
                                </Button>
                            ) : null}
                        </div>
                    </div>
                ))}
                {items.map(({ key, target: itemTarget, member }) => {
                    const open = !!expanded[key];
                    const itemSnapshot = itemTarget ? session.snapshots[itemTarget.key] : undefined;
                    const itemTask = itemSnapshot?.kind === "task" ? itemSnapshot.detail.task : undefined;
                    const itemRun = itemSnapshot?.kind === "agent" ? itemSnapshot.run : undefined;
                    const itemActive = !!itemRun && ["running", "queued"].includes(itemRun.status);
                    const canRetryItem = !!itemTask && ["failed", "cancelled"].includes(itemTask.status);
                    const canCancelItem = !!itemTask && canCancelGenerationTask(itemTask);
                    const parallelItem = parallelItemOf(member);
                    const parallelActive = ["running", "queued", "retrying"].includes(parallelItem?.status || "");
                    const state = groupMemberState(member, itemSnapshot, snapshot, parallelStatusOf(member));
                    const cancelAgentNodeId = itemActive && itemTarget?.kind === "agent" ? itemTarget.nodeId : controlled?.id;
                    const canCancelAgentRun = Boolean(cancelAgentNodeId && state !== "已完成" && state !== "已取消" && (itemActive || (parallelActive && active)));
                    const itemError = (itemTarget && session.errors[itemTarget.key]) || (!itemSnapshot ? member.metadata?.errorDetails : undefined);
                    const limit = visibleByKey[key] || 100;
                    const placeholder = isPlanPlaceholder(member);
                    const placeholderKey = member.metadata?.shortDrama?.assetKey;
                    const canRetryPlaceholder = placeholder && !!controlled && !!placeholderKey && retryableItem(parallelItemOf(member));
                    // 方案文档（含占位和已保存的）没有自己的执行记录，统一展示容器的协调任务记录。
                    const planDocument = placeholder || !!member.metadata?.shortDrama?.planSection;
                    const journalTarget = itemTarget || (planDocument && target?.coordinator ? target : undefined);
                    const itemRows = open && journalTarget ? groupExecutionRows(rowMembers, session.snapshots, order, [journalTarget]) : [];
                    const earlier = !!journalTarget && groupSessionHasEarlier([journalTarget], session.snapshots);
                    return (
                        <details key={key} className="production-agent-task" open={open} onToggle={(event) => { const next = event.currentTarget.open; setExpanded((value) => (value[key] === next ? value : { ...value, [key]: next })); }}>
                            <summary>
                                <ChevronRight size={14} className="production-agent-chevron" aria-hidden />
                                <span className="production-agent-task-title">{member.title}</span>
                                <span className="production-agent-task-state">{state}</span>
                                {canCancelAgentRun ? (
                                    <Button size="small" title="取消此任务及本轮全部子任务" aria-label={`取消${member.title}及本轮全部子任务`} icon={<Square size={14} />} loading={agentState.busy[cancelAgentNodeId!]} disabled={agentState.busy[cancelAgentNodeId!]} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void agentState.control(cancelAgentNodeId!, "cancel").then(session.refresh); }}>
                                        取消
                                    </Button>
                                ) : canCancelItem ? (
                                    <Button size="small" title="取消此任务" aria-label={`取消${member.title}`} icon={<Square size={14} />} onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (itemTask) onCancel(itemTask); }}>
                                        取消
                                    </Button>
                                ) : null}
                            </summary>
                            {open ? (
                                <div className="production-agent-task-body">
                                    {itemError ? <div role="alert" className="production-agent-error">{itemError}</div> : null}
                                    {canRetryItem ? (
                                        <div className="production-agent-task-actions">
                                            {canRetryItem ? <Button size="small" icon={<RotateCcw size={14} />} onClick={() => onRetry(member)}>重试此任务</Button> : null}
                                        </div>
                                    ) : null}
                                    {canRetryPlaceholder && placeholderKey ? (
                                        <div className="production-agent-task-actions">
                                            <Button size="small" icon={<RotateCcw size={14} />} disabled={agentState.busy[controlled!.id]} onClick={() => void retryItem(placeholderKey)}>
                                                重试此项
                                            </Button>
                                        </div>
                                    ) : null}
                                    {member.metadata?.prompt?.trim() ? (
                                        <CanvasRunParameters
                                            items={[
                                                { label: "模型", value: member.metadata.model || "未记录" },
                                                { label: "推理强度", value: member.metadata.reasoningEffort || "medium" },
                                                { label: "任务 ID", value: member.metadata.taskId },
                                            ]}
                                            prompt={member.metadata.prompt}
                                        />
                                    ) : null}
                                    {placeholder && parallelDetailText(parallelItemOf(member)) ? (
                                        <p className="production-agent-note" role="status">{parallelDetailText(parallelItemOf(member))}</p>
                                    ) : null}
                                    {placeholder && state === "未启动" ? (
                                        <p className="production-agent-note">
                                            {member.metadata?.shortDrama?.planAsset?.name || member.title}尚未生成：系统已自动重试仍未成功，已先跳过，不影响其他文档；可点击“重试此项”再次生成。
                                        </p>
                                    ) : placeholder ? (
                                        <p className="production-agent-note">
                                            {run?.status === "cancelled" ? "已取消，可继续制作：" : "等待生成："}{member.metadata?.shortDrama?.planAsset?.name || member.title}{run?.status === "cancelled" ? "" : "，模型返回后将写入此文档。"}
                                        </p>
                                    ) : null}
                                    {journalTarget ? (
                                        <>
                                            <CanvasExecutionJournal
                                                compact
                                                label={member.title + " 执行记录"}
                                                rows={itemRows.slice(0, limit)}
                                                order={order}
                                                onOrder={setOrder}
                                                empty={session.loading ? "正在读取执行记录" : itemActive ? "后台任务执行中，等待首条可展示进展。" : "暂无执行记录"}
                                            />
                                            {itemRows.length > limit ? <Button size="small" onClick={() => setVisibleByKey((value) => ({ ...value, [key]: limit + 100 }))}>显示更多记录</Button> : null}
                                            {earlier ? (
                                                <Button size="small" loading={session.loading} onClick={() => { session.loadEarlier(); setVisibleByKey((value) => ({ ...value, [key]: limit + 100 })); }}>
                                                    读取更早记录
                                                </Button>
                                            ) : null}
                                        </>
                                    ) : (
                                        <p className="production-agent-note">{planDocument ? "该文档由制作方案协调任务生成，暂无可展示的执行记录。" : "尚未调用模型，暂无执行记录。"}</p>
                                    )}
                                </div>
                            ) : null}
                        </details>
                    );
                })}
            </div>
            {truncated ? <p className="production-agent-note">部分任务仅显示最近 200 条执行记录。</p> : null}
        </section>
    );
}
