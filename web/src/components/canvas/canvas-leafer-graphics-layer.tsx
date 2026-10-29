import { useLayoutEffect, useRef, type RefObject } from "react";
import { Group, Leafer, Path, Rect } from "leafer-ui";

import { activeConnectionPath, canvasConnectionPath } from "@/components/canvas/canvas-connections";
import type { CanvasBatchConnectionPreview } from "@/lib/canvas/canvas-batch-connection";
import { subscribeCanvasGraphicsViewportPreview, subscribeCanvasNodeDragPreview, subscribeCanvasSelectionPreview, type CanvasNodeDragPreview } from "@/lib/canvas/canvas-live-viewport";
import { calculateCanvasPreviewTransform, sameCanvasViewport, shouldRebaseCanvasRaster } from "@/lib/canvas/canvas-leafer-viewport";
import { offsetSelectedNodeBounds } from "@/lib/canvas/canvas-selection";
import type { CanvasTheme } from "@/lib/canvas-theme";
import type { RuntimeLimits } from "@/stores/use-user-store";
import type { CanvasDisplayConnection, CanvasNodeData, ConnectionHandle, Position, SelectionBox, ViewportTransform } from "@/types/canvas";

type NodeBounds = { left: number; top: number; width: number; height: number; count: number } | null;

type CanvasLeaferGraphicsLayerProps = {
    containerRef: RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    theme: CanvasTheme;
    displayConnections: CanvasDisplayConnection[];
    connectionPolicy?: RuntimeLimits["canvas"];
    selectedConnectionId: string | null;
    relatedConnectionIds: Set<string>;
    scriptScrollTopById: Record<string, number>;
    connectingParams: ConnectionHandle | null;
    batchConnectionPreview: CanvasBatchConnectionPreview | null;
    mouseWorld: Position;
    connectionTargetNodeId: string | null;
    connectionTargetAnchorRatio?: number;
    nodeById: Map<string, CanvasNodeData>;
    selectionBox: SelectionBox | null;
    selectedNodeBounds: NodeBounds;
    alignmentGuides: { vertical?: number; horizontal?: number };
};

type LeaferScene = {
    leafer: Leafer;
    world: Group;
    host: HTMLDivElement;
};

type UnderlayScene = LeaferScene & {
    connections: Group;
    connectionEntries: Map<string, ConnectionSceneEntry>;
    connectionIdsByNodeId: Map<string, Set<string>>;
    dragPreview: CanvasNodeDragPreview | null;
    dragPreviewConnectionIds: Set<string>;
};

type ConnectionSceneEntry = {
    path: Path;
    target: Path;
    connection: CanvasDisplayConnection["connection"];
    from: CanvasNodeData;
    to: CanvasNodeData;
    signature: string;
};

type OverlayScene = LeaferScene & {
    selection: Rect;
    selectionBounds: Rect;
    guides: Path;
    draft: Path;
    batchDrafts: Group;
    dragPreview: CanvasNodeDragPreview | null;
};

export function CanvasLeaferGraphicsLayer(props: CanvasLeaferGraphicsLayerProps) {
    const underlayHostRef = useRef<HTMLDivElement>(null);
    const overlayHostRef = useRef<HTMLDivElement>(null);
    const underlayRef = useRef<UnderlayScene | null>(null);
    const overlayRef = useRef<OverlayScene | null>(null);
    const viewportRef = useRef(props.viewport);
    const rasterViewportRef = useRef(props.viewport);
    const containerSizeRef = useRef({ width: 1, height: 1 });
    const propsRef = useRef(props);
    propsRef.current = props;

    useLayoutEffect(() => {
        const underlayHost = underlayHostRef.current;
        const overlayHost = overlayHostRef.current;
        // 子组件 layout effect 可能早于父层 ref 对外可见，host 的直接父元素才是此刻最可靠的画布容器。
        const container = (props.containerRef.current || underlayHost?.parentElement) as HTMLDivElement | null;
        if (!underlayHost || !overlayHost || !container) return;

        const underlay = createUnderlayScene(underlayHost);
        const overlay = createOverlayScene(overlayHost);
        containerSizeRef.current = { width: Math.max(1, container.clientWidth), height: Math.max(1, container.clientHeight) };
        underlayRef.current = underlay;
        overlayRef.current = overlay;

        const resize = () => {
            const rect = container.getBoundingClientRect();
            containerSizeRef.current = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
            const size = { ...containerSizeRef.current, pixelRatio: canvasPixelRatio() };
            underlay.leafer.resize(size);
            overlay.leafer.resize(size);
            syncViewport(rasterViewportRef.current, size.width, size.height, underlay, overlay, propsRef.current);
            if (isViewportPreview(container, viewportRef.current, rasterViewportRef.current)) {
                applyScenePreview(viewportRef.current, rasterViewportRef.current, underlay, overlay);
            }
        };
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(container);
        window.addEventListener("resize", resize);
        const unsubscribe = subscribeCanvasGraphicsViewportPreview(container, (next) => {
            viewportRef.current = next;
            if (isViewportPreview(container, next, rasterViewportRef.current)) {
                if (shouldRebaseCanvasRaster(next, rasterViewportRef.current)) {
                    syncViewport(next, containerSizeRef.current.width, containerSizeRef.current.height, underlay, overlay, propsRef.current);
                    rasterViewportRef.current = next;
                    forceSceneRender(underlay, overlay);
                    resetScenePreview(underlay, overlay);
                    return;
                }
                applyScenePreview(next, rasterViewportRef.current, underlay, overlay);
                return;
            }
            resetScenePreview(underlay, overlay);
            if (sameCanvasViewport(next, rasterViewportRef.current)) return;
            syncViewport(next, containerSizeRef.current.width, containerSizeRef.current.height, underlay, overlay, propsRef.current);
            rasterViewportRef.current = next;
        });
        const unsubscribeSelection = subscribeCanvasSelectionPreview(container, (selection) => {
            syncSelection(overlay.selection, selection, propsRef.current.theme);
        });
        const unsubscribeNodeDrag = subscribeCanvasNodeDragPreview(container, (preview) => {
            applyConnectionDragPreview(underlay, propsRef.current, preview);
            overlay.dragPreview = preview;
            syncLiveSelectionBounds(overlay, propsRef.current, viewportRef.current.k);
            syncAlignmentGuides(overlay, propsRef.current, viewportRef.current.k);
            if (!preview) forceSceneRender(overlay);
        });
        resize();

        return () => {
            unsubscribe();
            unsubscribeSelection();
            unsubscribeNodeDrag();
            resizeObserver.disconnect();
            window.removeEventListener("resize", resize);
            underlay.leafer.destroy(true);
            overlay.leafer.destroy(true);
            underlayRef.current = null;
            overlayRef.current = null;
        };
    }, [props.containerRef]);

    useLayoutEffect(() => {
        const underlay = underlayRef.current;
        if (!underlay) return;
        rebuildConnections(underlay, props);
    }, [props.connectionPolicy, props.displayConnections, props.relatedConnectionIds, props.scriptScrollTopById, props.selectedConnectionId, props.theme]);

    useLayoutEffect(() => {
        const overlay = overlayRef.current;
        if (!overlay) return;
        syncOverlayContent(overlay, props, viewportRef.current.k);
    }, [props.batchConnectionPreview, props.connectingParams, props.connectionTargetAnchorRatio, props.connectionTargetNodeId, props.mouseWorld, props.nodeById, props.scriptScrollTopById, props.selectedNodeBounds, props.selectionBox, props.theme]);

    useLayoutEffect(() => {
        const underlay = underlayRef.current;
        const overlay = overlayRef.current;
        const container = props.containerRef.current;
        if (!underlay || !overlay || !container) return;
        viewportRef.current = props.viewport;
        const hadPreview = hasScenePreview(underlay, overlay);
        if (hadPreview || !sameCanvasViewport(props.viewport, rasterViewportRef.current)) {
            syncViewport(props.viewport, containerSizeRef.current.width, containerSizeRef.current.height, underlay, overlay, props);
        }
        rasterViewportRef.current = props.viewport;
        // 新视口先同步到真实 DPR backing store，再撤销交互期的合成变换，避免出现跳帧。
        if (hadPreview) forceSceneRender(underlay, overlay);
        resetScenePreview(underlay, overlay);
    }, [props.containerRef, props.viewport]);

    useLayoutEffect(() => {
        const underlay = underlayRef.current;
        const overlay = overlayRef.current;
        const container = props.containerRef.current;
        if (!underlay || !overlay || !container) return;
        syncViewport(rasterViewportRef.current, containerSizeRef.current.width, containerSizeRef.current.height, underlay, overlay, props);
        if (isViewportPreview(container, viewportRef.current, rasterViewportRef.current)) {
            applyScenePreview(viewportRef.current, rasterViewportRef.current, underlay, overlay);
        }
    }, [props.alignmentGuides, props.containerRef, props.theme]);

    return (
        <>
            <div ref={underlayHostRef} data-canvas-leafer-underlay className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden />
            <div ref={overlayHostRef} data-canvas-leafer-overlay className="pointer-events-none absolute inset-0 z-[var(--z-canvas-overlay)] overflow-hidden" aria-hidden />
        </>
    );
}

function createUnderlayScene(host: HTMLDivElement): UnderlayScene {
    const leafer = new Leafer({ view: host, width: 1, height: 1, pixelRatio: canvasPixelRatio(), fill: "transparent", hittable: false, smooth: true });
    const world = new Group({ hittable: false });
    const connections = new Group({ hittable: false });
    world.add(connections);
    leafer.add(world);
    return { leafer, world, host, connections, connectionEntries: new Map(), connectionIdsByNodeId: new Map(), dragPreview: null, dragPreviewConnectionIds: new Set() };
}

function createOverlayScene(host: HTMLDivElement): OverlayScene {
    const leafer = new Leafer({ view: host, width: 1, height: 1, pixelRatio: canvasPixelRatio(), fill: "transparent", hittable: false, smooth: true });
    const world = new Group({ hittable: false });
    const selection = new Rect({ visible: false, hittable: false });
    const selectionBounds = new Rect({ visible: false, hittable: false, fill: "transparent" });
    const guides = new Path({ visible: false, hittable: false });
    const draft = new Path({ visible: false, hittable: false });
    const batchDrafts = new Group({ visible: false, hittable: false });
    world.add(selection);
    world.add(selectionBounds);
    world.add(guides);
    world.add(draft);
    world.add(batchDrafts);
    leafer.add(world);
    return { leafer, world, host, selection, selectionBounds, guides, draft, batchDrafts, dragPreview: null };
}

function rebuildConnections(scene: UnderlayScene, props: CanvasLeaferGraphicsLayerProps) {
    const nextIds = new Set(props.displayConnections.map(({ connection }) => connection.id));
    for (const [connectionId, entry] of scene.connectionEntries) {
        if (nextIds.has(connectionId)) continue;
        entry.path.remove();
        entry.target.remove();
        scene.connectionEntries.delete(connectionId);
    }

    scene.connectionIdsByNodeId.clear();
    const previewIds = scene.dragPreview ? scene.dragPreview.nodeIds : null;
    for (const { connection, from, to } of props.displayConnections) {
        const emphasized = props.selectedConnectionId === connection.id || props.relatedConnectionIds.has(connection.id);
        const signature = connectionSceneSignature(connection, from, to, props, emphasized);
        let entry = scene.connectionEntries.get(connection.id);
        if (!entry) {
            const path = new Path({ hittable: false });
            const target = new Path({ hittable: false });
            scene.connections.add(path);
            scene.connections.add(target);
            entry = { path, target, connection, from, to, signature: "" };
            scene.connectionEntries.set(connection.id, entry);
        }
        entry.connection = connection;
        entry.from = from;
        entry.to = to;
        if (entry.signature !== signature || scene.dragPreview) {
            syncConnectionPath(entry, props, scene.dragPreview, previewIds);
            entry.signature = signature;
        }
        for (const nodeId of [from.id, to.id]) {
            const connectionIds = scene.connectionIdsByNodeId.get(nodeId) || new Set<string>();
            connectionIds.add(connection.id);
            scene.connectionIdsByNodeId.set(nodeId, connectionIds);
        }
    }

    scene.dragPreviewConnectionIds = collectPreviewConnectionIds(scene, scene.dragPreview);
}

function connectionSceneSignature(connection: CanvasDisplayConnection["connection"], from: CanvasNodeData, to: CanvasNodeData, props: CanvasLeaferGraphicsLayerProps, emphasized: boolean) {
    return [
        connection.id,
        connection.fromNodeId,
        connection.toNodeId,
        connection.fromHandleId || "",
        connection.toHandleId || "",
        from.id,
        from.position.x,
        from.position.y,
        from.width,
        from.height,
        to.id,
        to.position.x,
        to.position.y,
        to.width,
        to.height,
        props.scriptScrollTopById[from.id] || 0,
        props.scriptScrollTopById[to.id] || 0,
        emphasized ? "active" : "idle",
        props.theme.accent.primary,
        props.theme.node.muted,
        props.connectionPolicy?.connectionLineStyle || "solid",
        props.connectionPolicy?.connectionArrowStyle || "arrow",
        props.connectionPolicy?.connectionEffect || "highlight",
    ].join("|");
}

function syncConnectionPath(entry: ConnectionSceneEntry, props: CanvasLeaferGraphicsLayerProps, preview: CanvasNodeDragPreview | null, previewIds: ReadonlySet<string> | null = preview?.nodeIds || null) {
    const from = translatePreviewNode(entry.from, previewIds, preview);
    const to = translatePreviewNode(entry.to, previewIds, preview);
    const isRelated = props.selectedConnectionId === entry.connection.id || props.relatedConnectionIds.has(entry.connection.id);
    const emphasized = isRelated && (props.connectionPolicy?.connectionEffect || "highlight") === "highlight";
    const geometry = canvasConnectionPath(entry.connection, from, to, props.scriptScrollTopById[entry.from.id] || 0, props.scriptScrollTopById[entry.to.id] || 0);
    entry.path.set({
        path: geometry.pathD,
        stroke: emphasized ? props.theme.accent.primary : props.theme.node.muted,
        strokeWidth: emphasized ? 1.8 : 1.35,
        strokeScaleFixed: true,
        strokeCap: "round",
        strokeJoin: "round",
        dashPattern: (props.connectionPolicy?.connectionLineStyle || "solid") === "dashed" ? [6, 5] : undefined,
        opacity: emphasized ? 0.9 : 0.52,
        hittable: false,
    });
    const arrowStyle = props.connectionPolicy?.connectionArrowStyle || "arrow";
    entry.target.set({
        path: arrowStyle === "none" ? "" : arrowStyle === "dot"
            ? connectionTargetDotPath(geometry.endX, geometry.endY, emphasized ? 2.6 : 2.1)
            : connectionTargetArrowPath(geometry.startX, geometry.startY, geometry.endX, geometry.endY, to),
        fill: props.theme.accent.primary,
        opacity: arrowStyle === "none" ? 0 : emphasized ? 0.95 : 0.62,
        hittable: false,
    });
}

function connectionTargetDotPath(x: number, y: number, radius: number) {
    return `M ${x - radius} ${y} A ${radius} ${radius} 0 1 0 ${x + radius} ${y} A ${radius} ${radius} 0 1 0 ${x - radius} ${y} Z`;
}

function connectionTargetArrowPath(startX: number, startY: number, endX: number, endY: number, target: CanvasNodeData) {
    const sides = [
        { distance: Math.abs(endX - target.position.x), ux: 1, uy: 0 },
        { distance: Math.abs(endX - target.position.x - target.width), ux: -1, uy: 0 },
        { distance: Math.abs(endY - target.position.y), ux: 0, uy: 1 },
        { distance: Math.abs(endY - target.position.y - target.height), ux: 0, uy: -1 },
    ].sort((a, b) => a.distance - b.distance);
    const side = sides[0];
    const length = Math.hypot(endX - startX, endY - startY) || 1;
    const ux = side.distance <= 2 ? side.ux : (endX - startX) / length;
    const uy = side.distance <= 2 ? side.uy : (endY - startY) / length;
    const px = -uy;
    const py = ux;
    const size = Math.min(8, Math.max(6, length * 0.04));
    const width = size * 0.52;
    const baseX = endX - ux * size;
    const baseY = endY - uy * size;
    return `M ${endX} ${endY} L ${baseX + px * width} ${baseY + py * width} L ${baseX - px * width} ${baseY - py * width} Z`;
}

function translatePreviewNode(node: CanvasNodeData, previewIds: ReadonlySet<string> | null, preview: CanvasNodeDragPreview | null) {
    if (!preview || !previewIds?.has(node.id) || (preview.x === 0 && preview.y === 0)) return node;
    return { ...node, position: { x: node.position.x + preview.x, y: node.position.y + preview.y } };
}

function collectPreviewConnectionIds(scene: UnderlayScene, preview: CanvasNodeDragPreview | null) {
    const connectionIds = new Set<string>();
    if (!preview) return connectionIds;
    for (const nodeId of preview.nodeIds) {
        scene.connectionIdsByNodeId.get(nodeId)?.forEach((connectionId) => connectionIds.add(connectionId));
    }
    return connectionIds;
}

function applyConnectionDragPreview(scene: UnderlayScene, props: CanvasLeaferGraphicsLayerProps, preview: CanvasNodeDragPreview | null) {
    const affectedConnectionIds = new Set(scene.dragPreviewConnectionIds);
    const previewIds = preview?.nodeIds || null;
    collectPreviewConnectionIds(scene, preview).forEach((connectionId) => affectedConnectionIds.add(connectionId));
    scene.dragPreview = preview;
    scene.dragPreviewConnectionIds = collectPreviewConnectionIds(scene, preview);
    for (const connectionId of affectedConnectionIds) {
        const entry = scene.connectionEntries.get(connectionId);
        if (!entry) continue;
        syncConnectionPath(entry, props, preview, previewIds);
    }
}

function syncOverlayContent(scene: OverlayScene, props: CanvasLeaferGraphicsLayerProps, viewportScale: number) {
    const selection = props.selectionBox;
    scene.selection.visible = Boolean(selection);
    if (selection) {
        syncSelection(scene.selection, selection, props.theme);
    }

    const bounds = props.selectedNodeBounds;
    scene.selectionBounds.visible = Boolean(bounds && !selection);
    if (bounds && !selection) {
        syncSelectionBounds(scene.selectionBounds, liveSelectedNodeBounds(bounds, scene.dragPreview), viewportScale);
        scene.selectionBounds.stroke = props.theme.node.label;
    }

    const connecting = props.connectingParams;
    scene.draft.visible = Boolean(connecting);
    if (connecting) {
        scene.draft.set({
            path: activeConnectionPath(
                props.nodeById.get(connecting.nodeId),
                connecting,
                props.mouseWorld,
                props.connectionTargetNodeId ? props.nodeById.get(props.connectionTargetNodeId) : undefined,
                props.scriptScrollTopById[connecting.nodeId] || 0,
            ),
            stroke: props.theme.accent.primary,
            strokeCap: "round",
            opacity: 0.72,
        });
    }

    scene.batchDrafts.removeAll(true);
    const batch = props.batchConnectionPreview;
    scene.batchDrafts.visible = Boolean(batch);
    if (!batch) return;
    const target = batch.targetNodeId ? props.nodeById.get(batch.targetNodeId) : undefined;
    const stroke = batch.status === "invalid" ? props.theme.accent.danger : batch.status === "partial" ? props.theme.node.activeStroke : props.theme.accent.primary;
    batch.sourceNodeIds.forEach((sourceNodeId) => {
        const source = props.nodeById.get(sourceNodeId);
        if (!source) return;
        const handle: ConnectionHandle = { nodeId: source.id, handleType: "source" };
        scene.batchDrafts.add(new Path({
            path: activeConnectionPath(source, handle, batch.mouseWorld, target, props.scriptScrollTopById[source.id] || 0),
            stroke,
            strokeWidth: 1.4,
            strokeScaleFixed: true,
            strokeCap: "round",
            dashPattern: [8, 8],
            opacity: 0.72,
            hittable: false,
        }));
    });
}

function syncSelection(rect: Rect, selection: SelectionBox, theme: CanvasTheme) {
    rect.set({
        x: Math.min(selection.startWorldX, selection.currentWorldX),
        y: Math.min(selection.startWorldY, selection.currentWorldY),
        width: Math.abs(selection.currentWorldX - selection.startWorldX),
        height: Math.abs(selection.currentWorldY - selection.startWorldY),
        fill: "transparent",
        stroke: theme.node.label,
        opacity: selection.hitMode === "intersect" ? 0.82 : 0.68,
    });
}

function syncViewport(viewport: ViewportTransform, width: number, height: number, underlay: UnderlayScene, overlay: OverlayScene, props: CanvasLeaferGraphicsLayerProps) {
    const scale = Math.max(viewport.k, 0.05);
    for (const scene of [underlay, overlay]) scene.world.set({ x: viewport.x, y: viewport.y, scaleX: scale, scaleY: scale });

    overlay.selection.set({
        strokeWidth: 1 / scale,
        cornerRadius: 2 / scale,
        dashPattern: [4 / scale, 4 / scale],
    });
    if (props.selectedNodeBounds) syncSelectionBounds(overlay.selectionBounds, liveSelectedNodeBounds(props.selectedNodeBounds, overlay.dragPreview), scale);
    overlay.selectionBounds.set({
        strokeWidth: 1 / scale,
        cornerRadius: 2 / scale,
        dashPattern: [4 / scale, 4 / scale],
        opacity: 0.68,
    });
    overlay.draft.set({ strokeWidth: 1.4 / scale, dashPattern: [8 / scale, 8 / scale] });
    syncAlignmentGuides(overlay, props, scale);
}

function syncAlignmentGuides(overlay: OverlayScene, props: CanvasLeaferGraphicsLayerProps, scale: number) {
    const preview = overlay.dragPreview;
    const nodes = preview ? [...preview.nodeIds].map((id) => props.nodeById.get(id)).filter((node): node is CanvasNodeData => Boolean(node)) : [];
    const padding = 14 / Math.max(scale, 0.05);
    const commands: string[] = [];
    if (preview && nodes.length) {
        const left = Math.min(...nodes.map((node) => node.position.x)) + preview.x;
        const right = Math.max(...nodes.map((node) => node.position.x + node.width)) + preview.x;
        const top = Math.min(...nodes.map((node) => node.position.y)) + preview.y;
        const bottom = Math.max(...nodes.map((node) => node.position.y + node.height)) + preview.y;
        const { vertical, horizontal } = props.alignmentGuides;
        if (vertical !== undefined) commands.push(`M ${vertical} ${top - padding} L ${vertical} ${top} M ${vertical} ${bottom} L ${vertical} ${bottom + padding}`);
        if (horizontal !== undefined) commands.push(`M ${left - padding} ${horizontal} L ${left} ${horizontal} M ${right} ${horizontal} L ${right + padding} ${horizontal}`);
    }
    overlay.host.dataset.alignmentGuides = commands.length ? "visible" : "hidden";
    overlay.guides.set({
        visible: commands.length > 0,
        path: commands.join(" "),
        stroke: props.theme.accent.primary,
        strokeWidth: 1 / Math.max(scale, 0.05),
        dashPattern: [3 / Math.max(scale, 0.05), 3 / Math.max(scale, 0.05)],
        opacity: 0.5,
    });
}

function isViewportPreview(container: HTMLDivElement, viewport: ViewportTransform, rasterViewport: ViewportTransform) {
    return container.dataset.canvasViewportInteracting === "true" && !sameCanvasViewport(viewport, rasterViewport);
}

function applyScenePreview(viewport: ViewportTransform, rasterViewport: ViewportTransform, ...scenes: LeaferScene[]) {
    // 将已栅格画面的屏幕坐标映射到实时视口，缩放手势期间不触碰 Leafer 场景树。
    const { ratio, x, y } = calculateCanvasPreviewTransform(viewport, rasterViewport);
    for (const scene of scenes) {
        scene.host.style.transformOrigin = "0 0";
        scene.host.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${ratio})`;
        scene.host.style.willChange = "transform";
        scene.host.dataset.canvasLeaferPreview = "true";
    }
}

function hasScenePreview(...scenes: LeaferScene[]) {
    return scenes.some((scene) => scene.host.dataset.canvasLeaferPreview === "true");
}

function resetScenePreview(...scenes: LeaferScene[]) {
    for (const scene of scenes) {
        scene.host.style.transform = "";
        scene.host.style.transformOrigin = "";
        scene.host.style.willChange = "";
        delete scene.host.dataset.canvasLeaferPreview;
    }
}

function forceSceneRender(...scenes: LeaferScene[]) {
    for (const scene of scenes) scene.leafer.forceRender(undefined, true);
}

function liveSelectedNodeBounds(bounds: NonNullable<NodeBounds>, preview: CanvasNodeDragPreview | null) {
    return offsetSelectedNodeBounds(bounds, preview);
}

function syncLiveSelectionBounds(scene: OverlayScene, props: CanvasLeaferGraphicsLayerProps, viewportScale: number) {
    const bounds = props.selectedNodeBounds;
    const selection = props.selectionBox;
    scene.selectionBounds.visible = Boolean(bounds && !selection);
    if (!bounds || selection) return;
    syncSelectionBounds(scene.selectionBounds, liveSelectedNodeBounds(bounds, scene.dragPreview), viewportScale);
    scene.selectionBounds.stroke = props.theme.node.label;
}

function syncSelectionBounds(rect: Rect, bounds: NonNullable<NodeBounds>, viewportScale: number) {
    const padding = 12 / Math.max(viewportScale, 0.05);
    rect.set({
        x: bounds.left - padding,
        y: bounds.top - padding,
        width: bounds.width + padding * 2,
        height: bounds.height + padding * 2,
    });
}

function canvasPixelRatio() {
    return Math.min(3, Math.max(1, window.devicePixelRatio || 1));
}
