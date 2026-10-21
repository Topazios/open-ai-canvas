import { Download, Eye, Info, PencilLine, PlayCircle, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CanvasTheme } from "@/lib/canvas-theme";

type NodeActionBarProps = {
    node: CanvasNodeData;
    theme: CanvasTheme;
    readOnly?: boolean;
    onOpenInfo?: (node: CanvasNodeData) => void;
    onOpenTaskDetails?: (node: CanvasNodeData) => void;
    onOpenTextEditor?: (node: CanvasNodeData) => void;
    onOpenDrawing?: (node: CanvasNodeData) => void;
    onViewImage?: (node: CanvasNodeData) => void;
    onMediaPlayRequest?: (nodeId: string) => void;
    onRetry?: (node: CanvasNodeData) => void;
    onReloadResource?: (node: CanvasNodeData) => void;
    onInlineEdit?: () => void;
    additionalActions?: NodeAction[];
};

type NodeAction = {
    label: string;
    icon: ReactNode;
    onClick: () => void;
    primary?: boolean;
    danger?: boolean;
};

export function CanvasNodeActionButton({ theme, label, icon, onClick, primary = false, danger = false, disabled = false }: { theme: CanvasTheme; label: string; icon: ReactNode; onClick: () => void; primary?: boolean; danger?: boolean; disabled?: boolean }) {
    return <button
        type="button"
        disabled={disabled}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[var(--fs-tiny)] font-medium transition-colors hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-40 dark:hover:bg-white/8"
        style={{ color: danger ? theme.accent.danger : primary ? theme.accent.primary : theme.node.text, outlineColor: theme.accent.primary }}
        title={label}
        aria-label={label}
        onClick={(event) => { event.stopPropagation(); onClick(); }}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
    >
        {icon}
        <span className="whitespace-nowrap">{label}</span>
    </button>;
}

export function CanvasNodeActionBar({ node, theme, readOnly = false, onOpenInfo, onOpenTaskDetails, onOpenTextEditor, onOpenDrawing, onViewImage, onMediaPlayRequest, onRetry, onReloadResource, onInlineEdit, additionalActions = [] }: NodeActionBarProps) {
    if (readOnly) return null;

    const hasTask = Boolean(node.metadata?.taskId || node.metadata?.shortDrama?.productionAgent?.runId);
    const isText = node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Markdown;
    const canEdit = isText && Boolean(onOpenTextEditor || onInlineEdit);
    const canEditDrawing = node.type === CanvasNodeType.Drawing && Boolean(onOpenDrawing);
    const hasImage = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content || node.metadata?.previewContent || node.metadata?.storageKey);
    const hasVideo = node.type === CanvasNodeType.Video && Boolean(node.metadata?.content || node.metadata?.storageKey);
    const hasAudio = node.type === CanvasNodeType.Audio && Boolean(node.metadata?.content || node.metadata?.storageKey);
    const canPreview = hasImage && Boolean(onViewImage);
    const canPlay = (hasVideo || hasAudio) && Boolean(onMediaPlayRequest);

    const actions: NodeAction[] = [];
    if (canEdit) {
        actions.push({
            label: "编辑",
            icon: <PencilLine className="size-3.5" />,
            onClick: () => {
                if (onOpenTextEditor) onOpenTextEditor(node);
                else onInlineEdit?.();
            },
            primary: true,
        });
    } else if (canEditDrawing) {
        actions.push({ label: "编辑", icon: <PencilLine className="size-3.5" />, onClick: () => onOpenDrawing?.(node), primary: true });
    }
    if (canPreview) actions.push({ label: "预览", icon: <Eye className="size-3.5" />, onClick: () => onViewImage?.(node) });
    if (canPlay) actions.push({ label: hasAudio ? "播放" : "预览", icon: <PlayCircle className="size-3.5" />, onClick: () => onMediaPlayRequest?.(node.id) });
    if (hasTask && onOpenTaskDetails) {
        actions.push({ label: "详情", icon: <Info className="size-3.5" />, onClick: () => onOpenTaskDetails(node) });
    } else if (onOpenInfo) {
        actions.push({ label: "详情", icon: <Info className="size-3.5" />, onClick: () => onOpenInfo(node) });
    }
    if (node.metadata?.status === "error" && node.metadata.resourceReloadAvailable && onReloadResource) {
        actions.push({ label: "重新加载资源", icon: <Download className="size-3.5" />, onClick: () => onReloadResource(node), primary: true });
    }
    if (node.metadata?.status === "error" && onRetry) {
        actions.push({ label: node.metadata.taskCanRecoverMedia ? "重试保存" : "重新生成", icon: <RefreshCw className="size-3.5" />, onClick: () => onRetry(node) });
    }
    actions.push(...additionalActions);
    if (!actions.length) return null;

    return (
        <div
            className="pointer-events-auto absolute inset-x-0 bottom-0 z-[var(--node-z-overlay)] flex min-h-10 min-w-0 justify-start border-t px-2 py-1.5 backdrop-blur-xl"
            style={{ borderColor: theme.node.stroke, background: `${theme.toolbar.panel}e8` }}
            data-canvas-no-zoom
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div
                role="toolbar"
                aria-label={`${node.title || "节点"}快捷操作`}
                className="thin-scrollbar flex min-w-0 max-w-full items-center justify-start gap-1 overflow-x-auto"
            >
                {actions.map((action) => (
                    <CanvasNodeActionButton
                        key={action.label}
                        theme={theme}
                        label={action.label}
                        icon={action.icon}
                        primary={action.primary}
                        danger={action.danger}
                        onClick={action.onClick}
                    />
                ))}
            </div>
        </div>
    );
}
