import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { App, Button, Dropdown, Input, Modal, Tag, Tooltip } from "antd";
import type { MenuProps } from "antd";
import { Camera, Check, ChevronDown, ChevronRight, Ellipsis, Grid3x3, Images, Plus, SlidersHorizontal, UserRound } from "lucide-react";

import { canvasDockStyle } from "@/lib/canvas/canvas-aceternity-style";
import { ASSET_CATEGORY_OPTIONS } from "@/lib/asset-category";
import { canvasThemes } from "@/lib/canvas-theme";
import { resolveNodeToolbarPlacement, resolveToolbarTools, type NodeToolbarGroup, type ToolContext, type ToolbarHandlers } from "@/lib/canvas/tool-registry";
import { subscribeCanvasViewportVisibilityPreview } from "@/lib/canvas/canvas-live-viewport";
import { canvasNodeAssetCategory } from "@/lib/canvas/canvas-node-asset";
import type { ImageSplitParams } from "@/lib/canvas/canvas-image-data";
import { formatBytes, getDataUrlByteSize } from "@/lib/image-utils";
import { generationErrorMessage } from "@/lib/generation-error";
import { useCopyText } from "@/hooks/use-copy-text";
import { producedModelLabel } from "@/lib/canvas/produced-model";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata, type CanvasWorkspaceMode, type ViewportTransform } from "@/types/canvas";
import { buildImageToolbarTools } from "./canvas-image-toolbar-tools";
import { CanvasGridSplitPicker } from "./canvas-grid-split-picker";
import { getCanvasNodeScreenRect, isCanvasRectVisible, resolveCanvasOverlayScale } from "./canvas-workspace-overlays";

type CanvasNodeToolbarProps = {
    node: CanvasNodeData | null;
    viewport: ViewportTransform;
    containerRef: RefObject<HTMLDivElement | null>;
    onKeep: (nodeId: string) => void;
    onLeave: () => void;
    onInfo: (node: CanvasNodeData) => void;
    onEditText: (node: CanvasNodeData) => void;
    onDecreaseFont: (node: CanvasNodeData) => void;
    onIncreaseFont: (node: CanvasNodeData) => void;
    onToggleDialog: (node: CanvasNodeData) => void;
    onAnnotate: (node: CanvasNodeData) => void;
    onAnnotationEdit: (node: CanvasNodeData) => void;
    onTextEdit: (node: CanvasNodeData) => void;
    onGenerateImage: (node: CanvasNodeData) => void;
    onBatchGenerateImages: (node: CanvasNodeData) => void;
    onUpload: (node: CanvasNodeData) => void;
    onDownload: (node: CanvasNodeData) => void;
    onSaveAsset: (node: CanvasNodeData) => void;
    onMaskEdit: (node: CanvasNodeData) => void;
    onRemoveBackground: (node: CanvasNodeData) => void;
    onLayerDecomposition: (node: CanvasNodeData) => void;
    onEmotion: (node: CanvasNodeData) => void;
    onPortraitTexture: (node: CanvasNodeData) => void;
    onCrop: (node: CanvasNodeData) => void;
    onSplit: (node: CanvasNodeData, params: ImageSplitParams) => void;
    onUpscale: (node: CanvasNodeData) => void;
    onSuperResolve: (node: CanvasNodeData) => void;
    onAngle: (node: CanvasNodeData) => void;
    onLighting: (node: CanvasNodeData) => void;
    onPanorama: (node: CanvasNodeData) => void;
    onViewImage: (node: CanvasNodeData) => void;
    onExtractVideoFrames: (node: CanvasNodeData) => void;
    onExtractAudioFromVideo: (node: CanvasNodeData) => void;
    onTrimVideoSegments: (node: CanvasNodeData) => void;
    onSubtitles: (node: CanvasNodeData) => void;
    onTimeline: (node: CanvasNodeData) => void;
    extractingVideoFrames: boolean;
    extractingAudio: boolean;
    trimmingVideo: boolean;
    onReversePrompt: (node: CanvasNodeData) => void;
    onRetry: (node: CanvasNodeData) => void;
    onToggleFreeResize: (node: CanvasNodeData) => void;
    onToggleLocked: (node: CanvasNodeData) => void;
    onDelete: (node: CanvasNodeData) => void;
    onNineGrid: (node: CanvasNodeData, toolId: number, label: string, icon: string) => void;
    workspaceMode?: CanvasWorkspaceMode;
    scaleWithNode?: boolean;
    panelOpen?: boolean;
};

type CanvasAssetCategory = NonNullable<NonNullable<CanvasNodeData["metadata"]>["assetCategory"]>;

const assetCategoryOptions: Array<{ value: CanvasAssetCategory; label: string }> = ASSET_CATEGORY_OPTIONS;

type ToolbarTool = {
    section?: string;
    description?: string;
    id: string;
    label: string;
    icon: ReactNode;
    onClick: () => void;
    group: NodeToolbarGroup;
    order: number;
    active?: boolean;
    danger?: boolean;
    disabled?: boolean;
};

export function CanvasNodeToolbar({
    node,
    viewport,
    containerRef,
    onKeep,
    onLeave,
    onInfo,
    onEditText,
    onDecreaseFont,
    onIncreaseFont,
    onToggleDialog,
    onAnnotate,
    onAnnotationEdit,
    onTextEdit,
    onGenerateImage,
    onBatchGenerateImages,
    onUpload,
    onDownload,
    onSaveAsset,
    onMaskEdit,
    onRemoveBackground,
    onLayerDecomposition,
    onEmotion,
    onPortraitTexture,
    onCrop,
    onSplit,
    onUpscale,
    onSuperResolve,
    onAngle,
    onLighting,
    onPanorama,
    onViewImage,
    onExtractVideoFrames,
    onExtractAudioFromVideo,
    onTrimVideoSegments,
    onSubtitles,
    onTimeline,
    extractingVideoFrames,
    extractingAudio,
    trimmingVideo,
    onReversePrompt,
    onRetry,
    onToggleFreeResize,
    onToggleLocked,
    onDelete,
    onNineGrid,
    workspaceMode = "professional",
    scaleWithNode = false,
    panelOpen = false,
}: CanvasNodeToolbarProps) {
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [containerWidth, setContainerWidth] = useState(1000);
    const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
    const [attachedToPanel, setAttachedToPanel] = useState(false);
    const [nodeInViewport, setNodeInViewport] = useState(true);
    const toolbarRef = useRef<HTMLDivElement>(null);
    const nodeRef = useRef<CanvasNodeData | null>(node);
    nodeRef.current = node;
    const { message } = App.useApp();
    const copyText = useCopyText();
    const themeName = useActiveTheme();
    const theme = canvasThemes[themeName];
    const simpleMode = workspaceMode === "simple";

    useEffect(() => {
        setOpenMenuId(null);
    }, [node?.id]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const nodeId = node?.id;
        if (!nodeId || !container) {
            setAnchor(null);
            return;
        }
        let disposed = false;
        let queued = false;
        let containerRect = container.getBoundingClientRect();
        let toolbarWidth = toolbarRef.current?.offsetWidth || 0;
        let toolbarHeight = toolbarRef.current?.offsetHeight || 44;
        let liveViewport = viewport;
        let previousViewport = viewport;
        let lastNodeVisibility: boolean | null = null;
        let panel: HTMLElement | null = null;
        let observedNode: HTMLElement | null = null;
        let resizeObserver: ResizeObserver;
        const overlayRoot = container.closest<HTMLElement>("[data-canvas-editor]")
            || container.parentElement?.parentElement?.parentElement
            || container.parentElement
            || container.ownerDocument.body;
        const findNodeElement = () => {
            const currentNode = nodeRef.current;
            if (!currentNode) return null;
            const nextElement = container.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(currentNode.id)}"]`);
            return nextElement?.isConnected ? nextElement : null;
        };
        const findPanel = () => {
            const nextPanel = overlayRoot.querySelector<HTMLElement>(`[data-canvas-node-panel-id="${CSS.escape(nodeId)}"]`);
            if (nextPanel === panel) return panel;
            if (panel) resizeObserver.unobserve(panel);
            panel = nextPanel;
            if (panel) resizeObserver.observe(panel);
            return panel;
        };
        const observeNodeElement = (nextElement: HTMLElement | null) => {
            if (nextElement === observedNode) return;
            if (observedNode) resizeObserver.unobserve(observedNode);
            observedNode = nextElement;
            if (observedNode) resizeObserver.observe(observedNode);
        };
        const updateNodeVisibility = (nextViewport = liveViewport, nextElement = observedNode?.isConnected ? observedNode : findNodeElement()) => {
            const currentNode = nodeRef.current;
            const nodeRect = currentNode ? getCanvasNodeScreenRect(currentNode, nextViewport) : null;
            const visible = Boolean(nextElement?.isConnected && nodeRect && isCanvasRectVisible(nodeRect, {
                left: 0,
                top: 0,
                right: containerRect.width,
                bottom: containerRect.height,
                width: containerRect.width,
                height: containerRect.height,
            }));
            lastNodeVisibility = visible;
            setNodeInViewport((current) => current === visible ? current : visible);
            return visible;
        };
        const update = () => {
            const currentNode = nodeRef.current;
            const element = findNodeElement();
            observeNodeElement(element);
            if (!currentNode || !element) {
                setNodeInViewport(false);
                setAnchor(null);
                setAttachedToPanel(false);
                return;
            }
            const scale = resolveCanvasOverlayScale(liveViewport.k, scaleWithNode);
            const activePanel = findPanel();
            const attached = Boolean(activePanel);
            const nodeRect = element.getBoundingClientRect();
            updateNodeVisibility(liveViewport, element);
            const panelRect = activePanel?.getBoundingClientRect() || null;
            const anchorRect = panelRect || nodeRect;
            const renderedToolbarWidth = toolbarWidth * scale;
            const renderedToolbarHeight = toolbarHeight * scale;
            const halfToolbar = renderedToolbarWidth / 2;
            const minLeft = containerRect.left + (renderedToolbarWidth > 0 ? halfToolbar + 10 : 10);
            const maxLeft = containerRect.right - (renderedToolbarWidth > 0 ? halfToolbar + 10 : 10);
            const preferredLeft = anchorRect.left + anchorRect.width / 2;
            const left = Math.min(Math.max(preferredLeft, minLeft), Math.max(minLeft, maxLeft));
            const preferredTop = attached
                ? anchorRect.top - renderedToolbarHeight
                : anchorRect.top - renderedToolbarHeight - 8;
            const minTop = containerRect.top + 8;
            const maxTop = containerRect.bottom - renderedToolbarHeight - 8;
            const top = Math.min(Math.max(preferredTop, minTop), Math.max(minTop, maxTop));
            if (toolbarRef.current) {
                toolbarRef.current.style.width = activePanel ? `${activePanel.offsetWidth}px` : "max-content";
                toolbarRef.current.style.maxWidth = `${Math.max(0, containerRect.width - 20) / scale}px`;
                toolbarRef.current.style.left = `${left}px`;
                toolbarRef.current.style.top = `${top}px`;
                toolbarRef.current.style.transform = `translateX(-50%) scale(${scale})`;
                toolbarRef.current.style.transformOrigin = "center top";
                toolbarRef.current.dataset.attachedPanel = attached ? "true" : "false";
                setAttachedToPanel((current) => current === attached ? current : attached);
                return;
            }
            setAnchor((current) => current?.left === left && current.top === top ? current : { left, top });
        };
        const scheduleUpdate = () => {
            if (queued || disposed) return;
            queued = true;
            queueMicrotask(() => {
                queued = false;
                if (!disposed) update();
            });
        };
        const measure = () => {
            containerRect = container.getBoundingClientRect();
            toolbarWidth = toolbarRef.current?.offsetWidth || 0;
            toolbarHeight = toolbarRef.current?.offsetHeight || 44;
            findPanel();
            setContainerWidth(containerRect.width);
            scheduleUpdate();
        };
        resizeObserver = new ResizeObserver(measure);
        measure();
        resizeObserver.observe(container);
        if (toolbarRef.current) resizeObserver.observe(toolbarRef.current);
        findPanel();
        const unsubscribeViewport = subscribeCanvasViewportVisibilityPreview(container, (nextViewport) => {
            const verticalChanged = Math.abs(nextViewport.y - previousViewport.y) > 0.5;
            const scaleChanged = Math.abs(nextViewport.k - previousViewport.k) > 0.001;
            liveViewport = nextViewport;
            previousViewport = nextViewport;
            // 横向双指滑动主要用于查看相邻内容，不让固定工具栏随
            // x 轴预览漂移；纵向移动和缩放仍然重新贴合节点/面板。
            if (verticalChanged || scaleChanged) scheduleUpdate();
            else {
                const wasVisible = lastNodeVisibility;
                const visible = updateNodeVisibility(nextViewport);
                if (visible && wasVisible === false) scheduleUpdate();
            }
        });
        const mutationObserver = new MutationObserver(scheduleUpdate);
        mutationObserver.observe(overlayRoot, { childList: true, subtree: true });
        window.addEventListener("resize", measure);
        return () => {
            disposed = true;
            resizeObserver.disconnect();
            mutationObserver.disconnect();
            unsubscribeViewport();
            window.removeEventListener("resize", measure);
        };
    }, [containerRef, node?.height, node?.id, node?.position.x, node?.position.y, node?.width, panelOpen, scaleWithNode, viewport.k, viewport.y]);

    if (!node || !anchor || !nodeInViewport) return null;

    const isImage = node.type === CanvasNodeType.Image;
    const isVideo = node.type === CanvasNodeType.Video;
    const isAudio = node.type === CanvasNodeType.Audio;
    const hasImage = isImage && Boolean(node.metadata?.content);
    const copyImagePrompt = (target: CanvasNodeData) => {
        const prompt = target.metadata?.prompt?.trim();
        if (!prompt) {
            message.warning("暂无可复制的提示词");
            return;
        }
        copyText(prompt, "提示词已复制");
    };
    const imageTools = buildImageToolbarTools(node, { onUpload, onToggleFreeResize, onAnnotate, onAnnotationEdit, onTextEdit, onMaskEdit, onRemoveBackground, onLayerDecomposition, onEmotion, onPortraitTexture, onCrop, onUpscale, onSuperResolve, onAngle, onLighting, onPanorama, onViewImage, onCopyPrompt: copyImagePrompt, onReversePrompt, onNineGrid });

    // 构建 ToolContext——供注册表解析工具
    const nodeHoverHandlers = {
        onNodeInfo: onInfo, onNodeDelete: onDelete, onNodeRetry: onRetry, onNodeEditText: onEditText, onNodeDecreaseFont: onDecreaseFont, onNodeIncreaseFont: onIncreaseFont,
        onNodeToggleDialog: onToggleDialog, onNodeAnnotate: onAnnotate, onNodeGenerateImage: onGenerateImage, onNodeBatchGenerateImages: onBatchGenerateImages, onNodeUpload: onUpload, onNodeDownload: onDownload,
        onNodeSaveAsset: onSaveAsset, onNodeMaskEdit: onMaskEdit, onNodeRemoveBackground: onRemoveBackground, onNodeEmotion: onEmotion, onNodePortraitTexture: onPortraitTexture, onNodeCrop: onCrop,
        onNodeSplit: (target) => onSplit(target, { rows: 2, columns: 2 }), onNodeUpscale: onUpscale, onNodeSuperResolve: onSuperResolve, onNodeAngle: onAngle, onNodeViewImage: onViewImage,
        onNodeExtractVideoFrames: onExtractVideoFrames, onNodeExtractAudioFromVideo: onExtractAudioFromVideo, onNodeTrimVideoSegments: onTrimVideoSegments, onNodeReversePrompt: onReversePrompt, onNodeToggleFreeResize: onToggleFreeResize,
        onNodeSubtitles: onSubtitles, onNodeTimeline: onTimeline, onNodeToggleLocked: onToggleLocked, onNodeCopyPrompt: copyImagePrompt,
    } as Partial<ToolbarHandlers> as ToolbarHandlers;

    const nodeHoverCtx: ToolContext = {
        selectedCount: 0,
        selectedNodeTypes: new Set(),
        selectedVideoCount: 0,
        canvasTool: "move",
        workspaceMode: workspaceMode || "professional",
        isProjectLinked: false,
        canUndo: false,
        canRedo: false,
        node,
        nodeMetadata: node.metadata,
        extractingVideoFrames,
        extractingAudio,
        trimmingVideo,
        mergingVideos: false,
        addPanelOpen: false,
        appearancePanelOpen: false,
        settingsPanelOpen: false,
        handlers: nodeHoverHandlers,
    };

    // 注册表统一提供动作合同、适用性和节点 Dock 层级。
    const registryTools = resolveToolbarTools("node-hover", nodeHoverCtx, null);
    const registryToolbarTools: ToolbarTool[] = registryTools.map((tool) => {
        const placement = resolveNodeToolbarPlacement(tool, nodeHoverCtx);
        return {
            id: tool.id,
            label: tool.displayLabel ? (typeof tool.displayLabel === "function" ? tool.displayLabel(nodeHoverCtx) : tool.displayLabel) : (typeof tool.label === "function" ? tool.label(nodeHoverCtx) : tool.label),
            icon: typeof tool.icon === "function" ? tool.icon(nodeHoverCtx) : tool.icon,
            group: placement.group,
            order: placement.order,
            section: tool.nodeToolbar?.section,
            description: tool.nodeToolbar?.description,
            active: tool.active?.(nodeHoverCtx),
            danger: tool.danger,
            disabled: tool.disabled?.(nodeHoverCtx),
            onClick: () => tool.run(nodeHoverCtx),
        };
    });
    const allTools: ToolbarTool[] = hasImage && !simpleMode
        ? [...registryToolbarTools, ...imageTools]
        : registryToolbarTools;
    const compact = containerWidth < 640;
    const narrow = containerWidth < 420;
    const inGroup = (group: NodeToolbarGroup) => allTools.filter((tool) => tool.group === group).sort(compareToolbarTools);
    const primary = inGroup("primary");
    const primaryTools = narrow ? primary.slice(0, 1) : primary;
    const portraitTools = compact ? [] : inGroup("portrait");
    const viewpointLightingTools = compact ? [] : [...inGroup("viewpoint"), ...inGroup("lighting")];
    const panoramaTools = compact ? [] : inGroup("panorama");
    const processTools = compact ? [...inGroup("portrait"), ...inGroup("viewpoint"), ...inGroup("lighting"), ...inGroup("panorama"), ...inGroup("process")] : inGroup("process");
    const nineGridTools = compact ? [] : inGroup("nine_grid");
    const workspaceTools = narrow ? [] : inGroup("workspace");
    const utilityTools = inGroup("utility");
    const moreTools = [...(narrow ? [...primary.slice(1), ...inGroup("workspace")] : []), ...inGroup("more")];
    const processMenuLabel = compact ? "工具" : isVideo ? "提取素材" : isImage ? "图片工具" : isAudio ? "音频处理" : "文本调整";
    const handleMenuOpenChange = (menuId: string, open: boolean) => {
        setOpenMenuId((current) => open ? menuId : current === menuId ? null : current);
        if (open) onKeep(node.id);
        else if (!toolbarRef.current?.contains(document.activeElement)) onLeave();
    };
    const dockStyle = canvasDockStyle(theme, theme.node.text);
    const overlayScale = resolveCanvasOverlayScale(viewport.k, scaleWithNode);

    return (
        <div
            ref={toolbarRef}
            className={`canvas-node-toolbar fixed z-[var(--z-node-toolbar)] ${attachedToPanel ? "is-attached-to-panel" : ""}`}
            style={{ left: anchor.left, top: anchor.top, width: "max-content", maxWidth: "calc(100% - 20px)", color: theme.node.text, transform: `translateX(-50%) scale(${resolveCanvasOverlayScale(viewport.k, scaleWithNode)})`, transformOrigin: "center top" }}
            onMouseEnter={() => onKeep(node.id)}
            onMouseLeave={() => { if (!openMenuId) onLeave(); }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            data-canvas-no-zoom
            onKeyDown={(event) => event.stopPropagation()}
            onFocus={() => onKeep(node.id)}
            onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && !openMenuId) onLeave(); }}
        >
            <div
                role="toolbar"
                aria-label="节点快捷工具"
                className="flex h-11 max-w-full items-center gap-0.5 overflow-visible rounded-[var(--dock-radius-tight)] px-2 backdrop-blur-2xl"
                style={{ ...dockStyle, border: 0 }}
            >
                {primaryTools.map((tool) => <NodeDockToolButton key={tool.id} tool={tool} />)}
                {nineGridTools.length ? <NodeDockMenuButton menuId="nine-grid" label="九宫格" icon={<Grid3x3 className="size-3.5" />} tools={nineGridTools} openMenuId={openMenuId} onOpenChange={handleMenuOpenChange} popupScale={overlayScale} /> : null}
                {panoramaTools.map((tool) => <NodeDockToolButton key={tool.id} tool={tool} />)}
                {portraitTools.length ? <NodeDockMenuButton menuId="portrait" label="人像调整" icon={<UserRound className="size-3.5" />} tools={portraitTools} openMenuId={openMenuId} onOpenChange={handleMenuOpenChange} popupScale={overlayScale} /> : null}
                {viewpointLightingTools.length ? <NodeDockMenuButton menuId="viewpoint-lighting" label="视角" icon={<Camera className="size-3.5" />} tools={viewpointLightingTools} openMenuId={openMenuId} onOpenChange={handleMenuOpenChange} popupScale={overlayScale} /> : null}
                {processTools.length ? <NodeDockMenuButton menuId="process" label={processMenuLabel} icon={isVideo ? <Images className="size-3.5" /> : <SlidersHorizontal className="size-3.5" />} tools={processTools} openMenuId={openMenuId} onOpenChange={handleMenuOpenChange} popupScale={overlayScale} split={hasImage && !simpleMode ? { node, onSplit } : undefined} /> : null}
                {workspaceTools.length ? <span aria-hidden className="aceternity-dock-separator mx-1 h-5 w-px shrink-0" /> : null}
                {workspaceTools.map((tool) => <NodeDockToolButton key={tool.id} tool={tool} />)}
                {utilityTools.length || moreTools.length ? <span aria-hidden className="aceternity-dock-separator mx-1 h-5 w-px shrink-0" /> : null}
                {utilityTools.map((tool) => <NodeDockToolButton key={tool.id} tool={tool} iconOnly />)}
                {moreTools.length ? (
                    <NodeDockMenuButton menuId="more" label="更多" icon={<Ellipsis className="size-3.5" />} tools={moreTools} openMenuId={openMenuId} onOpenChange={handleMenuOpenChange} placement="topRight" iconOnly popupScale={overlayScale} />
                ) : null}
            </div>
        </div>
    );
}

function NodeDockToolButton({ tool, iconOnly = false }: { tool: ToolbarTool; iconOnly?: boolean }) {
    return (
        <Tooltip title={tool.description ? `${tool.label}：${tool.description}` : tool.label}>
        <button
            type="button"
            className={`aceternity-dock-command is-labeled pointer-events-auto inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[var(--dock-item-radius)] px-2.5 outline-none ${tool.active ? "is-active" : ""} ${tool.danger ? "is-danger" : ""}`}
            aria-label={tool.label}
            aria-pressed={tool.active}
            disabled={tool.disabled}
            onClick={tool.onClick}
        >
            <span className="grid size-3.5 shrink-0 place-items-center">{tool.icon}</span>
            {!iconOnly ? <span className="inline-flex h-4 items-center whitespace-nowrap text-[var(--fs-label)] font-medium leading-none">{tool.label}</span> : null}
        </button>
        </Tooltip>
    );
}

function compareToolbarTools(left: ToolbarTool, right: ToolbarTool) {
    if (left.danger !== right.danger) return left.danger ? 1 : -1;
    return left.order - right.order;
}

function NodeDockMenuButton({ menuId, label, icon, tools, openMenuId, onOpenChange, placement = "top", iconOnly = false, popupScale = 1, split }: { menuId: string; label: string; icon: ReactNode; tools: ToolbarTool[]; openMenuId: string | null; onOpenChange: (menuId: string, open: boolean) => void; placement?: "top" | "topRight"; iconOnly?: boolean; popupScale?: number; split?: { node: CanvasNodeData; onSplit: (node: CanvasNodeData, params: ImageSplitParams) => void } }) {
    const open = openMenuId === menuId;
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [splitPanelOpen, setSplitPanelOpen] = useState(false);
    useEffect(() => {
        if (!open) {
            setSplitPanelOpen(false);
            return;
        }
        const frame = requestAnimationFrame(() => triggerRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [open]);
    const keepSplitMenuOpenRef = useRef(false);
    const splitEntry = split ? tools.find((tool) => tool.id === "split") : undefined;
    const sections = new Map<string, ToolbarTool[]>();
    for (const tool of tools) {
        const section = tool.danger ? "危险操作" : tool.section || "常用操作";
        sections.set(section, [...(sections.get(section) || []), tool]);
    }
    const items: MenuProps["items"] = [...sections].sort(([left], [right]) => Number(left === "危险操作") - Number(right === "危险操作")).map(([section, entries]) => ({
        type: "group", key: section, label: section,
        children: entries.map((tool) => {
            const isSplit = Boolean(splitEntry && split && tool.id === "split");
            return {
                key: tool.id,
                icon: tool.icon,
                className: isSplit ? `canvas-grid-split-menu-item${splitPanelOpen ? " is-open" : ""}` : undefined,
                label: (
                    <div
                        className={isSplit ? "canvas-grid-split-menu-label" : undefined}
                        onMouseDown={isSplit ? () => { keepSplitMenuOpenRef.current = true; } : undefined}
                    >
                        <div>
                            <span className="inline-flex items-center gap-2">{tool.label}{tool.active ? <Check className="size-3.5" /> : null}</span>
                            {tool.description ? <div className="text-[var(--fs-tiny)] opacity-60">{tool.description}</div> : null}
                        </div>
                        {isSplit ? <ChevronRight className="canvas-grid-split-chevron" strokeWidth={2} /> : null}
                    </div>
                ),
                disabled: tool.disabled,
                danger: tool.danger,
                onClick: (info) => {
                    if (isSplit) {
                        info.domEvent.preventDefault();
                        info.domEvent.stopPropagation();
                        keepSplitMenuOpenRef.current = true;
                        setSplitPanelOpen((current) => !current);
                        return;
                    }
                    onOpenChange(menuId, false);
                    tool.onClick();
                },
            };
        }),
    }));
    return (
        <Dropdown
            open={open}
            trigger={["click"]}
            placement={placement}
            onOpenChange={(nextOpen) => {
                if (!nextOpen && (keepSplitMenuOpenRef.current || document.querySelector(".canvas-node-toolbar-menu-split:hover, .canvas-grid-split-picker:hover"))) {
                    keepSplitMenuOpenRef.current = false;
                    return;
                }
                onOpenChange(menuId, nextOpen);
                if (!nextOpen) setSplitPanelOpen(false);
            }}
            menu={{ items }}
            autoFocus
            popupRender={(menu) => (
                <div
                    className={`canvas-node-toolbar-menu${splitEntry && split ? " canvas-node-toolbar-menu-split" : ""}`}
                    style={{
                        transform: `scale(${popupScale})`,
                        transformOrigin: placement === "topRight" ? "bottom right" : "bottom center",
                    }}
                    data-canvas-no-zoom
                    data-canvas-wheel-scroll
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                    onKeyDownCapture={(event) => {
                        if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            triggerRef.current?.focus();
                            onOpenChange(menuId, false);
                        }
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                >
                    <div className="canvas-node-toolbar-menu-stack">
                        {menu}
                    </div>
                    {splitPanelOpen && split ? (
                        <CanvasGridSplitPicker
                            onPick={(params) => {
                                setSplitPanelOpen(false);
                                onOpenChange(menuId, false);
                                split.onSplit(split.node, params);
                            }}
                        />
                    ) : null}
                </div>
            )}
        >
            <button
                ref={triggerRef}
                type="button"
                className={`aceternity-dock-command is-labeled pointer-events-auto inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[var(--dock-item-radius)] px-2.5 outline-none ${open ? "is-active" : ""}`}
                aria-label={label}
                aria-expanded={open}
                aria-haspopup="menu"
                title={label}
                onKeyDown={(event) => {
                    if (event.key === "ArrowDown" && open) {
                        event.preventDefault();
                        document.querySelector<HTMLElement>(".ant-dropdown:not(.ant-dropdown-hidden) .canvas-node-toolbar-menu [role='menuitem']:not([aria-disabled='true'])")?.focus();
                    }
                    if (event.key === "Escape" && open) {
                        event.preventDefault();
                        event.stopPropagation();
                        onOpenChange(menuId, false);
                    }
                }}
            >
                <span className="grid size-3.5 shrink-0 place-items-center">{icon}</span>
                {!iconOnly ? <><span className="inline-flex h-4 items-center whitespace-nowrap text-[var(--fs-label)] font-medium leading-none">{label}</span><ChevronDown className="size-3 shrink-0 opacity-55" /></> : null}
            </button>
        </Dropdown>
    );
}

export function CanvasNodeInfoModal({ node, open, onClose, onMetadataChange, readOnly = false, onUnauthorized }: { node: CanvasNodeData | null; open: boolean; onClose: () => void; onMetadataChange?: (nodeId: string, metadata: Partial<CanvasNodeMetadata>) => void; readOnly?: boolean; onUnauthorized?: () => void }) {
    const theme = canvasThemes[useActiveTheme()];
    const config = useEffectiveConfig();
    const [assetTags, setAssetTags] = useState<string[]>([]);
    const [assetTagInput, setAssetTagInput] = useState("");
    const [assetCategory, setAssetCategory] = useState<CanvasAssetCategory>("other");
    const imageBytes = node?.type === CanvasNodeType.Image && node.metadata?.content ? getDataUrlByteSize(node.metadata.content) : 0;
    const batchCount = node?.type === CanvasNodeType.Image ? node.metadata?.batchChildIds?.length || 0 : 0;
    const nodeTypeLabel = node?.type === CanvasNodeType.Text ? "文本" : node?.type === CanvasNodeType.Script ? "分镜脚本" : node?.type === CanvasNodeType.Skill ? "技能" : node?.type === CanvasNodeType.Image ? "图片" : node?.type === CanvasNodeType.Video ? "视频" : node?.type === CanvasNodeType.Audio ? "音频" : node?.type === CanvasNodeType.Drawing ? "绘图" : node?.type === CanvasNodeType.Frame ? "背板" : "生成配置";
    useEffect(() => {
        setAssetTags(node?.metadata?.assetTags || []);
        setAssetTagInput("");
        setAssetCategory(node ? canvasNodeAssetCategory(node) : "other");
    }, [node?.id, node?.metadata?.assetCategory, node?.metadata?.assetTags]);

    const saveAssetCategory = (category: CanvasAssetCategory) => {
        if (!node || node.type !== CanvasNodeType.Image) return;
        setAssetCategory(category);
        onMetadataChange?.(node.id, { assetCategory: category });
    };

    const saveAssetTags = (nextTags: string[]) => {
        if (!node || node.type !== CanvasNodeType.Image) return;
        const tags = Array.from(new Set(nextTags.map((item) => item.trim()).filter(Boolean)));
        setAssetTags(tags);
        onMetadataChange?.(node.id, { assetTags: tags });
    };

    const addAssetTag = () => {
        const tags = assetTagInput
            .split(/\n|,|，/)
            .map((item) => item.trim())
            .filter(Boolean);
        if (!tags.length) return;
        saveAssetTags([...assetTags, ...tags]);
        setAssetTagInput("");
    };

    const removeAssetTag = (tag: string) => {
        saveAssetTags(assetTags.filter((item) => item !== tag));
    };

    const title = (
        <div className="canvas-node-inspector-title">
            <div className="min-w-0">
                <div className="text-[var(--fs-heading-lg)] font-semibold">节点信息</div>
                {node ? <div className="canvas-node-inspector-id">{node.id}</div> : null}
            </div>
        </div>
    );

    return (
        <Modal
            className="workspace-modal canvas-node-info-modal"
            title={title}
            open={open && Boolean(node)}
            centered
            footer={null}
            onCancel={onClose}
            width="min(920px, calc(100vw - 32px))"
            styles={{ body: { paddingTop: 4 } }}
        >
            {node ? (
                <div className="canvas-node-inspector" style={{ color: theme.node.text }}>
                        <div className="thin-scrollbar canvas-node-inspector-scroll">
                            <section className="canvas-node-inspector-section">
                                <div className="canvas-node-inspector-section-heading"><span>基础信息</span><em>{node.metadata?.status || "idle"}</em></div>
                                <div className="canvas-node-inspector-facts">
                                    <InfoRow label="类型" value={nodeTypeLabel} />
                                    <InfoRow label="尺寸" value={`${Math.round(node.width)} x ${Math.round(node.height)}`} />
                                    <InfoRow label="位置" value={`${Math.round(node.position.x)}, ${Math.round(node.position.y)}`} />
                                    {batchCount > 1 ? <InfoRow label="图片组" value={`${batchCount} 张`} /> : null}
                                    {imageBytes ? <InfoRow label="图片大小" value={formatBytes(imageBytes)} /> : null}
                                </div>
                            </section>

                            {node.type === CanvasNodeType.Image ? (
                                <section className="canvas-node-inspector-section">
                                    <div className="canvas-node-inspector-section-heading"><span>项目资产分类</span></div>
                                    <div className="canvas-node-inspector-options">
                                        {assetCategoryOptions.map((option) => {
                                            const active = assetCategory === option.value;
                                            return <button key={option.value} type="button" disabled={readOnly} aria-pressed={active} onClick={() => saveAssetCategory(option.value)} className={active ? "is-active" : ""}>{option.label}</button>;
                                        })}
                                    </div>
                                    <p className="canvas-node-inspector-help">生成后会按此分类进入项目资产；角色、场景和画风工作流会自动预填。</p>
                                </section>
                            ) : null}

                            {node.metadata?.prompt ? (
                                <section className="canvas-node-inspector-section">
                                    <div className="canvas-node-inspector-section-heading"><span>提示词</span></div>
                                    <div className="canvas-node-inspector-copy canvas-node-inspector-prompt">{node.metadata.prompt}</div>
                                </section>
                            ) : null}

                            {nodeGenerationRows(node, producedModelLabel(config, node.metadata?.producedModel)).length ? (
                                <section className="canvas-node-inspector-section">
                                    <div className="canvas-node-inspector-section-heading"><span>生成信息</span></div>
                                    <div className="canvas-node-inspector-facts">
                                        {nodeGenerationRows(node, producedModelLabel(config, node.metadata?.producedModel)).map((item) => <InfoRow key={item.label} label={item.label} value={item.value} />)}
                                    </div>
                                </section>
                            ) : null}

                            {node.type === CanvasNodeType.Skill && node.metadata?.skillSnapshot ? (
                                <section className="canvas-node-inspector-section">
                                    <div className="canvas-node-inspector-section-heading"><span>技能模板</span></div>
                                    <div className="canvas-node-inspector-copy">{node.metadata.skillSnapshot.template}</div>
                                    {node.metadata.skillSnapshot.outputContract ? <><div className="canvas-node-inspector-subheading">输出约束</div><div className="canvas-node-inspector-copy">{node.metadata.skillSnapshot.outputContract}</div></> : null}
                                </section>
                            ) : null}

                            {node.type === CanvasNodeType.Image ? (
                                <section className="canvas-node-inspector-section">
                                    <div className="canvas-node-inspector-section-heading">
                                        <div>
                                            <span>资产标签</span>
                                            <p>一条标签描述一个角色、环境、道具或镜头用途。</p>
                                        </div>
                                        <em>{assetTags.length} 条</em>
                                    </div>
                                    {readOnly ? (
                                        <div className="canvas-node-inspector-notice">分享画布为只读，标签无法编辑。</div>
                                    ) : (
                                        <div className="canvas-node-inspector-tag-editor">
                                            <Input
                                                value={assetTagInput}
                                                placeholder="例如：角色: 张三"
                                                onChange={(event) => setAssetTagInput(event.target.value)}
                                                onPressEnter={addAssetTag}
                                            />
                                            <Button type="primary" icon={<Plus className="size-4" />} disabled={!assetTagInput.trim()} onClick={addAssetTag}>
                                                加入
                                            </Button>
                                        </div>
                                    )}
                                    <div className="canvas-node-inspector-tags">
                                        {assetTags.length ? (
                                            assetTags.map((tag) => (
                                                <Tag key={tag} closable={!readOnly} onClose={() => (readOnly ? onUnauthorized?.() : removeAssetTag(tag))} className="!m-0 !rounded-lg !px-2 !py-1 !text-sm">
                                                    {tag}
                                                </Tag>
                                            ))
                                        ) : (
                                            <span className="canvas-node-inspector-empty-label">{readOnly ? "暂无标签" : "还没有标签，输入后点击“加入”或按 Enter。"}</span>
                                        )}
                                    </div>
                                </section>
                            ) : null}

                            {node.metadata?.errorDetails ? (
                                <section className="canvas-node-inspector-error">
                                    {generationErrorMessage(node.metadata.errorDetails)}
                                </section>
                            ) : null}
                        </div>
                </div>
            ) : null}
        </Modal>
    );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="canvas-node-inspector-fact">
            <div>{label}</div>
            <strong>{value}</strong>
        </div>
    );
}

function nodeGenerationRows(node: CanvasNodeData, producedModelText: string) {
    const metadata = node.metadata;
    if (!metadata) return [] as Array<{ label: string; value: string }>;
    const rows: Array<{ label: string; value: string }> = [];
    const add = (label: string, value: unknown) => {
        if (value === undefined || value === null || value === "") return;
        rows.push({ label, value: String(value) });
    };
    const addTime = (label: string, value?: string) => {
        if (!value) return;
        const timestamp = Date.parse(value);
        add(label, Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value);
    };
    const addDuration = (value?: number) => {
        if (typeof value !== "number" || !Number.isFinite(value)) return;
        const totalSeconds = Math.max(0, Math.round(value / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        add("耗时", minutes ? `${minutes}分 ${seconds}秒` : `${seconds}秒`);
    };

    add("产出模型", producedModelText);
    add("生成尺寸", metadata.size);
    add("分辨率", metadata.vquality || metadata.quality);
    add("秒数", metadata.seconds ? `${metadata.seconds} 秒` : undefined);
    add("生成声音", metadata.generateAudio === undefined ? undefined : metadata.generateAudio === "true" ? "开启" : "关闭");
    add("水印", metadata.watermark === undefined ? undefined : metadata.watermark === "true" ? "开启" : "关闭");
    if (metadata.references?.length) {
        const referenceNames = metadata.references.slice(0, 3).map((reference) => reference.split("/").pop() || reference).join("、");
        add("引用素材", `${metadata.references.length} 个${referenceNames ? `（${referenceNames}${metadata.references.length > 3 ? "…" : ""}）` : ""}`);
    }
    addTime("创建时间", metadata.taskCreatedAt);
    addTime("开始时间", metadata.taskStartedAt);
    addTime("完成时间", metadata.taskCompletedAt);
    addDuration(metadata.taskDurationMs);
    return rows;
}
