import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Boxes, Check, ChevronDown, ChevronRight, CircleAlert, Info, LoaderCircle, RefreshCw, TriangleAlert, Video } from "lucide-react";

import { CometCard } from "@/components/ui/aceternity/comet-card";
import { CanvasFolderPreview } from "@/components/canvas/canvas-folder-preview";
import { CanvasVideoPreviewImage } from "@/components/canvas/canvas-video-preview-image";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { FRAME_HEADER_HEIGHT, FRAME_PADDING, isCanvasFolderNode } from "@/lib/canvas/canvas-frame";
import type { CanvasNodeRenderLOD } from "@/lib/canvas/canvas-node-lod";
import { recordCanvasRender } from "@/lib/canvas/canvas-performance-diagnostics";
import { episodeProgress, episodeProgressLabel } from "@/lib/canvas/canvas-short-drama-workflow";
import { productionAssetGroupState, productionTaskState, productionPlanAssetAction, productionPlanCanvasDocumentCount } from "@/lib/canvas/production-agent-state";
import { CanvasNodeActionButton } from "./canvas-node-action-bar";
import { groupStatusButtonsCompact } from "@/lib/canvas/canvas-node-header-metrics";
import type { AgentRun } from "@/services/api/agent";
import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { CanvasNodeType, type CanvasFolderStyle, type CanvasFolderTheme, type CanvasNodeData, type Position } from "@/types/canvas";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const CanvasFrameNode = React.memo(function CanvasFrameNode({
    data,
    renderLOD = "full",
    dragOffset,
    childNodes,
    taskAnchor,
    productionRun,
    scale,
    isSelected,
    isDropTarget,
    onMouseDown,
    onResize,
    onResizeGesture,
    onToggleCollapsed,
    onFolderStyleChange,
    onFolderThemeChange = () => undefined,
    onTitleChange,
    onContextMenu,
    onOpenTaskDetails,
    onRetryFailed,
    onGeneratePlanAssets,
    planAssetsBusy = false,
    readOnly = false,
    onHoverStart,
    onHoverEnd,
}: {
    data: CanvasNodeData;
    dragOffset?: Position;
    childNodes: CanvasNodeData[];
    taskAnchor?: CanvasNodeData;
    productionRun?: AgentRun;
    renderLOD?: CanvasNodeRenderLOD;
    scale: number;
    isSelected: boolean;
    isDropTarget: boolean;
    onMouseDown: (event: ReactMouseEvent, nodeId: string) => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onResizeGesture?: (nodeId: string, phase: "start" | "end" | "cancel") => void;
    onToggleCollapsed: (nodeId: string) => void;
    onFolderStyleChange: (nodeId: string, style: CanvasFolderStyle) => void;
    onFolderThemeChange?: (nodeId: string, theme: CanvasFolderTheme) => void;
    onTitleChange: (nodeId: string, title: string) => void;
    onContextMenu: (event: ReactMouseEvent, nodeId: string) => void;
    onOpenTaskDetails?: (node: CanvasNodeData) => void;
    onRetryFailed?: (frame: CanvasNodeData, failedNodes: CanvasNodeData[]) => void;
    onGeneratePlanAssets?: (targetNodeId: string) => void;
    planAssetsBusy?: boolean;
    readOnly?: boolean;
    onHoverStart?: (nodeId: string) => void;
    onHoverEnd?: (nodeId: string) => void;
}) {
    recordCanvasRender("frame", data.id);
    const theme = canvasThemes[useActiveTheme()];
    const collapsed = Boolean(data.metadata?.frame?.collapsed);
    const folder = isCanvasFolderNode(data);
    const [editing, setEditing] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [title, setTitle] = useState(data.title);
    const resizeCancelCleanup = useRef<(() => void) | null>(null);
    const resizeRef = useRef({
        active: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        minWidth: 360,
        nodeId: data.id,
        scale,
        childBounds: null as { left: number; top: number; right: number; bottom: number } | null,
        contentInset: data.metadata?.shortDrama?.role === "collection" ? 100 : FRAME_HEADER_HEIGHT + FRAME_PADDING,
        onResize,
        onResizeGesture,
    });

    useEffect(() => setTitle(data.title), [data.title]);

    const commitTitle = () => {
        const next = title.trim() || (folder ? "未命名文件夹" : "未命名背板");
        setTitle(next);
        setEditing(false);
        onTitleChange(data.id, next);
    };

    const childBounds = useMemo(() => {
        if (!childNodes.length) return null;
        const left = Math.min(...childNodes.map((node) => node.position.x));
        const top = Math.min(...childNodes.map((node) => node.position.y));
        const right = Math.max(...childNodes.map((node) => node.position.x + node.width));
        const bottom = Math.max(...childNodes.map((node) => node.position.y + node.height));
        return { left, top, right, bottom };
    }, [childNodes]);

    const handleResizeMove = useCallback(
        (event: MouseEvent) => {
            const state = resizeRef.current;
            if (!state.active) return;
            const dx = (event.clientX - state.startX) / state.scale;
            const dy = (event.clientY - state.startY) / state.scale;
            const fromLeft = state.corner.includes("left");
            const fromTop = state.corner.includes("top");
            const startRight = state.startLeft + state.startWidth;
            const startBottom = state.startTop + state.startHeight;
            let left = fromLeft ? Math.min(state.startLeft + dx, startRight - state.minWidth) : state.startLeft;
            let top = fromTop ? Math.min(state.startTop + dy, startBottom - 240) : state.startTop;
            let right = fromLeft ? startRight : Math.max(state.startLeft + state.minWidth, startRight + dx);
            let bottom = fromTop ? startBottom : Math.max(state.startTop + 240, startBottom + dy);

            if (state.childBounds) {
                if (fromLeft) left = Math.min(left, state.childBounds.left - FRAME_PADDING);
                else right = Math.max(right, state.childBounds.right + FRAME_PADDING);
                if (fromTop) top = Math.min(top, state.childBounds.top - state.contentInset);
                else bottom = Math.max(bottom, state.childBounds.bottom + FRAME_PADDING);
            }
            state.onResize(state.nodeId, right - left, bottom - top, { x: left, y: top });
        },
        [],
    );

    const handleResizeUp = useCallback(() => {
        if (resizeRef.current.active) resizeRef.current.onResizeGesture?.(resizeRef.current.nodeId, "end");
        resizeRef.current.active = false;
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeUp);
        resizeCancelCleanup.current?.();
        resizeCancelCleanup.current = null;
    }, [handleResizeMove]);

    const cancelResize = useCallback(() => {
        if (resizeRef.current.active) resizeRef.current.onResizeGesture?.(resizeRef.current.nodeId, "cancel");
        resizeRef.current.active = false;
        handleResizeUp();
    }, [handleResizeUp]);

    useEffect(() => () => cancelResize(), [cancelResize]);

    const startResize = (event: ReactMouseEvent, corner: ResizeCorner) => {
        event.preventDefault();
        event.stopPropagation();
        resizeRef.current = {
            active: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            minWidth: folder ? 360 : Math.max(360, ...childNodes.filter(node => node.metadata?.shortDrama?.assetKey !== "$summary").map(node => (data.metadata?.shortDrama?.mediaGroup ? 280 : node.width) + FRAME_PADDING * 2)),
            nodeId: data.id,
            scale,
            childBounds: folder || childNodes.some(node => node.metadata?.locked) ? childBounds : null,
            contentInset: data.metadata?.shortDrama?.role === "collection" ? 100 : FRAME_HEADER_HEIGHT + FRAME_PADDING,
            onResize,
            onResizeGesture,
        };
        onResizeGesture?.(data.id, "start");
        window.addEventListener("mousemove", handleResizeMove);
        window.addEventListener("mouseup", handleResizeUp);
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelResize(); } };
        window.addEventListener("blur", cancelResize);
        window.addEventListener("keydown", onKey, true);
        resizeCancelCleanup.current = () => { window.removeEventListener("blur", cancelResize); window.removeEventListener("keydown", onKey, true); };
    };

    const active = isSelected || isDropTarget;
    const linkedFolder = Boolean(data.metadata?.folder?.assetFolderId);
    const fullDetail = renderLOD === "full" || hovered || editing;
    const collection = data.metadata?.shortDrama?.role === "collection" ? data.metadata.shortDrama : undefined;
    const progress = collection && !collection.assetGroup && !collection.mediaGroup && !collection.assetRevisionGroup ? episodeProgress(childNodes.filter((node) => collection.sourceNodeIds.includes(node.id)), collection.parameters?.episodeCount || childNodes.length) : undefined;
    const mediaMembers = collection?.mediaGroup || collection?.assetRevisionGroup ? childNodes.filter((node) => collection.sourceNodeIds.includes(node.id)) : [];
    const mediaComplete = mediaMembers.filter((node) => node.metadata?.status === "success" && (node.metadata.storageKey || node.metadata.content)).length;
    const mediaRunning = mediaMembers.filter((node) => node.metadata?.status === "loading").length;
    const mediaFailed = mediaMembers.filter((node) => node.metadata?.status === "error").length;
    const assetManifest = collection?.assetGroup ? taskAnchor || childNodes.find((node) => node.id === collection.assetGroup!.manifestId) : undefined;
    const planRoot = collection?.step === "story.plan" && !collection.planGroup;
    const assetCount = collection?.assetGroup ? planRoot ? productionPlanCanvasDocumentCount(data, childNodes)
        : childNodes.filter((node) => collection.sourceNodeIds.includes(node.id) && node.id !== collection.assetGroup!.manifestId).length : 0;
    const assetManifestData = assetManifest?.metadata?.shortDrama;
    const planAssetAction = productionPlanAssetAction(data, productionRun);
    const expectedAssetCount = collection?.assetGroup?.kind === "bible" ? collection.assetGroup.sections?.length || 2 : undefined;
    const groupTask = productionAssetGroupState(data, assetManifest, productionRun);
    const { active: assetTaskActive, failed: assetTaskFailed, complete: assetTaskComplete, warning: assetTaskWarning } = groupTask || productionTaskState(assetManifest, productionRun);
    const assetTaskLabel = groupTask?.label || (collection?.assetGroup
        ? assetTaskWarning
            ? `内容待处理 · 已生成 ${assetCount}${expectedAssetCount ? `/${expectedAssetCount}` : ""}`
            : assetTaskFailed
            ? `制作未完成 · 已生成 ${assetCount}${expectedAssetCount ? `/${expectedAssetCount}` : ""}`
            : assetTaskComplete
                ? `制作完成 · 已生成 ${assetCount}${expectedAssetCount ? `/${expectedAssetCount}` : ""}`
                : assetTaskActive
                    ? `${productionRun?.production?.concurrentItems?.join("、") || productionRun?.production?.currentItem || productionRun?.production?.phaseLabel || assetManifest?.metadata?.taskStage || "制作进行中"} · 已生成 ${assetCount}${expectedAssetCount ? `/${expectedAssetCount}` : ""}`
                    : assetCount > 0
                        ? `已生成 ${assetCount}${expectedAssetCount ? `/${expectedAssetCount}` : ""} · 待核对`
                        : "等待生成"
        : "");
    const failedNodes = useMemo(() => {
        if (readOnly || folder || !onRetryFailed) return [];
        const scope = collection ? childNodes.filter((node) => collection.sourceNodeIds.includes(node.id)) : childNodes;
        const manifestId = collection?.assetGroup?.manifestId;
        return scope.filter((node) => node.id !== manifestId && node.metadata?.status === "error");
    }, [childNodes, collection, folder, onRetryFailed, readOnly]);
    const compactButtons = groupStatusButtonsCompact(data.width * scale);
    const retryFailedButton = onRetryFailed && failedNodes.length > 0 ? <button type="button" aria-label={`一键重试 ${failedNodes.length} 个失败任务`} title="一键重试失败任务"
        className="pointer-events-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-black/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 dark:hover:bg-white/10"
        style={{ color: theme.node.text, outlineColor: theme.frame.activeStroke }} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRetryFailed(data, failedNodes); }}>
        <RefreshCw className="size-3.5" aria-hidden="true" />{compactButtons ? <span>{failedNodes.length}</span> : <>重试失败 {failedNodes.length}</>}
    </button> : null;
    const collectionDetails = onOpenTaskDetails ? <button type="button" aria-label="查看分组任务详情" title="查看分组任务详情"
        className="pointer-events-auto inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-black/10 dark:hover:bg-white/10"
        style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onOpenTaskDetails(data); }}>
        <Info className="size-3.5" aria-hidden="true" /><span className={compactButtons ? "sr-only" : undefined}>详情</span>
    </button> : null;

    return (
        <div
            data-node-id={data.id}
            data-node-lod={fullDetail ? "full" : renderLOD}
            role={folder && collapsed ? "group" : undefined}
            tabIndex={folder && collapsed ? 0 : undefined}
            aria-label={folder && collapsed ? `${data.title}，文件夹，${childNodes.length} 项内容。按回车打开` : undefined}
            className={`absolute z-0 select-none${folder && collapsed ? " canvas-folder-node" : ""} ${dragOffset ? "cursor-grabbing" : "cursor-default"}`}
            style={{ transform: `translate(${data.position.x + (dragOffset?.x || 0)}px, ${data.position.y + (dragOffset?.y || 0)}px)`, width: data.width, height: data.height, contain: "layout style" }}
            onMouseDown={(event) => onMouseDown(event, data.id)}
            onDoubleClick={(event) => {
                if (!collapsed || (event.target instanceof Element && event.target.closest("button,input"))) return;
                event.stopPropagation();
                onToggleCollapsed(data.id);
            }}
            onContextMenu={(event) => onContextMenu(event, data.id)}
            onKeyDown={(event) => {
                if (!folder || !collapsed || (event.target instanceof Element && event.target.closest("button,input"))) return;
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onToggleCollapsed(data.id);
            }}
            onMouseEnter={() => { setHovered(true); onHoverStart?.(data.id); }}
            onMouseLeave={() => { setHovered(false); onHoverEnd?.(data.id); }}
        >
            {/* 帧节点同样禁用指针跟随 3D 位移，hover 使用 CSS 静态抬升 */}
            <CometCard
                containerClassName="h-full w-full"
                className={folder && collapsed ? "canvas-folder-shell overflow-visible" : `canvas-frame-shell overflow-hidden rounded-[var(--dock-radius)] border${folder ? " canvas-folder-expanded" : ""}`}
                disabled
                data-canvas-frame-hover-locked={!collapsed || editing || Boolean(dragOffset) || scale < 0.32 ? "true" : "false"}
                style={{
                    background: folder && collapsed ? "transparent" : active ? theme.frame.activeFill : theme.frame.fill,
                    borderColor: folder && collapsed ? "transparent" : active ? theme.frame.activeStroke : theme.frame.stroke,
                    borderWidth: folder && collapsed ? 0 : 1 / Math.max(scale, 0.05),
                    boxShadow: !fullDetail || (folder && collapsed) ? "none" : isSelected ? `0 0 0 ${1 / Math.max(scale, 0.05)}px ${theme.frame.activeStroke}33, 0 24px 72px ${theme.spatial.shadow}` : `0 18px 54px ${theme.spatial.shadow}`,
                }}
            >
                {!fullDetail ? (
                    <div className="flex h-full items-center justify-center rounded-[var(--node-radius)]" style={{ background: theme.frame.fill, color: theme.node.text }}>
                        {data.title} · {childNodes.length}
                    </div>
                ) : folder && collapsed ? (
                    // 素材库目录是单一事实源；画布节点只负责浏览和调用，避免本地改名后被同步结果覆盖。
                    <CanvasFolderPreview
                        data={data}
                        childNodes={childNodes}
                        active={active}
                        isDropTarget={isDropTarget}
                        readOnly={readOnly || linkedFolder}
                        onToggleCollapsed={onToggleCollapsed}
                        onTitleChange={onTitleChange}
                        onStyleChange={onFolderStyleChange}
                        onThemeChange={onFolderThemeChange}
                    />
                ) : (
                    <>
                <div className="pointer-events-auto absolute inset-x-0 top-0 z-10 flex items-center gap-1.5 px-1.5" style={{ height: FRAME_HEADER_HEIGHT, color: theme.node.text }}>
                    <button
                        type="button"
                        className="grid size-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 dark:hover:bg-white/10"
                        style={{ outlineColor: theme.frame.activeStroke }}
                        aria-label={collapsed ? "展开背板" : "折叠背板"}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            onToggleCollapsed(data.id);
                        }}
                    >
                        {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                    </button>
                    {editing ? (
                        <input
                            autoFocus
                            className="h-7 min-w-0 flex-1 rounded border bg-transparent px-1.5 text-sm font-semibold outline-none"
                            style={{ borderColor: theme.frame.activeStroke, color: theme.node.text }}
                            value={title}
                            onChange={(event) => setTitle(event.target.value)}
                            onBlur={commitTitle}
                            onMouseDown={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                                if (event.key === "Enter") commitTitle();
                                if (event.key === "Escape") {
                                    setTitle(data.title);
                                    setEditing(false);
                                }
                            }}
                        />
                    ) : (
                        <button
                            type="button"
                            className="min-w-0 truncate text-left text-sm font-semibold"
                            title={data.title}
                            onDoubleClick={(event) => {
                                event.stopPropagation();
                                if (readOnly) return;
                                setEditing(true);
                            }}
                        >
                            {data.title}
                        </button>
                    )}
                    <span className="ml-auto shrink-0 pr-1 text-[var(--fs-label)] tabular-nums" style={{ color: theme.node.muted }}>
                        {collection?.assetRevisionGroup ? `${mediaMembers.length} 项资产` : collection?.mediaGroup ? `${mediaMembers.length} 张图片` : collection?.assetGroup?.kind === "bible" ? `${assetCount}/${collection.assetGroup.sections?.length || 2} 项规范` : collection?.assetGroup ? `${assetCount} ${collection.step === "story.plan" && !collection.planGroup ? "份方案文稿" : "项资产"}` : collection && !collapsed ? `${collection.parameters?.episodeCount || childNodes.length} 集 · ${collection.parameters?.minutesPerEpisode || "待定"} 分钟/集` : childNodes.length}
                    </span>
                </div>

                {collection?.assetGroup ? <div aria-label="资产分组状态" className="pointer-events-auto absolute inset-x-3 flex min-w-0 items-center gap-1.5 text-[var(--fs-label)]" style={{ top: FRAME_HEADER_HEIGHT, color: theme.node.muted, lineHeight: "20px", overflowWrap: "anywhere" }}>
                    {assetTaskWarning ? <TriangleAlert className="size-3.5 shrink-0" style={{ color: "var(--status-warning)" }} aria-label="内容待处理" /> : assetTaskFailed ? <CircleAlert className="size-3.5 shrink-0" aria-hidden="true" /> : assetTaskComplete ? <Check className="size-3.5 shrink-0" aria-hidden="true" /> : assetTaskActive ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : null}
                    <span className="min-w-0 flex-1 truncate" style={assetTaskWarning ? { color: "var(--status-warning)" } : undefined} title={(assetTaskWarning ? assetManifest?.metadata?.generationWarning?.message : undefined) || assetManifest?.metadata?.errorDetails || assetTaskLabel}>{assetTaskLabel}</span>
                    {!planRoot ? retryFailedButton : null}
                    {!planRoot && assetManifest && onOpenTaskDetails && (assetTaskActive || assetTaskFailed || Boolean(assetManifestData?.productionAgent) || assetTaskComplete) ? <button
                        type="button"
                        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[var(--fs-label)] transition-colors hover:bg-black/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 dark:hover:bg-white/10"
                        style={{ color: theme.node.text, outlineColor: theme.frame.activeStroke }}
                        title="查看制作任务详情"
                        aria-label="查看制作任务详情"
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            onOpenTaskDetails(data);
                        }}
                    ><Info className="size-3.5" aria-hidden="true" /><span className={compactButtons ? "sr-only" : undefined}>详情</span></button> : null}
                </div> : collection?.mediaGroup || collection?.assetRevisionGroup ? <div aria-label={collection.assetRevisionGroup ? "资产重做进度" : "图片容器进度"} className="pointer-events-none absolute inset-x-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--fs-label)]" style={{ top: FRAME_HEADER_HEIGHT, color: theme.node.muted, lineHeight: "20px", overflowWrap: "anywhere" }}>
                    <span className="min-w-0">已完成 {mediaComplete}/{mediaMembers.length} · 进行中 {mediaRunning} · 失败 {mediaFailed}</span>
                    {retryFailedButton}
                    {collectionDetails}
                </div> : collection && progress ? <div aria-label="分集容器进度" className="pointer-events-none absolute inset-x-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--fs-label)]" style={{ top: FRAME_HEADER_HEIGHT, color: theme.node.muted, lineHeight: "20px", overflowWrap: "anywhere" }}>
                    {collapsed ? <div className="basis-full">共 {progress.total} 集 · 每集 {collection.parameters?.minutesPerEpisode || "待定"} 分钟</div> : null}
                    <span className="min-w-0">{episodeProgressLabel(progress)}</span>
                    {retryFailedButton}
                    {collectionDetails}
                </div> : <>
                    {collapsed ? <FramePreview nodes={childNodes.filter((node) => node.id !== collection?.assetGroup?.manifestId)} frame={data} theme={theme} /> : null}
                    {retryFailedButton ? <div aria-label="失败任务操作" className="pointer-events-none absolute inset-x-3 z-10 flex items-center text-[var(--fs-label)]" style={{ top: FRAME_HEADER_HEIGHT, color: theme.node.muted, lineHeight: "20px" }}>
                        <span className="truncate">失败 {failedNodes.length}</span>
                        {retryFailedButton}
                    </div> : null}
                </>}
                    {planRoot && !collapsed && !readOnly ? <div className="pointer-events-auto absolute inset-x-3 bottom-2 flex items-center gap-1" data-canvas-no-zoom aria-label="制作方案操作">
                        {planAssetAction && onGeneratePlanAssets ? <span title={planAssetAction.reason}><CanvasNodeActionButton theme={theme} label="生成资产" icon={planAssetsBusy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Boxes className="size-3.5" />} primary disabled={!planAssetAction.ready || planAssetsBusy} onClick={() => { if (planAssetAction.targetNodeId) onGeneratePlanAssets(planAssetAction.targetNodeId); }} /></span> : null}
                        {onOpenTaskDetails ? <CanvasNodeActionButton theme={theme} label="详情" icon={<Info className="size-3.5" />} onClick={() => onOpenTaskDetails(data)} /> : null}
                        {onRetryFailed && failedNodes.length > 0 ? <CanvasNodeActionButton theme={theme} label={`重试失败 ${failedNodes.length}`} icon={<RefreshCw className="size-3.5" />} onClick={() => onRetryFailed(data, failedNodes)} /> : null}
                    </div> : null}
                    </>
                )}
            </CometCard>
            {!readOnly && !collapsed && isSelected && !data.metadata?.locked ? (
                <>
                    <ResizeHandle corner="top-left" scale={scale} theme={theme} onMouseDown={startResize} />
                    <ResizeHandle corner="top-right" scale={scale} theme={theme} onMouseDown={startResize} />
                    <ResizeHandle corner="bottom-left" scale={scale} theme={theme} onMouseDown={startResize} />
                    <ResizeHandle corner="bottom-right" scale={scale} theme={theme} onMouseDown={startResize} />
                </>
            ) : null}
        </div>
    );
});

function FramePreview({ nodes, frame, theme }: { nodes: CanvasNodeData[]; frame: CanvasNodeData; theme: CanvasTheme }) {
    const layout = useMemo(() => {
        if (!nodes.length) return [];
        const previewNodes = nodes.slice(0, 24);
        const left = Math.min(...previewNodes.map((node) => node.position.x));
        const top = Math.min(...previewNodes.map((node) => node.position.y));
        const right = Math.max(...previewNodes.map((node) => node.position.x + node.width));
        const bottom = Math.max(...previewNodes.map((node) => node.position.y + node.height));
        const width = Math.max(right - left, 1);
        const height = Math.max(bottom - top, 1);
        const previewWidth = Math.max(frame.width - 16, 1);
        const previewHeight = Math.max(frame.height - FRAME_HEADER_HEIGHT - 8, 1);
        const scale = Math.min(previewWidth / width, previewHeight / height);
        const offsetX = (previewWidth - width * scale) / 2;
        const offsetY = (previewHeight - height * scale) / 2;
        return previewNodes.map((node) => ({
            node,
            left: offsetX + (node.position.x - left) * scale,
            top: offsetY + (node.position.y - top) * scale,
            width: Math.max(node.width * scale, 12),
            height: Math.max(node.height * scale, 10),
        }));
    }, [frame.height, frame.width, nodes]);

    return (
        <div className="pointer-events-none absolute inset-x-2 bottom-2 overflow-hidden rounded-md" style={{ top: FRAME_HEADER_HEIGHT, background: theme.frame.preview }}>
            {layout.length ? (
                layout.map(({ node, ...style }) => {
                    return <div key={node.id} className="absolute overflow-hidden rounded-[var(--r-xs)] border" style={{ ...style, background: theme.node.fill, borderColor: theme.node.stroke }}>
                        {node.type === CanvasNodeType.Image && node.metadata?.content ? <CachedResourceImage storageKey={node.metadata.storageKey} src={node.metadata.content} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" draggable={false} /> : null}
                        {node.type === CanvasNodeType.Video ? <CanvasVideoPreviewImage node={node} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" draggable={false} fallback={<Video className="m-auto size-4 h-full opacity-40" />} /> : null}
                        {node.type === CanvasNodeType.Text ? <div className="line-clamp-3 p-1 text-[var(--fs-nano)] leading-[9px]" style={{ color: theme.node.text }}>{node.metadata?.content || node.title}</div> : null}
                        {node.type === CanvasNodeType.Script ? <div className="p-1 text-[var(--fs-nano)] leading-[9px]" style={{ color: theme.node.text }}>分镜脚本 · {node.metadata?.storyboard?.rows.length || 0} 镜</div> : null}
                    </div>;
                })
            ) : (
                <div className="grid h-full place-items-center text-[var(--fs-label)]" style={{ color: theme.node.faint }}>空背板</div>
            )}
        </div>
    );
}

function ResizeHandle({ corner, scale, theme, onMouseDown }: { corner: ResizeCorner; scale: number; theme: CanvasTheme; onMouseDown: (event: ReactMouseEvent, corner: ResizeCorner) => void }) {
    const inverseScale = 1 / Math.max(scale, 0.05);
    const size = 14 * inverseScale;
    const offset = -size / 2;
    const fromTop = corner.includes("top");
    const fromLeft = corner.includes("left");
    const cursor = corner === "top-left" || corner === "bottom-right" ? "nwse-resize" : "nesw-resize";

    return (
        <button
            type="button"
            aria-label="调整背板尺寸"
            className="pointer-events-auto absolute z-20 rounded-sm shadow-sm"
            style={{
                top: fromTop ? offset : undefined,
                bottom: fromTop ? undefined : offset,
                left: fromLeft ? offset : undefined,
                right: fromLeft ? undefined : offset,
                width: size,
                height: size,
                cursor,
                background: theme.frame.activeStroke,
                border: `${2 * inverseScale}px solid ${theme.canvas.background}`,
            }}
            onMouseDown={(event) => onMouseDown(event, corner)}
        />
    );
}
