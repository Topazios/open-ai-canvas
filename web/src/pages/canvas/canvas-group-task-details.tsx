import { useMemo, useState } from "react";
import { Button, Select } from "antd";
import { Pause, Play, RefreshCw, RotateCcw, Square } from "lucide-react";
import { productionPlanAssetAction, productionPlanNeedsContinuation } from "@/lib/canvas/production-agent-state";
import { groupExecutionRows, groupMemberState, groupSessionMembers, groupSessionTargets, groupSessionHasEarlier } from "@/lib/canvas/canvas-group-session";
import { nodeWorkflow, workflowContinuationRange, workflowEpisodeProgress } from "@/lib/canvas/canvas-short-drama-workflow";
import { ShortDramaStep } from "@/lib/short-drama-steps";
import { productionPlanPhaseLabels } from "@/lib/production-plan";
import { productionParallelSummary, productionRunExternalFailure } from "@/lib/canvas/production-agent-journal";
import type { CanvasNodeData } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import { canCancelGenerationTask } from "@/lib/generation-task-display";
import type { useProductionAgentRuns } from "./use-production-agent-runs";
import { CanvasExecutionJournal } from "./canvas-execution-journal";
import { useCanvasGroupSession } from "./use-canvas-group-session";

export function CanvasGroupTaskDetails({
    node,
    nodes,
    submitting,
    onResume,
    onContinueGeneration,
    onRetry,
    onCancel,
    agentState,
}: {
    node: CanvasNodeData;
    nodes: CanvasNodeData[];
    submitting: boolean;
    onResume: (id: string) => void;
    onRetry: (node: CanvasNodeData) => void;
    onCancel: (task: GenerationTask) => void;
    agentState: ReturnType<typeof useProductionAgentRuns>;
    onContinueGeneration?: (id: string) => void;
}) {
    const members = useMemo(() => groupSessionMembers(node, nodes), [node, nodes]);
    const visibleMembers = members.filter((member) => member.metadata?.shortDrama?.assetKey !== "$summary");
    const targets = useMemo(() => groupSessionTargets(members, node, nodes), [members, node, nodes]);
    const session = useCanvasGroupSession(node.id, targets);
    const [selected, setSelected] = useState("");
    const [order, setOrder] = useState<"asc" | "desc">("desc");
    const [visible, setVisible] = useState(100);
    const chosen = members.find((member) => member.id === selected);
    const target = targets.find((item) => item.nodeId === chosen?.id) || (!chosen ? targets.find((item) => item.coordinator) || targets.find((item) => item.kind === "agent" && item.scoped) : undefined);
    const controlled = chosen || nodes.find((member) => member.id === target?.nodeId);
    const snapshot = target ? session.snapshots[target.key] : undefined;
    const task = snapshot?.kind === "task" ? snapshot.detail.task : undefined;
    const run = snapshot?.kind === "agent" ? snapshot.run : undefined;
    const externalFailure = Boolean(run && ["failed", "rejected"].includes(run.status) && productionRunExternalFailure(run.events, run.id));
    const progress = run?.production;
    const planRun = agentState.runs.find((entry) => entry.production?.targetNodeId === node.metadata?.shortDrama?.assetGroup?.manifestId);
    const planAssetAction = productionPlanAssetAction(node, planRun);
    const active = run && ["running", "queued"].includes(run.status);
    const planNeedsContinuation = productionPlanNeedsContinuation(run);
    const resumable = Boolean(run && (["failed", "waiting_user"].includes(run.status) || planNeedsContinuation));
    const parallelWarnings = progress?.parallelItems?.filter((item) => item.severity === "warning" || item.status === "warning") || [];
    const retired = node.metadata?.shortDrama?.step === "assets.reconcile";
    const workflow = nodeWorkflow(node);
    const assetGeneration = Boolean(workflow?.assetGroup || workflow?.mediaGroup);
    const bodyProgress = workflow?.step === ShortDramaStep.Body && workflow?.role === "collection" ? workflowEpisodeProgress(nodes, workflow.pipelineId, undefined, node.id) : undefined;
    const continuation = bodyProgress ? workflowContinuationRange(bodyProgress) : undefined;
    const canContinueBody = Boolean(continuation && (bodyProgress!.missing > 0 || bodyProgress!.failed > 0 || bodyProgress!.pending > 0));
    const pending = members.filter((member) => member.metadata?.shortDrama?.submission === "planned");
    const counts = visibleMembers.reduce<Record<string, number>>((result, member) => {
        const key = targets.find((item) => item.nodeId === member.id)?.key;
        const state = groupMemberState(member, key ? session.snapshots[key] : undefined);
        result[state] = (result[state] || 0) + 1;
        return result;
    }, {});
    const rows = groupExecutionRows(members, session.snapshots, order, targets).filter((row) => !chosen || row.nodeId === chosen.id);
    const errors = members.filter((member) => (!chosen || member.id === chosen.id) && member.metadata?.errorDetails && !targets.some((target) => target.nodeId === member.id && session.snapshots[target.key]));
    const hasEarlier = groupSessionHasEarlier(targets, session.snapshots);
    const promptMembers = visibleMembers.filter((member) => member.metadata?.prompt?.trim());
    return (
        <section className="canvas-node-inspector-section production-agent-details" aria-label="分组统一详情会话" data-canvas-no-zoom data-canvas-wheel-scroll>
            <div className="production-agent-overview">
                <div className="production-agent-heading">
                    <strong>{node.title}</strong>
                    <span className="production-agent-status">{visibleMembers.length} 个节点</span>
                </div>
                <div className="production-agent-note" role="status">
                    {Object.entries(counts)
                        .map(([label, count]) => `${label} ${count}`)
                        .join(" · ")}
                </div>
                {run && snapshot ? (
                    <div className="production-agent-note" role="status">
                        {groupMemberState(controlled || node, snapshot)} ·{" "}
                        {progress?.workKind === "plan"
                            ? `${progress.phaseLabel?.trim() || (progress.phase && productionPlanPhaseLabels[progress.phase]) || "制作方案"} · 已保存 ${progress.documentCount ?? progress.processedPages ?? 0}${progress.documentTotal ? `/${progress.documentTotal}` : ""} 份文档 · ${progress.assetCount || 0} 项资产`
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
                        {parallelWarnings.map((item) => item.name).join("、")} 未通过本地校验，已暂停等待修复；点击“继续任务”会从已保存文稿继续。
                    </div>
                ) : null}
                {externalFailure && progress?.assetsStarted && (
                    <div className="production-agent-note" role="status">
                        任务已停止，资产已保存 {progress.assetCount || 0}/{progress.assetTotal || 0} 项。可在对应资产分组详情中重试，已保存内容不会重新生成。
                    </div>
                )}
            </div>
            <div className="production-agent-actions">
                <Select
                    aria-label="筛选组内节点"
                    value={chosen?.id || ""}
                    style={{ width: "100%", maxWidth: 440 }}
                    showSearch
                    optionFilterProp="label"
                    onChange={(value) => {
                        setSelected(value);
                        setVisible(100);
                    }}
                    options={[
                        { value: "", label: "全部节点" },
                        ...visibleMembers.map((member) => ({ value: member.id, label: `${member.title} · ${groupMemberState(member, session.snapshots[targets.find((item) => item.nodeId === member.id)?.key || ""])}` })),
                    ]}
                />
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
                <Button aria-label="刷新分组记录" title="刷新分组记录" loading={session.loading} icon={<RefreshCw size={14} />} onClick={session.refresh} />
                {chosen && task && ["failed", "cancelled"].includes(task.status) ? (
                    <Button icon={<RotateCcw size={14} />} onClick={() => onRetry(chosen)}>
                        重试此节点
                    </Button>
                ) : null}
                {task && canCancelGenerationTask(task) ? (
                    <Button icon={<Square size={14} />} onClick={() => onCancel(task)}>
                        取消此任务
                    </Button>
                ) : null}
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
                            : progress?.assetsStarted
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
            {errors.map((member) => (
                <div key={member.id} role="alert" className="production-agent-error">
                    {member.title}：{member.metadata?.errorDetails}
                </div>
            ))}
            {targets
                .filter((target) => (!chosen || target.nodeId === chosen.id) && session.errors[target.key])
                .map((target) => (
                    <div key={target.key} role="alert" className="production-agent-error">
                        {members.find((member) => member.id === target.nodeId)?.title}：{session.errors[target.key]}
                    </div>
                ))}
            {promptMembers.length ? (
                <details className="production-agent-parameters">
                    <summary>{chosen ? `运行参数 · ${chosen.title}` : `运行提示词 · ${promptMembers.length} 个节点`}</summary>
                    {chosen?.metadata?.prompt ? (
                        <dl>
                            <div>
                                <dt>模型</dt>
                                <dd>{chosen.metadata.model || "未记录"}</dd>
                            </div>
                            <div>
                                <dt>推理强度</dt>
                                <dd>{chosen.metadata.reasoningEffort || "medium"}</dd>
                            </div>
                            <div className="production-agent-prompt">
                                <dt>提示词</dt>
                                <dd style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{chosen.metadata.prompt}</dd>
                            </div>
                        </dl>
                    ) : (
                        <div className="space-y-3">
                            {promptMembers.map((member) => (
                                <div key={member.id}>
                                    <div className="text-xs font-semibold">{member.title}</div>
                                    <div className="mt-1 whitespace-pre-wrap break-words text-xs" style={{ color: "var(--text-secondary, inherit)" }}>
                                        {member.metadata?.prompt}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </details>
            ) : null}
            <CanvasExecutionJournal
                rows={rows.slice(0, visible)}
                order={order}
                onOrder={(value) => {
                    setOrder(value);
                    setVisible(100);
                }}
                empty={pending.length ? "待提交节点尚未调用模型。" : session.loading ? "正在读取本组执行记录" : active ? "后台任务执行中，等待首条可展示进展。" : "本组暂无执行记录"}
            />
            {rows.length > visible ? <Button onClick={() => setVisible((value) => value + 100)}>显示更多记录</Button> : null}
            {hasEarlier ? (
                <Button
                    loading={session.loading}
                    onClick={() => {
                        session.loadEarlier();
                        setVisible((value) => value + 100);
                    }}
                >
                    读取更早记录
                </Button>
            ) : null}
            {targets.some((target) => {
                const value = session.snapshots[target.key];
                return value?.kind === "task" && value.detail.truncated;
            }) ? (
                <p className="production-agent-note">部分任务仅显示最近 200 条执行记录。</p>
            ) : null}
        </section>
    );
}
