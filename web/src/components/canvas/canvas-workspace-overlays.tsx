import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Clapperboard, Image as ImageIcon, List, Music2, Pencil, Table2, Video, WandSparkles, Workflow as WorkflowIcon } from "lucide-react";

import { useCanvasOverlayLayer } from "@/components/canvas/canvas-overlay-layer";
import { canvasThemes } from "@/lib/canvas-theme";
import { aceternityMotion } from "@/lib/aceternity-motion";
import { subscribeCanvasNodeDragPreview, subscribeCanvasViewportPreview, subscribeCanvasViewportVisibilityPreview } from "@/lib/canvas/canvas-live-viewport";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ConnectionHandle, type Position, type ViewportTransform } from "@/types/canvas";

export type PendingConnectionCreate = {
    connection: ConnectionHandle;
    position: Position;
    quick?: boolean;
    batchSourceNodeIds?: string[];
};

export function resolveCanvasOverlayScale(viewportScale: number, scaleWithNode: boolean) {
    // The world layer already owns the viewport transform. Overlay controls
    // are screen-space UI and must never apply that scale a second time.
    void viewportScale;
    void scaleWithNode;
    return 1;
}

export function getCanvasNodeScreenRect(node: CanvasNodeData, viewport: ViewportTransform, dragOffset?: Position | null) {
    const offsetX = dragOffset?.x || 0;
    const offsetY = dragOffset?.y || 0;
    const left = viewport.x + (node.position.x + offsetX) * viewport.k;
    const top = viewport.y + (node.position.y + offsetY) * viewport.k;
    return {
        left,
        top,
        right: left + node.width * viewport.k,
        bottom: top + node.height * viewport.k,
        width: node.width * viewport.k,
        height: node.height * viewport.k,
    };
}

export type CanvasRectBounds = Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">;

export function isCanvasRectVisible(rect: CanvasRectBounds, viewportRect: CanvasRectBounds) {
    return rect.width > 0
        && rect.height > 0
        && rect.right > viewportRect.left
        && rect.left < viewportRect.right
        && rect.bottom > viewportRect.top
        && rect.top < viewportRect.bottom;
}

export function CanvasSelectionToolbar({ anchorRef, containerRef, count, children }: { anchorRef: RefObject<HTMLDivElement | null>; containerRef: RefObject<HTMLDivElement | null>; count: number; children: ReactNode }) {
    const theme = canvasThemes[useActiveTheme()];
    const reducedMotion = useReducedMotion();
    const toolbarRef = useRef<HTMLDivElement>(null);
    const [anchor, setAnchor] = useState<{ left: number; top: number; placement: "above" | "below" } | null>(null);

    useLayoutEffect(() => {
        const element = anchorRef.current;
        const container = containerRef.current;
        if (!element || !container) {
            setAnchor(null);
            return;
        }

        const update = () => {
            const bounds = element.getBoundingClientRect();
            const containerBounds = container.getBoundingClientRect();
            const toolbarWidth = toolbarRef.current?.offsetWidth || 320;
            const toolbarHeight = toolbarRef.current?.offsetHeight || 38;
            const halfWidth = Math.min(toolbarWidth / 2, Math.max(0, containerBounds.width / 2 - 12));
            const center = bounds.left + bounds.width / 2;
            const left = Math.min(Math.max(center, containerBounds.left + 12 + halfWidth), Math.max(containerBounds.left + 12 + halfWidth, containerBounds.right - 12 - halfWidth));
            const placement = bounds.top - toolbarHeight - 8 >= containerBounds.top + 68 ? "above" : "below";
            const top = placement === "above" ? bounds.top - 8 : Math.min(bounds.bottom + 8, containerBounds.bottom - toolbarHeight - 12);
            if (toolbarRef.current) {
                toolbarRef.current.style.left = `${left}px`;
                toolbarRef.current.style.top = `${top}px`;
                toolbarRef.current.classList.toggle("-translate-y-full", placement === "above");
                return;
            }
            setAnchor((current) => (current?.left === left && current.top === top && current.placement === placement ? current : { left, top, placement }));
        };

        update();
        const resizeObserver = new ResizeObserver(update);
        resizeObserver.observe(element);
        resizeObserver.observe(container);
        if (toolbarRef.current) resizeObserver.observe(toolbarRef.current);
        const viewportLayer = element.parentElement;
        const mutationObserver = new MutationObserver(update);
        if (viewportLayer) mutationObserver.observe(viewportLayer, { attributes: true, attributeFilter: ["style"] });
        const unsubscribeViewport = subscribeCanvasViewportPreview(container, update);
        window.addEventListener("resize", update);
        return () => {
            resizeObserver.disconnect();
            mutationObserver.disconnect();
            unsubscribeViewport();
            window.removeEventListener("resize", update);
        };
    }, [anchorRef, containerRef, count]);

    if (!anchor) return null;
    return (
        <div
            ref={toolbarRef}
            data-canvas-no-zoom
            className={`fixed z-[var(--z-panel-floating)] max-w-[calc(100%_-_24px)] -translate-x-1/2 ${anchor.placement === "above" ? "-translate-y-full" : ""}`}
            style={{ left: anchor.left, top: anchor.top, color: theme.node.text, transformOrigin: anchor.placement === "above" ? "bottom center" : "top center" }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <motion.div
                initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: anchor.placement === "above" ? 8 : -8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={aceternityMotion.spring.panel}
                className="flex items-center gap-2"
            >
                <span
                    className="aceternity-floating-panel shrink-0 rounded-full border px-2.5 py-1.5 text-[var(--fs-tiny)] font-semibold tabular-nums backdrop-blur-2xl"
                    style={{ background: theme.spatial.elevated, borderColor: theme.toolbar.border, color: theme.accent.primary }}
                >
                    已选 {count}
                </span>
                <div className="max-w-[min(560px,calc(100vw-90px))]">{children}</div>
            </motion.div>
        </div>
    );
}

export function CanvasNodePanelOverlay({
    node,
    viewport,
    containerRef,
    panelWidth,
    panelHeight = 190,
    dragOffset,
    isDragging = false,
    allowOverflow = false,
    scaleWithNode = false,
    children,
}: {
    node: CanvasNodeData;
    viewport: ViewportTransform;
    containerRef: RefObject<HTMLDivElement | null>;
    panelWidth?: number;
    panelHeight?: number;
    dragOffset?: Position | null;
    isDragging?: boolean;
    allowOverflow?: boolean;
    scaleWithNode?: boolean;
    children: ReactNode;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    const { bringToFront, zIndex } = useCanvasOverlayLayer(`node-panel:${node.id}`, "var(--z-modal-overlay)");
    const initialWidth = resolveNodePanelWidth(node, viewport, panelWidth);

    useLayoutEffect(() => {
        bringToFront();
    }, [bringToFront]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const panel = panelRef.current;
        if (!container || !panel) return;
        let liveViewport = viewport;
        let liveDragOffset = dragOffset;
        let previousViewport = viewport;
        let lastNodeVisibility: boolean | null = null;
        let viewportSize = { width: container.clientWidth, height: container.clientHeight };
        let panelSize = { width: panel.offsetWidth || initialWidth, height: panel.offsetHeight || panelHeight };
        let observedNode: HTMLElement | null = null;
        const findNodeElement = () => {
            if (observedNode?.isConnected) return observedNode;
            observedNode = container.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`);
            return observedNode;
        };
        const updateVisibility = (nextViewport = liveViewport) => {
            const nodeRect = getCanvasNodeScreenRect(node, nextViewport, liveDragOffset);
            const nodeElement = findNodeElement();
            const visible = Boolean(nodeElement?.isConnected && isCanvasRectVisible(nodeRect, {
                left: 0,
                top: 0,
                right: viewportSize.width,
                bottom: viewportSize.height,
                width: viewportSize.width,
                height: viewportSize.height,
            }));
            lastNodeVisibility = visible;
            panel.style.visibility = visible ? "" : "hidden";
            panel.style.pointerEvents = visible ? "" : "none";
            panel.dataset.canvasNodeViewportVisible = visible ? "true" : "false";
            return visible;
        };
        const updatePosition = (nextViewport: ViewportTransform) => {
            liveViewport = nextViewport;
            const overlayScale = resolveCanvasOverlayScale(nextViewport.k, scaleWithNode);
            const requestedWidth = resolveNodePanelWidth(node, nextViewport, panelWidth);
            const nextWidth = Math.min(requestedWidth, Math.max(320, (viewportSize.width - 24) / overlayScale));
            if (panel.style.width !== `${nextWidth}px`) panel.style.width = `${nextWidth}px`;
            panel.style.maxHeight = allowOverflow ? "none" : `${Math.max(120, viewportSize.height - 84)}px`;
            const renderedWidth = panelSize.width || nextWidth;
            const renderedHeight = panelSize.height || panelHeight;
            const position = getAttachedNodePanelPosition(node, nextViewport, viewportSize, renderedWidth, renderedHeight, liveDragOffset, container.getBoundingClientRect());
            panel.style.transform = `translate3d(${position.left}px, ${position.top}px, 0)`;
            panel.style.transformOrigin = "top left";
            panel.style.setProperty("--canvas-node-panel-scale", "1");
            panel.dataset.scaleWithNode = "false";
            updateVisibility(nextViewport);
        };
        updatePosition(viewport);
        const resizeObserver = new ResizeObserver(() => {
            viewportSize = { width: container.clientWidth, height: container.clientHeight };
            panelSize = { width: panel.offsetWidth || initialWidth, height: panel.offsetHeight || panelHeight };
            updatePosition(liveViewport);
        });
        resizeObserver.observe(container);
        resizeObserver.observe(panel);
        const unsubscribeViewport = subscribeCanvasViewportVisibilityPreview(container, (nextViewport) => {
            const verticalChanged = Math.abs(nextViewport.y - previousViewport.y) > 0.5;
            const scaleChanged = Math.abs(nextViewport.k - previousViewport.k) > 0.001;
            liveViewport = nextViewport;
            previousViewport = nextViewport;
            const wasVisible = lastNodeVisibility;
            const visible = updateVisibility(nextViewport);
            if (verticalChanged || scaleChanged || (visible && wasVisible === false)) updatePosition(nextViewport);
        });
        const unsubscribeDrag = subscribeCanvasNodeDragPreview(container, (preview) => {
            liveDragOffset = preview?.nodeIds.has(node.id) ? { x: preview.x, y: preview.y } : null;
            updatePosition(liveViewport);
        });
        const mutationObserver = new MutationObserver(() => {
            const wasVisible = lastNodeVisibility;
            const visible = updateVisibility(liveViewport);
            if (visible && wasVisible === false) updatePosition(liveViewport);
        });
        mutationObserver.observe(container, { childList: true, subtree: true });
        const handlePanelWheel = (event: WheelEvent) => {
            event.stopPropagation();
            const target = event.target instanceof Element ? event.target : null;
            const horizontalIntent = Math.abs(event.deltaX) > Math.abs(event.deltaY);
            if (horizontalIntent && !target?.closest("[data-canvas-horizontal-scroll]")) event.preventDefault();
        };
        panel.addEventListener("wheel", handlePanelWheel, { capture: true, passive: false });
        return () => {
            resizeObserver.disconnect();
            unsubscribeViewport();
            unsubscribeDrag();
            mutationObserver.disconnect();
            panel.removeEventListener("wheel", handlePanelWheel, true);
        };
    }, [containerRef, dragOffset?.x, dragOffset?.y, isDragging, node.height, node.id, node.position.x, node.position.y, node.width, panelHeight, panelWidth, scaleWithNode, viewport.k, viewport.y]);

    return (
        <div
            ref={panelRef}
            data-canvas-no-zoom
            data-canvas-node-panel
            data-canvas-node-panel-id={node.id}
            className={`thin-scrollbar fixed max-w-[calc(100%_-_24px)] ${allowOverflow ? "overflow-visible" : "overflow-y-auto"}`}
            style={{ left: 0, top: 0, transform: "translate3d(0px, 0px, 0)", transformOrigin: "top left", width: initialWidth, maxHeight: allowOverflow ? "none" : "calc(100% - 84px)", zIndex }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDownCapture={bringToFront}
            onFocusCapture={bringToFront}
            onPointerDown={(event) => event.stopPropagation()}
        >
            {children}
        </div>
    );
}

function resolveNodePanelWidth(node: CanvasNodeData, viewport: ViewportTransform, requestedWidth?: number) {
    if (requestedWidth) return requestedWidth;
    // 节点面板是屏幕覆盖层，尺寸不能随画布缩放变化；viewport 只参与
    // 计算它相对于节点的屏幕位置。
    void viewport;
    return clamp(Math.round(node.width * 1.5), 680, 920);
}

export function CanvasConnectionCreateMenu({
    pending,
    viewport,
    viewportSize,
    containerRef,
    canCreateDrawing,
    getDisabledReason,
    onCreate,
    onClose,
}: {
    pending: PendingConnectionCreate;
    viewport: ViewportTransform;
    viewportSize: { width: number; height: number };
    containerRef: RefObject<HTMLDivElement | null>;
    canCreateDrawing: boolean;
    getDisabledReason: (
        type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Script | CanvasNodeType.BatchTable | CanvasNodeType.Video | CanvasNodeType.Audio | CanvasNodeType.Drawing | CanvasNodeType.Config | CanvasNodeType.MediaConversion,
        provider?: "runninghub",
    ) => string;
    onCreate: (
        type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Script | CanvasNodeType.BatchTable | CanvasNodeType.Video | CanvasNodeType.Audio | CanvasNodeType.Drawing | CanvasNodeType.Config | CanvasNodeType.MediaConversion,
        provider?: "runninghub",
    ) => void;
    onClose: () => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const reducedMotion = useReducedMotion();
    const menuRef = useRef<HTMLDivElement>(null);
    const [activeOption, setActiveOption] = useState<string | null>(null);
    const lastPointerRef = useRef<Position | null>(null);
    const { bringToFront, zIndex } = useCanvasOverlayLayer("connection-create-menu", "var(--z-modal-overlay)");
    const menuWidth = Math.min(288, viewportSize.width - 24);
    const menuHeight = canCreateDrawing ? 448 : 404;
    const gap = 12;
    const initialPosition = getConnectionMenuPosition(pending.position, viewport, viewportSize, menuWidth, menuHeight, gap);
    const containerBounds = containerRef.current?.getBoundingClientRect();
    const initialLeft = (containerBounds?.left || 0) + initialPosition.left;
    const initialTop = (containerBounds?.top || 0) + initialPosition.top;

    useLayoutEffect(() => {
        bringToFront();
    }, [bringToFront]);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const menu = menuRef.current;
        if (!container || !menu) return;
        const update = (nextViewport: ViewportTransform) => {
            const position = getConnectionMenuPosition(pending.position, nextViewport, viewportSize, menu.offsetWidth || menuWidth, menu.offsetHeight || menuHeight, gap);
            const containerBounds = container.getBoundingClientRect();
            menu.style.left = `${containerBounds.left + position.left}px`;
            menu.style.top = `${containerBounds.top + position.top}px`;
        };
        update(viewport);
        return subscribeCanvasViewportPreview(container, update);
    }, [containerRef, pending.position, viewport, viewportSize.height, viewportSize.width]);

    return (
        <motion.div
            ref={menuRef}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: aceternityMotion.duration.instant, ease: aceternityMotion.easing.enter }}
            className="thin-scrollbar fixed origin-top-left overflow-x-hidden overflow-y-auto rounded-[var(--r-2xl)] border p-2"
            data-canvas-no-zoom
            data-connection-create-menu
            aria-label="创建下一步"
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    event.stopPropagation();
                    onClose();
                }
            }}
            style={{ width: menuWidth, maxHeight: Math.max(120, viewportSize.height - 84), left: initialLeft, top: initialTop, zIndex, background: theme.spatial.elevated, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDownCapture={bringToFront}
            onFocusCapture={(event) => {
                bringToFront();
                const target = event.target instanceof Element ? event.target : null;
                if (target?.matches(":focus-visible")) setActiveOption(target.closest<HTMLElement>("[data-create-option]")?.dataset.createOption || null);
            }}
            onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setActiveOption(null);
            }}
            onPointerMove={(event) => {
                if (event.pointerType === "touch") return;
                const previous = lastPointerRef.current;
                // Layout changes can retarget a stationary pointer; only real movement selects a new row.
                if (previous?.x === event.clientX && previous.y === event.clientY) return;
                lastPointerRef.current = { x: event.clientX, y: event.clientY };
                const target = event.target instanceof Element ? event.target : null;
                const option = target?.closest<HTMLElement>("[data-create-option]")?.dataset.createOption;
                if (option) setActiveOption(option);
            }}
            onPointerLeave={() => {
                lastPointerRef.current = null;
                setActiveOption(null);
            }}
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="grid min-w-0 grid-cols-1 gap-1">
                <ConnectionCreateOption
                    expanded={activeOption === "文本生成"}
                    motionEnabled={!reducedMotion}
                    icon={<List className="size-4" />}
                    title="文本生成"
                    description="引用当前内容，生成或改写文本"
                    disabledReason={getDisabledReason(CanvasNodeType.Text)}
                    onClick={() => onCreate(CanvasNodeType.Text)}
                />
                <ConnectionCreateOption
                    expanded={activeOption === "分镜脚本"}
                    motionEnabled={!reducedMotion}
                    icon={<Clapperboard className="size-4" />}
                    title="分镜脚本"
                    description="根据剧情拆解镜头，编排分镜脚本"
                    disabledReason={getDisabledReason(CanvasNodeType.Script)}
                    onClick={() => onCreate(CanvasNodeType.Script)}
                />
                <ConnectionCreateOption
                    expanded={activeOption === "批量创作表"}
                    motionEnabled={!reducedMotion}
                    icon={<Table2 className="size-4" />}
                    title="批量创作表"
                    description="汇总多张图片，批量执行换装或创意生图"
                    disabledReason={getDisabledReason(CanvasNodeType.BatchTable)}
                    onClick={() => onCreate(CanvasNodeType.BatchTable)}
                />
                <ConnectionCreateOption
                    expanded={activeOption === "图片生成"}
                    motionEnabled={!reducedMotion}
                    icon={<ImageIcon className="size-4" />}
                    title="图片生成"
                    description="结合提示词和参考图，生成新的画面"
                    disabledReason={getDisabledReason(CanvasNodeType.Image)}
                    onClick={() => onCreate(CanvasNodeType.Image)}
                />
                <ConnectionCreateOption
                    expanded={activeOption === "生成配置"}
                    motionEnabled={!reducedMotion}
                    icon={<WorkflowIcon className="size-4" />}
                    title="生成配置"
                    description="选择模型，或使用已启用的工作流插件"
                    disabledReason={getDisabledReason(CanvasNodeType.Config)}
                    onClick={() => onCreate(CanvasNodeType.Config)}
                />
                {canCreateDrawing ? (
                    <ConnectionCreateOption
                        expanded={activeOption === "绘图"}
                        motionEnabled={!reducedMotion}
                        icon={<Pencil className="size-4" />}
                        title="绘图"
                        description="以参考图片为底图，自由绘制和标注"
                        disabledReason={getDisabledReason(CanvasNodeType.Drawing)}
                        onClick={() => onCreate(CanvasNodeType.Drawing)}
                    />
                ) : null}
                <ConnectionCreateOption
                    expanded={activeOption === "视频生成"}
                    motionEnabled={!reducedMotion}
                    icon={<Video className="size-4" />}
                    title="视频生成"
                    description="结合提示词与参考素材，生成动态视频"
                    disabledReason={getDisabledReason(CanvasNodeType.Video)}
                    onClick={() => onCreate(CanvasNodeType.Video)}
                />
                <ConnectionCreateOption
                    expanded={activeOption === "音频参考"}
                    motionEnabled={!reducedMotion}
                    icon={<Music2 className="size-4" />}
                    title="音频参考"
                    description="连接文本或角色卡，创建音频生成节点"
                    disabledReason={getDisabledReason(CanvasNodeType.Audio)}
                    onClick={() => onCreate(CanvasNodeType.Audio)}
                />
                <ConnectionCreateOption
                    expanded={activeOption === "转换"}
                    motionEnabled={!reducedMotion}
                    icon={<WandSparkles className="size-4" />}
                    title="转换"
                    description="本地处理图片或视频"
                    disabledReason={getDisabledReason(CanvasNodeType.MediaConversion)}
                    onClick={() => onCreate(CanvasNodeType.MediaConversion)}
                />
            </div>
        </motion.div>
    );
}

function ConnectionCreateOption({
    expanded,
    motionEnabled,
    icon,
    title,
    description,
    disabledReason,
    onClick,
}: {
    expanded: boolean;
    motionEnabled: boolean;
    icon: ReactNode;
    title: string;
    description: string;
    disabledReason?: string;
    onClick: () => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    return (
        <button
            type="button"
            aria-disabled={Boolean(disabledReason)}
            aria-label={title}
            aria-description={disabledReason || description}
            data-create-option={title}
            data-expanded={expanded}
            data-motion={motionEnabled ? "enabled" : "reduced"}
            className="canvas-connection-create-option group flex min-h-10 w-full cursor-pointer items-start gap-2 rounded-[var(--dock-item-radius)] px-2 py-1.5 text-left outline-none focus-visible:ring-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-40"
            style={{ color: theme.node.text, "--tw-ring-color": theme.node.muted, background: expanded ? theme.toolbar.itemHover : undefined } as CSSProperties}
            onClick={() => {
                if (!disabledReason) onClick();
            }}
        >
            <span className="grid size-7 shrink-0 place-items-center rounded-[var(--r-md)] opacity-65 transition-opacity group-hover:opacity-100 [&_svg]:size-3.5" style={{ background: theme.toolbar.itemHover }}>
                {icon}
            </span>
            <span className="min-w-0 flex-1 pt-1.5">
                <span className="flex items-center gap-2 text-[var(--fs-tiny)] font-semibold leading-4">{title}</span>
                <span aria-hidden="true" className="canvas-connection-create-description" style={{ color: theme.node.muted }}>
                    <span className="min-h-0 overflow-hidden">
                        <span className="block pt-1 whitespace-normal break-words text-[var(--fs-micro)] leading-relaxed">{disabledReason || description}</span>
                    </span>
                </span>
            </span>
        </button>
    );
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function getConnectionMenuPosition(position: Position, viewport: ViewportTransform, viewportSize: { width: number; height: number }, menuWidth: number, menuHeight: number, gap: number) {
    const screenX = viewport.x + position.x * viewport.k;
    const screenY = viewport.y + position.y * viewport.k;
    return {
        left: clamp(screenX, gap, Math.max(gap, viewportSize.width - menuWidth - gap)),
        top: clamp(screenY, 72, Math.max(72, viewportSize.height - menuHeight - gap)),
    };
}

export function getAttachedNodePanelPosition(node: CanvasNodeData, viewport: ViewportTransform, viewportSize: { width: number; height: number }, panelWidth: number, panelHeight: number, dragOffset?: Position | null, containerRect?: Pick<DOMRect, "left" | "top">) {
    const gap = 10;
    const margin = 12;
    const topMargin = margin;
    const nodeRect = getCanvasNodeScreenRect(node, viewport, dragOffset);
    const below = nodeRect.bottom + gap;
    const above = nodeRect.top - panelHeight - gap;
    const top = viewportSize.height - below - margin < panelHeight && above >= topMargin ? above : below;
    const offsetX = containerRect?.left || 0;
    const offsetY = containerRect?.top || 0;
    return {
        left: offsetX + clamp(nodeRect.left + nodeRect.width / 2 - panelWidth / 2, margin, Math.max(margin, viewportSize.width - panelWidth - margin)),
        top: offsetY + clamp(top, topMargin, Math.max(topMargin, viewportSize.height - panelHeight - margin)),
    };
}

export function getNodePanelPosition(node: CanvasNodeData, viewport: ViewportTransform, _viewportSize: { width: number; height: number }, panelWidth: number, _panelHeight: number, dragOffset?: Position | null) {
    const gap = 10;
    const offsetX = dragOffset?.x || 0;
    const offsetY = dragOffset?.y || 0;
    const nodeCenterX = viewport.x + (node.position.x + offsetX + node.width / 2) * viewport.k;
    const nodeBottom = viewport.y + (node.position.y + offsetY + node.height) * viewport.k;
    return {
        left: nodeCenterX - panelWidth / 2,
        top: nodeBottom + gap,
        placement: "below" as const,
    };
}
