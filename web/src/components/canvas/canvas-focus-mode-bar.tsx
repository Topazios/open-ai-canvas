import { Tooltip } from "@/components/ui/base/tooltip";
import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Clapperboard, FolderKanban, History, PanelBottom, X, ZoomIn, ZoomOut } from "lucide-react";


import { aceternityMotion } from "@/lib/aceternity-motion";
import { canvasThemes } from "@/lib/canvas-theme";
import type { CanvasShortDramaProgress } from "@/lib/canvas/canvas-short-drama";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";

type CanvasFocusModeBarProps = {
    versionsOpen: boolean;
    onToggleVersions: () => void;
    syncStatus?: ReactNode;
    dockRevealed: boolean;
    zoomPercent: number;
    onToggleDock: () => void;
    onExit: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onFit: () => void;
    onOpenProjectAssociation?: () => void;
    shortDramaGuide?: { progress: CanvasShortDramaProgress; collapsed: boolean; onToggle: () => void };
};

export function CanvasFocusModeBar({ versionsOpen, onToggleVersions, syncStatus, dockRevealed, zoomPercent, onToggleDock, onExit, onZoomIn, onZoomOut, onFit, shortDramaGuide, onOpenProjectAssociation }: CanvasFocusModeBarProps) {
    const theme = canvasThemes[useActiveTheme()];
    const reducedMotion = useReducedMotion();

    return (
        <motion.div
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reducedMotion ? { duration: 0 } : aceternityMotion.spring.panel}
            className="pointer-events-auto absolute left-1/2 top-2 z-[var(--z-toolbar)] w-max max-w-[calc(100%-16px)] -translate-x-1/2"
            data-canvas-no-zoom
            role="toolbar"
            aria-label="专注模式工具栏"
        >
            <div className="flex flex-wrap items-center justify-center gap-0.5 rounded-lg p-1 backdrop-blur-2xl" style={{ background: theme.spatial.elevated, color: theme.node.text, boxShadow: "var(--workspace-overlay-shadow)" }}>
                <Tooltip title="退出专注模式（Esc）">
                    <button
                        type="button"
                        onClick={onExit}
                        className="grid size-8 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                        aria-label="退出专注模式"
                    >
                        <X className="size-4" />
                    </button>
                </Tooltip>
                {syncStatus}
                {onOpenProjectAssociation ? <Tooltip title="关联项目与章节"><button type="button" onClick={onOpenProjectAssociation} className="grid size-8 place-items-center rounded-md" aria-label="关联项目与章节"><FolderKanban className="size-4" /></button></Tooltip> : null}
                {shortDramaGuide ? (
                    <Tooltip title={shortDramaGuide.collapsed ? "展开短剧流程" : "收起短剧流程"}>
                        <button type="button" onClick={shortDramaGuide.onToggle} className="flex h-8 items-center gap-1 rounded-md px-2 text-[var(--fs-label)] tabular-nums" style={{ background: shortDramaGuide.collapsed ? undefined : theme.toolbar.itemHover }} aria-label="短剧流程" aria-pressed={!shortDramaGuide.collapsed}>
                            <Clapperboard className="size-4" />
                            <span>{shortDramaGuide.progress.completedCount}/{shortDramaGuide.progress.steps.length}</span>
                        </button>
                    </Tooltip>
                ) : null}
                <Tooltip title="版本记录与本地草稿">
                    <button type="button" onClick={onToggleVersions} className="grid size-8 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text, background: versionsOpen ? theme.toolbar.itemHover : undefined }} aria-label="版本记录" aria-pressed={versionsOpen}>
                        <History className="size-4" />
                    </button>
                </Tooltip>
                <span className="mx-0.5 h-4 w-px" style={{ background: theme.toolbar.border }} />
                <Tooltip title={dockRevealed ? "收起工具" : "工具"}>
                    <button
                        type="button"
                        onClick={onToggleDock}
                        className="grid size-8 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10"
                        style={{ color: theme.node.text, background: dockRevealed ? theme.toolbar.itemHover : undefined }}
                        aria-label="工具"
                        aria-pressed={dockRevealed}
                    >
                        <PanelBottom className="size-4" />
                    </button>
                </Tooltip>
                <Tooltip title="缩小">
                    <button type="button" onClick={onZoomOut} className="grid size-8 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label="缩小">
                        <ZoomOut className="size-4" />
                    </button>
                </Tooltip>
                <button
                    type="button"
                    onClick={onFit}
                    className="grid h-8 min-w-14 place-items-center rounded-full px-2 text-xs font-medium tabular-nums transition hover:bg-black/5 dark:hover:bg-white/10"
                    style={{ color: theme.node.text }}
                    title="适应画布"
                >
                    {Math.round(zoomPercent * 100)}%
                </button>
                <Tooltip title="放大">
                    <button type="button" onClick={onZoomIn} className="grid size-8 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" style={{ color: theme.node.text }} aria-label="放大">
                        <ZoomIn className="size-4" />
                    </button>
                </Tooltip>
            </div>
        </motion.div>
    );
}
