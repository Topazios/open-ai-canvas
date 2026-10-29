import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { ChevronDown, ChevronUp, Clock3, Coins, FileText, ListTodo, LoaderCircle, Pause, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { formatCredits } from "@/constant/credits";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { canCancelGenerationTask, generationTaskShowsProgress, generationTaskStatusLabel } from "@/lib/generation-task-display";
import { canvasTaskCounts, canvasTaskPresentation, type CanvasTaskPresentation } from "@/lib/canvas/canvas-task-presentation";
import type { CanvasNodeData } from "@/types/canvas";
import { canvasThemes } from "@/lib/canvas-theme";
import type { GenerationTask } from "@/services/api/task-center";
import type { AgentRun } from "@/services/api/agent";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { useUserStore } from "@/stores/use-user-store";

// 顶栏是绝对定位浮层，面板必须按调用方传入的 topInset 避让；专注模式隐藏顶栏时传小间距。
export function CanvasActiveTaskPanel({ tasks, agentRuns = [], nodes = [], align = "right", topInset = "var(--canvas-topbar-offset)", onCancelTask, onOpenNode, workflowSubmitting = false, onCancelWorkflowSubmission }: { tasks: GenerationTask[]; agentRuns?: AgentRun[]; nodes?: CanvasNodeData[]; align?: "left" | "right"; topInset?: string; onCancelTask?: (task: GenerationTask) => void; onOpenNode?: (nodeId: string) => void; workflowSubmitting?: boolean; onCancelWorkflowSubmission?: () => void }) {
    const theme = canvasThemes[useActiveTheme()];
    const creditsEnabled = useUserStore((state) => state.features.creditsEnabled);
    const reducedMotion = useReducedMotion();
    const [now, setNow] = useState(() => Date.now());
    const [open, setOpen] = useState(false);
    const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
    const presentations = useMemo(() => new Map(tasks.map((task) => [task.id, canvasTaskPresentation(task, tasks, nodes)])), [tasks, nodes]);
    const counts = canvasTaskCounts(tasks);
    const agents = agentRuns.filter(run => run.production && ["queued", "running", "waiting_approval"].includes(run.status) && nodes.some(node => node.id === run.production!.targetNodeId && node.metadata?.shortDrama?.productionAgent?.runId === run.id));
    const hasRunning = tasks.length > 0 || agents.some(run => !run.production?.paused && run.status !== "waiting_approval");

    useEffect(() => {
        if (!tasks.length) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [tasks.length]);

    useEffect(() => {
        if (expandedTaskId && !tasks.some((task) => task.id === expandedTaskId)) setExpandedTaskId(null);
    }, [expandedTaskId, tasks]);

    if (!tasks.length && !agents.length && !workflowSubmitting) return null;

    const motionTransition = reducedMotion ? { duration: 0 } : aceternityMotion.spring.panel;

    return (
        <AnimatePresence initial={false}>
            <motion.div
                key="canvas-active-task-panel"
                data-canvas-no-zoom
                initial={{ opacity: 0, y: -8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.98 }}
                transition={motionTransition}
                className={`pointer-events-none absolute z-[var(--z-panel-floating)] w-[var(--canvas-panel-width)] max-w-[calc(100%-24px)] ${align === "left" ? "left-3" : "right-3"}`}
                style={{ top: topInset }}
            >
                <LayoutGroup id="canvas-active-tasks">
                    <motion.section
                        layout
                        className="pointer-events-auto overflow-hidden rounded-[var(--panel-radius)] border backdrop-blur-2xl"
                        style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, boxShadow: `0 24px 72px ${theme.spatial.shadow}` }}
                        aria-label="当前画布生成任务"
                    >
                        <motion.button
                            type="button"
                            layout
                            className="flex min-h-12 w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                            onClick={() => setOpen((value) => !value)}
                            aria-expanded={open}
                            aria-controls="canvas-active-task-list"
                        >
                            <span className="flex min-w-0 items-center gap-2">
                                <span className="grid size-8 shrink-0 place-items-center rounded-[var(--dock-item-radius)]" style={{ background: theme.accent.primarySoft, color: theme.accent.primary }}>
                                    <ListTodo className="size-4" />
                                </span>
                                <span className="min-w-0">
                                    <span className="block text-sm font-semibold leading-5">生成任务</span>
                                    <span className="block truncate text-[var(--fs-label)]" style={{ color: theme.node.muted }} aria-live="polite">
                                        {workflowSubmitting ? "正在创建节点并提交" : `${counts.roots + agents.length} 项制作${counts.children ? ` · ${counts.children} 个子任务` : ""}${counts.queued ? ` · ${counts.queued} 个排队` : ""}`}
                                    </span>
                                </span>
                            </span>
                            <span className="flex shrink-0 items-center gap-2" style={{ color: theme.accent.primary }}>
                                {hasRunning ? <LoaderCircle className="size-4 animate-spin opacity-70 motion-reduce:animate-none" /> : <Pause className="size-4" />}
                                {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                            </span>
                        </motion.button>

                        <AnimatePresence initial={false}>
                            {open ? (
                                <motion.div
                                    id="canvas-active-task-list"
                                    layout
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: "auto" }}
                                    exit={{ opacity: 0, height: 0 }}
                                    transition={motionTransition}
                                    className="thin-scrollbar max-h-[min(70vh,520px)] space-y-2 overflow-y-auto px-2.5 pb-2.5"
                                    data-canvas-wheel-scroll
                                >
                                    {workflowSubmitting ? <div className="flex items-center justify-between gap-3 rounded-[var(--r-md)] border p-3 text-xs" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }}>
                                        <span className="min-w-0" style={{ color: theme.node.muted }}>节点创建与任务提交在后台继续</span>
                                        {onCancelWorkflowSubmission ? <button type="button" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--r-sm)] px-2.5 font-medium" style={{ background: theme.toolbar.itemHover, color: theme.node.text }} onClick={onCancelWorkflowSubmission} aria-label="停止后续任务提交" title="停止后续任务提交"><XCircle className="size-4" />停止后续提交</button> : null}
                                    </div> : null}
                                    {agents.map(run => <CanvasActiveAgentCard key={run.id} run={run} nodes={nodes} onOpenNode={onOpenNode} theme={theme} />)}
                                    {tasks.map((task) => (
                                        <CanvasActiveTaskCard
                                            key={task.id}
                                            task={task}
                                            presentation={presentations.get(task.id)!}
                                            onOpenNode={onOpenNode}
                                            now={now}
                                            theme={theme}
                                            expanded={expandedTaskId === task.id}
                                            onToggle={() => setExpandedTaskId((current) => (current === task.id ? null : task.id))}
                                            onCancelTask={onCancelTask}
                                            reducedMotion={Boolean(reducedMotion)}
                                            creditsEnabled={creditsEnabled}
                                        />
                                    ))}
                                </motion.div>
                            ) : null}
                        </AnimatePresence>
                    </motion.section>
                </LayoutGroup>
            </motion.div>
        </AnimatePresence>
    );
}

export function CanvasActiveAgentCard({ run, nodes, onOpenNode, theme }: { run: AgentRun; nodes: CanvasNodeData[]; onOpenNode?: (nodeId: string) => void; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const progress = run.production!;
    const target = nodes.find(node => node.id === progress.targetNodeId);
    const title = target?.title || "制作 Agent";
    const status = progress.paused ? progress.waitingForBoundary ? "暂停中，等待当前调用结束" : "已暂停" : run.status === "waiting_user" ? "等待用户处理" : run.status === "completed" ? "已完成" : run.status === "queued" ? "排队中" : run.status === "waiting_approval" ? "等待授权" : "执行中";
    const current = progress.concurrentItems?.length ? progress.concurrentItems.join("、") : progress.currentItem || progress.phaseLabel || "准备制作内容";
    const items = progress.parallelItems || [];
    const itemStatus = { queued: "排队中", running: "生成中", succeeded: "已返回", failed: "调用失败", cancelled: "已取消", retrying: "自动重试中", error: "保存失败", warning: "待检查", unknown: "核对状态中" };
    return <article className="rounded-[var(--r-md)] border p-3 text-xs" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }} aria-label={`${title}任务`}>
        <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words font-semibold">{title}</span><span className="shrink-0" style={{ color: theme.accent.primary }}>{status}</span></div>
        <div className="mt-2 break-words" style={{ color: theme.node.muted }}>{current}</div>
        <div className="mt-2" style={{ color: theme.node.muted }}>
            {progress.workKind === "plan" ? `文稿 ${progress.documentCount || 0}/${progress.documentTotal || 0} · 资产 ${progress.assetCount || 0}/${progress.assetTotal || 0}` : `已保存 ${progress.artifactCount} 项${progress.shotTotal ? ` · 共 ${progress.shotTotal} 个镜头` : ""}`}
        </div>
        {items.map(item => <div key={item.key} className="mt-2 flex justify-between gap-2"><span className="min-w-0 break-words">{item.name}</span><span className="shrink-0" style={{ color: item.severity === "warning" || item.status === "warning" ? "var(--status-warning)" : item.status === "failed" || item.status === "error" ? "var(--status-error)" : theme.node.muted }}>{item.severity === "warning" && ["failed", "error"].includes(item.status) ? "待处理" : itemStatus[item.status]}</span></div>)}
        {onOpenNode ? <button type="button" className="mt-3 inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[var(--fs-tiny)] font-medium" style={{ background: theme.toolbar.itemHover, color: theme.node.text }} onClick={() => onOpenNode(target?.parentId || progress.targetNodeId)}><FileText className="size-3" />查看执行详情</button> : null}
    </article>;
}

export function CanvasActiveTaskCard({
    task,
    presentation,
    onOpenNode,
    now,
    theme,
    expanded,
    onToggle,
    onCancelTask,
    reducedMotion,
    creditsEnabled,
}: {
    task: GenerationTask;
    presentation: CanvasTaskPresentation;
    onOpenNode?: (nodeId: string) => void;
    now: number;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    expanded: boolean;
    onToggle: () => void;
    onCancelTask?: (task: GenerationTask) => void;
    reducedMotion: boolean;
    creditsEnabled: boolean;
}) {
    const showsProgress = generationTaskShowsProgress(task);
    const progress = showsProgress && typeof task.progress === "number" ? Math.max(0, Math.min(100, Math.round(task.progress))) : showsProgress && task.status === "queued" ? 0 : undefined;
    const startedAt = task.startedAt || task.createdAt;
    const elapsedMs = Math.max(0, now - parseTime(startedAt));
    const durationLabel = `${task.status === "queued" ? "已等待" : "已运行"} ${formatDuration(elapsedMs)}`;
    const billingLabel = task.billing ? `${({ reserved: "冻结", running: "处理中", settled: "已结算", refunded: "已退还", uncertain: "待核对" } as const)[task.billing.status]} ${formatCredits(task.billing.amountMicrocredits)} 积分` : "";
    const statusTone = task.status === "running" ? theme.accent.primary : theme.node.muted;
    const transition = reducedMotion ? { duration: 0 } : aceternityMotion.spring.panel;

    return (
        <motion.article layout layoutId={`canvas-active-task-${task.id}`} className="overflow-hidden rounded-[var(--r-md)] border" style={{ background: theme.spatial.surface, borderColor: theme.toolbar.border }}>
            <button type="button" className="block w-full p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]" onClick={onToggle} aria-expanded={expanded}>
                <div className="flex min-w-0 items-start gap-2">
                    <motion.span layout="position" className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md" style={{ background: `${statusTone}18`, color: statusTone }}>
                        <ListTodo className="size-3.5" />
                    </motion.span>
                    <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                            <span className="min-w-0 break-words text-xs font-semibold" title={presentation.title}>
                                {presentation.title}
                            </span>
                            <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[var(--fs-tiny)] font-medium" style={{ borderColor: `${statusTone}44`, color: statusTone }}>
                                {generationTaskStatusLabel(task)}
                            </span>
                        </span>
                        <span className="mt-1 block break-words text-[var(--fs-label)]" style={{ color: theme.node.text }}>
                            {presentation.work}
                        </span>
                        {presentation.source ? <span className="mt-1 block line-clamp-2 break-words text-[var(--fs-tiny)]" style={{ color: theme.node.muted }} title={presentation.source}>{presentation.source}</span> : null}
                        <span className="mt-1 block break-words text-[var(--fs-tiny)]" style={{ color: theme.node.muted }}>{presentation.stage}</span>
                    </span>
                    {expanded ? <ChevronUp className="mt-0.5 size-3.5 shrink-0" style={{ color: theme.node.muted }} /> : <ChevronDown className="mt-0.5 size-3.5 shrink-0" style={{ color: theme.node.muted }} />}
                </div>

                {showsProgress ? (
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full" style={{ background: theme.toolbar.itemHover }}>
                        {progress !== undefined ? (
                            <motion.div className="relative h-full rounded-full overflow-hidden" animate={{ width: `${progress}%` }} transition={reducedMotion ? { duration: 0 } : { duration: 0.3, ease: "easeOut" }} style={{ background: statusTone }}>
                                {/* 进度条 shimmer 扫描动画（对应 #98 决策3）*/}
                                {task.status === "running" && !reducedMotion ? (
                                    <span className="absolute inset-0 canvas-task-progress-shimmer" style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,.3), transparent)" }} aria-hidden />
                                ) : null}
                            </motion.div>
                        ) : (
                            // indeterminate 模式（无具体百分比，从左到右循环扫描）
                            <motion.div
                                className="h-full rounded-full"
                                initial={{ width: "20%", x: "-100%" }}
                                animate={{ width: "20%", x: "400%" }}
                                transition={reducedMotion ? { duration: 0 } : { duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                                style={{ background: statusTone }}
                            />
                        )}
                    </div>
                ) : null}

                {/* 进度百分比显示（对应 #98 决策3：列表视图）*/}
                {progress !== undefined && task.status === "running" ? (
                    <div className="mt-1 flex items-center justify-between text-[var(--fs-micro)]" style={{ color: theme.node.muted }}>
                        <span>{durationLabel}</span>
                        <span className="font-medium tabular-nums" style={{ color: statusTone }}>
                            {progress}%
                        </span>
                    </div>
                ) : (
                    <div className={`mt-3 grid gap-2 text-[var(--fs-tiny)] ${creditsEnabled && billingLabel ? "grid-cols-2" : "grid-cols-1"}`} style={{ color: theme.node.muted }}>
                        <span className="inline-flex min-w-0 items-center gap-1 truncate" title={durationLabel}>
                            <Clock3 className="size-3 shrink-0" />
                            {durationLabel}
                        </span>
                        {creditsEnabled && billingLabel ? (
                            <span className="inline-flex min-w-0 items-center justify-end gap-1 truncate" title={billingLabel}>
                                <Coins className="size-3 shrink-0" />
                                {billingLabel}
                            </span>
                        ) : null}
                    </div>
                )}
            </button>

            <AnimatePresence initial={false}>
                {expanded ? (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={transition}
                        className="border-t px-3 pb-3 pt-2 text-[var(--fs-label)]"
                        style={{ borderColor: theme.toolbar.border, color: theme.node.muted }}
                    >
                        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                            <span>当前阶段</span>
                            <span className="break-words text-right" style={{ color: theme.node.text }}>
                                {presentation.stage}
                            </span>
                        </div>
                        {task.model ? <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-2"><span>模型</span><span className="break-all text-right" style={{ color: theme.node.text }}>{task.model}</span></div> : null}
                        <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-2"><span>任务编号</span><span className="break-all text-right">{task.id}</span></div>
                        {onOpenNode && presentation.nodeId ? <button type="button" className="mt-3 inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[var(--fs-tiny)] font-medium" style={{ background: theme.toolbar.itemHover, color: theme.node.text }} onClick={() => onOpenNode(presentation.nodeId!)}><FileText className="size-3" />{presentation.parentTaskId ? "查看所属节点详情" : "查看节点详情"}</button> : null}
                        {onCancelTask && canCancelGenerationTask(task) ? (
                            <button
                                type="button"
                                className="mt-3 inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[var(--fs-tiny)] font-medium transition-colors"
                                style={{ background: `${theme.accent.danger}16`, color: theme.accent.danger }}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onCancelTask(task);
                                }}
                                onMouseDown={(event) => event.stopPropagation()}
                            >
                                <XCircle className="size-3" />
                                取消任务
                            </button>
                        ) : null}
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </motion.article>
    );
}

function parseTime(value?: string) {
    if (!value) return Date.now();
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : Date.now();
}

function formatDuration(value: number) {
    const totalSeconds = Math.floor(value / 1_000);
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
