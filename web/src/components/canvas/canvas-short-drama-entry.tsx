import { useId, useState, type CSSProperties } from "react";
import { Popover } from "antd";
import { AlignLeft, ArrowLeft, ArrowUpRight, Check, ChevronUp, Clapperboard, FolderKanban, GripHorizontal, Images, Info, LayoutGrid, Palette, Pencil, Plus, Settings2, Sparkles, Type, Upload, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { CanvasNodeActionButton } from "./canvas-node-action-bar";
import { CanvasCreateMenu, type CanvasCreateCommand } from "@/components/canvas/canvas-create-menu";
import type { CanvasShortDramaProgress, CanvasShortDramaStepId, CanvasShortDramaTask } from "@/lib/canvas/canvas-short-drama";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasNodeData } from "@/types/canvas";
import { useDramaGuidePosition } from "./use-drama-guide-position";

import "./canvas-short-drama-entry.css";

export function CanvasLinkedProjectEmptyState({ projectName, hasChapter, onAddFirstChapter, onOpenAssets, onAddText }: { projectName: string; hasChapter: boolean; onAddFirstChapter: () => void; onOpenAssets: () => void; onAddText: () => void }) {
    const theme = canvasThemes[useActiveTheme()];
    return (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center px-4 pb-16 pt-20">
            <div className="pointer-events-auto w-full max-w-[440px] rounded-lg border p-3 shadow-sm backdrop-blur" data-canvas-no-zoom style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
                <div className="flex items-center gap-2.5">
                    <span className="grid size-8 shrink-0 place-items-center rounded-md" style={{ background: theme.toolbar.itemHover, color: theme.node.muted }}>
                        <FolderKanban className="size-4" />
                    </span>
                    <div className="min-w-0">
                        <h2 className="truncate text-sm font-semibold">{projectName}</h2>
                        <p className="mt-0.5 text-[var(--fs-label)]" style={{ color: theme.node.muted }}>
                            项目画布为空
                        </p>
                    </div>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-1.5">
                    <button
                        type="button"
                        disabled={!hasChapter}
                        onClick={onAddFirstChapter}
                        className="flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border px-2 text-[var(--fs-label)] font-medium disabled:opacity-35"
                        style={{ borderColor: theme.node.stroke, background: theme.node.fill }}
                    >
                        <Plus className="size-3.5 shrink-0" />
                        <span className="truncate">添加首章</span>
                    </button>
                    <button
                        type="button"
                        onClick={onOpenAssets}
                        className="flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border px-2 text-[var(--fs-label)] font-medium"
                        style={{ borderColor: theme.node.stroke, background: theme.node.fill }}
                    >
                        <Images className="size-3.5 shrink-0" />
                        <span className="truncate">项目资产</span>
                    </button>
                    <button type="button" onClick={onAddText} className="flex h-9 min-w-0 items-center justify-center gap-1 rounded-md border px-2 text-[var(--fs-label)] font-medium" style={{ borderColor: theme.node.stroke, background: theme.node.fill }}>
                        <Type className="size-3.5 shrink-0" />
                        <span className="truncate">新建文本</span>
                    </button>
                </div>
            </div>
        </div>
    );
}

export function CanvasShortDramaEmptyState({
    onCreatePipeline,
    onOpenAgent,
    onStartFreeform,
    onUpload,
    onAddText,
    onAddScript,
}: {
    onCreatePipeline: () => void;
    onOpenAgent: () => void;
    onStartFreeform: () => void;
    onUpload: () => void;
    onAddText: () => void;
    onAddScript: () => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const entryStyle = {
        "--canvas-entry-text": theme.node.text,
        "--canvas-entry-muted": theme.node.muted,
        "--canvas-entry-accent": theme.accent.primary,
    } as CSSProperties;
    return (
        <div className="canvas-entry-stage" style={entryStyle}>
            <div className="canvas-entry-shell" data-canvas-no-zoom data-canvas-wheel-scroll>
                <header className="canvas-entry-header">
                    <div className="canvas-entry-heading-copy">
                        <h2>
                            <span>让灵感，</span>
                            <strong>开始成片。</strong>
                        </h2>
                        <p>从一句想法开始，和 Agent 一起创作。</p>
                    </div>
                    <CanvasEntryFilmMark />
                </header>
                <div className="canvas-entry-actions">
                    <button type="button" className="canvas-entry-agent" onClick={onOpenAgent}>
                        <span className="canvas-entry-agent-label">交给 Agent</span>
                        <span className="canvas-entry-agent-arrow">
                            <ArrowUpRight aria-hidden="true" />
                        </span>
                    </button>
                    <div className="canvas-entry-secondary-actions">
                        <button type="button" onClick={onCreatePipeline}>
                            自己创作
                            <ArrowUpRight aria-hidden="true" />
                        </button>
                        <button type="button" onClick={onStartFreeform}>
                            空白画布
                            <ArrowUpRight aria-hidden="true" />
                        </button>
                    </div>
                </div>
                <div className="canvas-entry-footer">
                    <div className="canvas-entry-quick-actions">
                        <button type="button" onClick={onUpload}>
                            <Upload aria-hidden="true" />
                            导入素材
                        </button>
                        <button type="button" onClick={onAddText}>
                            <Type aria-hidden="true" />
                            新建文本
                        </button>
                        <button type="button" onClick={onAddScript}>
                            <Clapperboard aria-hidden="true" />
                            空白分镜
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function CanvasEntryFilmMark() {
    const id = useId();
    return (
        <svg className="canvas-entry-film-mark" viewBox="0 0 112 112" fill="none" aria-hidden="true" focusable="false">
            <defs>
                <linearGradient id={`${id}-front`} x1="27" y1="18" x2="76" y2="91" gradientUnits="userSpaceOnUse">
                    <stop stopColor="var(--canvas-entry-metal-highlight)" />
                    <stop offset="0.42" stopColor="var(--canvas-entry-metal-mid)" />
                    <stop offset="0.66" stopColor="var(--canvas-entry-metal-highlight)" />
                    <stop offset="1" stopColor="var(--canvas-entry-metal-shadow)" />
                </linearGradient>
                <linearGradient id={`${id}-edge`} x1="36" y1="21" x2="86" y2="83" gradientUnits="userSpaceOnUse">
                    <stop stopColor="var(--canvas-entry-metal-mid)" />
                    <stop offset="1" stopColor="var(--canvas-entry-metal-shadow)" />
                </linearGradient>
            </defs>
            <path d="M35 17 92 50Q98 54 92 58L35 91 26 86 82 54 26 22Z" fill={`url(#${id}-edge)`} />
            <path d="M26 22 82 54 26 86V22ZM36 39V69L62 54 36 39Z" fill={`url(#${id}-front)`} fillRule="evenodd" />
            <path d="M26 22 82 54 26 86V22Z" stroke="var(--canvas-entry-metal-highlight)" strokeOpacity="0.45" strokeWidth="0.6" strokeLinejoin="round" />
            <path d="M36 39V69L62 54" stroke="var(--canvas-entry-metal-shadow)" strokeWidth="1" strokeLinejoin="round" />
            <path d="m35 17 57 33" stroke="var(--canvas-entry-metal-highlight)" strokeOpacity="0.5" strokeWidth="0.6" />
        </svg>
    );
}

export function CanvasFreeformEmptyState({ commands }: { commands: CanvasCreateCommand[] }) {
    const theme = canvasThemes[useActiveTheme()];
    const [createOpen, setCreateOpen] = useState(false);
    const createCommands = commands.map((command) => ({
        ...command,
        onClick: () => {
            setCreateOpen(false);
            command.onClick();
        },
    }));
    return (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center px-4 pb-20 pt-24">
            <div
                className="pointer-events-auto flex min-h-[260px] w-full max-w-[520px] flex-col items-center justify-center rounded-2xl border border-dashed px-8 py-10 text-center backdrop-blur"
                data-canvas-no-zoom
                style={{ background: theme.node.fill, borderColor: theme.node.edge, boxShadow: theme.node.shadow, color: theme.node.text }}
            >
                <h2 className="text-base font-semibold">自由空白画布</h2>
                <p className="mt-1 text-xs" style={{ color: theme.node.muted }}>
                    不预设流程，从任意一种素材开始创作。
                </p>
                <Popover
                    arrow={false}
                    open={createOpen}
                    onOpenChange={setCreateOpen}
                    placement="bottom"
                    trigger="click"
                    content={
                        <div className="w-[420px] max-w-[calc(100vw-48px)] p-1" onWheel={(event) => event.stopPropagation()}>
                            <CanvasCreateMenu commands={createCommands} />
                        </div>
                    }
                >
                    <button
                        type="button"
                        aria-label="添加第一项"
                        className="mt-7 grid size-14 place-items-center rounded-full border outline-none transition-transform hover:scale-105 focus-visible:ring-2 motion-reduce:transition-none motion-reduce:hover:scale-100"
                        style={{ background: theme.toolbar.panel, borderColor: theme.node.edge, color: theme.node.text, boxShadow: theme.node.shadow, "--tw-ring-color": theme.accent.primary } as CSSProperties}
                    >
                        <Plus className="size-6" />
                    </button>
                </Popover>
                <p className="mt-4 text-[var(--fs-label)]" style={{ color: theme.node.muted }}>
                    点击 + 添加文本、图片、视频、音频或导入素材
                </p>
            </div>
        </div>
    );
}

export function CanvasShortDramaGuide({ progress, collapsed, onToggle, onSkip, onTaskClick, onOpenGlobalSettings, topInset }: { progress: CanvasShortDramaProgress; collapsed: boolean; onToggle: () => void; onSkip: () => void; onTaskClick: (task: CanvasShortDramaTask) => void; onOpenGlobalSettings?: () => void; topInset?: string }) {
    const theme = canvasThemes[useActiveTheme()];
    const panelId = useId();
    const floating = useDramaGuidePosition(progress.active && !collapsed);
    const [selectedStepId, setSelectedStepId] = useState<CanvasShortDramaStepId | "overview" | null>(null);
    const selectedStep = selectedStepId === "overview" ? undefined : progress.steps.find((step) => step.id === selectedStepId) || progress.steps.find((step) => step.status === "current") || progress.steps[0];
    const taskCount = progress.steps.reduce((count, step) => count + step.tasks.length, 0);
    const activateTask = (task: CanvasShortDramaTask) => {
        if (!task.action || task.unavailableReason) return;
        onTaskClick(task);
        setSelectedStepId(null);
        onToggle();
    };
    const guideStyle = {
        ...(floating.position ? { left: floating.position.x, top: floating.position.y } : {}),
        "--canvas-topbar-offset": topInset,
        "--drama-panel": theme.toolbar.panel,
        "--drama-border": theme.toolbar.border,
        "--drama-text": theme.node.text,
        "--drama-muted": theme.node.muted,
        "--drama-accent": theme.accent.primary,
        "--drama-on-accent": theme.accent.onPrimary,
        "--drama-hover": theme.toolbar.itemHover,
    } as CSSProperties;
    if (!progress.active || collapsed) return null;
    return (
        <div className="canvas-drama-guide-boundary" style={{ "--canvas-topbar-offset": topInset } as CSSProperties}>
        <section
            ref={floating.panelRef}
            data-canvas-no-zoom
            data-canvas-wheel-scroll
            className="canvas-drama-guide shadow-sm backdrop-blur"
            style={guideStyle}
            aria-label="短剧完整制作流程"
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") setSelectedStepId(null);
            }}
        >
            <header className="canvas-drama-guide-heading">
                <button type="button" className="canvas-drama-guide-drag" aria-label="移动短剧流程" title="移动短剧流程" {...floating.handleProps}><GripHorizontal className="size-4" /></button>
                <div className="canvas-drama-guide-title">
                    <strong>短剧完整制作流程</strong>
                    <span>
                        {progress.steps.length} 个制作阶段 · {taskCount} 个工作单元
                    </span>
                </div>
                <div className="canvas-drama-guide-controls">
                    {onOpenGlobalSettings ? <button type="button" onClick={onOpenGlobalSettings} aria-label="全局创作设定" title="全局创作设定"><Settings2 className="size-3.5" /></button> : null}
                    <button type="button" onClick={() => setSelectedStepId((value) => value === "overview" ? null : "overview")} aria-label="全部阶段与子任务" title="全部阶段与子任务" aria-pressed={!selectedStep}>
                        <LayoutGrid className="size-3.5" />
                    </button>
                    <button type="button" onClick={onToggle} aria-label="折叠短剧流程" title="折叠短剧流程">
                        <ChevronUp className="size-3.5" />
                    </button>
                    <button type="button" onClick={onSkip} aria-label="隐藏短剧导引" title="隐藏短剧导引">
                        <X className="size-3.5" />
                    </button>
                </div>
            </header>
            <div className="canvas-drama-guide-bar">
                <select aria-label="短剧制作阶段" value={selectedStep?.id || "overview"} onChange={(event) => setSelectedStepId(event.target.value as CanvasShortDramaStepId | "overview")}>
                    {progress.steps.map((step, index) => <option key={step.id} value={step.id}>{index + 1}. {step.label}{step.status === "current" ? " · 当前" : step.status === "completed" ? " · 已具备" : ""}</option>)}
                    <option value="overview">全部阶段与子任务</option>
                </select>
                <span className="canvas-drama-guide-progress">{progress.completedCount}/{progress.steps.length} 阶段</span>
            </div>
            {selectedStep ? (
                <div id={panelId} className="canvas-drama-tasks" role="region" aria-label={`${selectedStep.label}子任务`}>
                    <header>
                        <strong>{selectedStep.label}</strong>
                        <span>
                            {selectedStep.tasks.filter((task) => task.ready).length}/{selectedStep.tasks.length} 项已具备
                        </span>
                        <button type="button" aria-label="返回全部阶段" title="返回全部阶段" onClick={() => setSelectedStepId("overview")}>
                            <ArrowLeft className="size-3.5" />
                        </button>
                    </header>
                    <ul>
                        {selectedStep.tasks.map((task) => (
                            <li key={task.id} data-task-key={task.id}>
                                <span className="canvas-drama-task-state" aria-label={task.ready ? "已具备" : "待处理"}>
                                    {task.ready ? <Check className="size-3.5" /> : <span className="canvas-drama-task-dot" />}
                                </span>
                                <div className="canvas-drama-task-copy">
                                    <span>{task.label}</span>
                                    {task.progressLabel ? <small>{task.progressLabel}</small> : null}
                                    {task.statusDetail ? <small>{task.statusDetail}</small> : null}
                                    {task.unavailableReason ? <small>{task.unavailableReason}</small> : null}
                                </div>
                                {task.action ? (
                                    <button
                                        type="button"
                                        className="canvas-drama-task-action"
                                        disabled={Boolean(task.unavailableReason)}
                                        onClick={() => activateTask(task)}
                                    >
                                        {task.actionLabel}
                                        <ArrowUpRight className="size-3.5" />
                                    </button>
                                ) : (
                                    <small className="canvas-drama-task-pending">待接入</small>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : (
                <div className="canvas-drama-overview" role="region" aria-label="短剧制作阶段与子任务总览">
                    {progress.steps.map((step, index) => (
                        <article key={step.id} className="canvas-drama-overview-item" data-status={step.status}>
                            <header>
                                <span className="canvas-drama-overview-index">{step.status === "completed" ? <Check className="size-3" /> : index + 1}</span>
                                <strong>{step.label}</strong>
                                <span>
                                    {step.tasks.filter((task) => task.ready).length}/{step.tasks.length}
                                </span>
                            </header>
                            <ul>
                                {step.tasks.map((task) => (
                                    <li key={task.id} data-task-key={task.id} data-ready={task.ready ? "true" : "false"}>
                                        <button
                                            type="button"
                                            className="canvas-drama-overview-task"
                                            title={task.unavailableReason || task.actionLabel}
                                            aria-label={`${task.label}：${task.action && !task.unavailableReason ? task.actionLabel : "查看详情"}`}
                                            onClick={() => {
                                                if (task.action && !task.unavailableReason) activateTask(task);
                                                else setSelectedStepId(step.id);
                                            }}
                                        >
                                            <span>{task.label}</span>
                                            <small>{task.ready ? "已具备" : !task.action ? "待接入" : task.unavailableReason ? "待就绪" : "待处理"}</small>
                                            <ArrowUpRight className="size-3" aria-hidden="true" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </article>
                    ))}
                </div>
            )}
        </section>
        </div>
    );
}

export function CanvasStylePlaceholderNodeContent({ onChoose, onInfo }: { onChoose: () => void; onInfo?: () => void }) {
    const theme = canvasThemes[useActiveTheme()];
    return (
        <div className="flex h-full w-full flex-col overflow-hidden" style={{ color: theme.node.text }}>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
                <span className="grid size-10 place-items-center rounded-md" style={{ background: `${theme.accent.primary}16`, color: theme.accent.primary }}>
                    <Palette className="size-5" />
                </span>
                <div className="mt-3 text-sm font-semibold">项目画风</div>
                <div className="mt-1 text-xs" style={{ color: theme.node.muted }}>
                    待选择
                </div>
            </div>
            <div className="flex min-h-10 shrink-0 items-center justify-start gap-1 border-t px-3 py-1.5" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel }} data-canvas-no-zoom onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                <CanvasNodeActionButton theme={theme} label="选择画风" icon={<Sparkles className="size-3.5" />} primary onClick={onChoose} />
                {onInfo ? <CanvasNodeActionButton theme={theme} label="详情" icon={<Info className="size-3.5" />} onClick={onInfo} /> : null}
            </div>
        </div>
    );
}

export function CanvasStoryInputNodeContent({ node, onEdit }: { node: CanvasNodeData; onEdit: () => void }) {
    const theme = canvasThemes[useActiveTheme()];
    const content = (node.metadata?.content || "").replace(/\s+/g, " ").trim();
    const development = node.metadata?.storyDevelopment;
    const label = development ? node.metadata?.workflowTitle || node.title : "故事梗概";
    return (
        <div className="flex h-full w-full flex-col overflow-hidden p-4" style={{ color: theme.node.text }}>
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="grid size-8 shrink-0 place-items-center rounded-md" style={{ background: theme.toolbar.itemHover, color: theme.node.muted }}>
                        <AlignLeft className="size-4" />
                    </span>
                    <span className="truncate text-sm font-semibold">{label}{development?.stage === "body" ? ` · 第 ${development.episodeNumber || 1} 集` : ""}</span>
                </div>
            </div>
            <div className="mt-4 min-h-0 flex-1 overflow-hidden border-t pt-3 text-xs leading-6" style={{ borderColor: theme.node.stroke, color: content ? theme.node.muted : theme.node.placeholder }}>
                {content || (development ? "待创作" : "写下题材、角色、冲突和结局方向…")}
            </div>
            <div className="mt-3 flex min-h-10 min-w-0 items-center border-t pt-2" style={{ borderColor: theme.node.stroke }}>
                <CanvasNodeActionButton theme={theme} label="详情" icon={<AlignLeft className="size-3.5" />} onClick={onEdit} />
            </div>
        </div>
    );
}
