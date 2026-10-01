import type { SelectionBox, ViewportTransform } from "@/types/canvas";

export const CANVAS_VIEWPORT_PREVIEW_EVENT = "canvas:viewport-preview";
export const CANVAS_VIEWPORT_VISIBILITY_PREVIEW_EVENT = "canvas:viewport-visibility-preview";
export const CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT = "canvas:graphics-viewport-preview";
export const CANVAS_SELECTION_PREVIEW_EVENT = "canvas:selection-preview";
export const CANVAS_NODE_DRAG_PREVIEW_EVENT = "canvas:node-drag-preview";

export type CanvasNodeDragPreview = {
    x: number;
    y: number;
    nodeIds: ReadonlySet<string>;
};

export function setCanvasViewportInteracting(container: HTMLDivElement | null, interacting: boolean) {
    if (!container) return;
    const root = container.ownerDocument?.documentElement;
    if (interacting) {
        if (container.dataset.canvasViewportInteracting !== "true") container.dataset.canvasViewportInteracting = "true";
        if (root && root.dataset.canvasViewportInteracting !== "true") root.dataset.canvasViewportInteracting = "true";
    } else {
        if (container.dataset.canvasViewportInteracting !== undefined) delete container.dataset.canvasViewportInteracting;
        if (root && root.dataset.canvasViewportInteracting !== undefined) delete root.dataset.canvasViewportInteracting;
    }
}

type NodeDragPreviewDomState = {
    elementsById: Map<string, HTMLElement>;
    previousIds: Set<string>;
    selectionBounds: HTMLElement | null;
    lastX: number | null;
    lastY: number | null;
};

type NodeSelectionPreviewDomState = {
    elementsById: Map<string, HTMLElement>;
    previousStates: Map<string, "include" | "remove">;
};

export type CanvasNodeSelectionPreview = {
    includeNodeIds: ReadonlySet<string>;
    removeNodeIds: ReadonlySet<string>;
};

const nodeDragPreviewDomStates = new WeakMap<HTMLDivElement, NodeDragPreviewDomState>();
const nodeSelectionPreviewDomStates = new WeakMap<HTMLDivElement, NodeSelectionPreviewDomState>();
type LiveViewportDomState = {
    worldLayer: HTMLElement | null;
    lastTransform: string;
    lastWillChange: string;
    lastScale: string;
    lastInverseScale: string;
    lastPlacementPreview: ViewportTransform | null;
};

const liveViewportElements = new WeakMap<HTMLDivElement, LiveViewportDomState>();

export function applyCanvasLiveViewport(container: HTMLDivElement | null, viewport: ViewportTransform, notify = true) {
    if (!container) return;
    const committedScale = Number(container.style.getPropertyValue("--canvas-committed-scale")) || viewport.k;
    let elements = liveViewportElements.get(container);
    if (!elements) {
        elements = {
            worldLayer: container.querySelector<HTMLElement>("[data-canvas-world-layer]"),
            lastTransform: "",
            lastWillChange: "",
            lastScale: "",
            lastInverseScale: "",
            lastPlacementPreview: null,
        };
        liveViewportElements.set(container, elements);
    }
    const worldLayer = elements.worldLayer;
    if (worldLayer) {
        // 平移期间直接更新合成层，避免修改容器继承变量导致所有节点重新计算样式。
        const transform = `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.k / committedScale})`;
        if (elements.lastTransform !== transform) {
            worldLayer.style.transformOrigin = "0 0";
            worldLayer.style.transform = transform;
            elements.lastTransform = transform;
        }
        const willChange = container.dataset.canvasViewportInteracting === "true" ? "transform" : "";
        if (elements.lastWillChange !== willChange) {
            worldLayer.style.willChange = willChange;
            elements.lastWillChange = willChange;
        }
    }
    const scale = String(viewport.k);
    if (elements.lastScale !== scale) {
        container.style.setProperty("--canvas-live-scale", scale);
        elements.lastScale = scale;
    }
    // 外置节点标题用同一帧逆倍率抵消世界层缩放，避免等待 React 提交后再校正尺寸。
    const inverseScale = String(1 / Math.max(viewport.k, 0.05));
    if (elements.lastInverseScale !== inverseScale) {
        container.style.setProperty("--canvas-live-inverse-scale", inverseScale);
        elements.lastInverseScale = inverseScale;
    }
    // 图形层必须逐帧跟随 DOM 世界层；浮层和滚动通知仍可按原频率节流。
    container.dispatchEvent(new CustomEvent<ViewportTransform>(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, { detail: viewport }));
    container.dispatchEvent(new CustomEvent<ViewportTransform>(CANVAS_VIEWPORT_VISIBILITY_PREVIEW_EVENT, { detail: viewport }));
    const previous = elements.lastPlacementPreview;
    const placementChanged = !previous
        || Math.abs(previous.y - viewport.y) > 0.5
        || Math.abs(previous.k - viewport.k) > 0.001;
    elements.lastPlacementPreview = viewport;
    if (notify) {
        if (placementChanged) {
            container.dispatchEvent(new CustomEvent<ViewportTransform>(CANVAS_VIEWPORT_PREVIEW_EVENT, { detail: viewport }));
        }
        // Ant Design overlays watch scrollable ancestors, but CSS transforms do not emit layout events.
        if (placementChanged) container.dispatchEvent(new Event("scroll"));
    }
}

export function subscribeCanvasGraphicsViewportPreview(container: HTMLDivElement, listener: (viewport: ViewportTransform) => void) {
    const handlePreview = (event: Event) => listener((event as CustomEvent<ViewportTransform>).detail);
    container.addEventListener(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, handlePreview);
    return () => container.removeEventListener(CANVAS_GRAPHICS_VIEWPORT_PREVIEW_EVENT, handlePreview);
}

export function subscribeCanvasViewportPreview(container: HTMLDivElement, listener: (viewport: ViewportTransform) => void) {
    const handlePreview = (event: Event) => listener((event as CustomEvent<ViewportTransform>).detail);
    container.addEventListener(CANVAS_VIEWPORT_PREVIEW_EVENT, handlePreview);
    return () => container.removeEventListener(CANVAS_VIEWPORT_PREVIEW_EVENT, handlePreview);
}

export function subscribeCanvasViewportVisibilityPreview(container: HTMLDivElement, listener: (viewport: ViewportTransform) => void) {
    const handlePreview = (event: Event) => listener((event as CustomEvent<ViewportTransform>).detail);
    container.addEventListener(CANVAS_VIEWPORT_VISIBILITY_PREVIEW_EVENT, handlePreview);
    return () => container.removeEventListener(CANVAS_VIEWPORT_VISIBILITY_PREVIEW_EVENT, handlePreview);
}

/**
 * Applies transient node movement without changing React state. Only nodes
 * currently mounted in the virtualized world are touched; the committed
 * positions are still written by the drag-end path.
 */
export function applyCanvasNodeDragPreview(container: HTMLDivElement | null, preview: CanvasNodeDragPreview | null) {
    if (!container) return;
    const root = container.ownerDocument?.documentElement;
    if (preview) {
        if (container.dataset.canvasNodeDragging !== "true") container.dataset.canvasNodeDragging = "true";
        if (root && root.dataset.canvasNodeDragging !== "true") root.dataset.canvasNodeDragging = "true";
    } else {
        delete container.dataset.canvasNodeDragging;
        if (root) delete root.dataset.canvasNodeDragging;
    }

    let state = nodeDragPreviewDomStates.get(container);
    if (!state) {
        state = { elementsById: new Map(), previousIds: new Set(), selectionBounds: null, lastX: null, lastY: null };
        nodeDragPreviewDomStates.set(container, state);
    }

    const sameNodeIds = Boolean(
        preview
        && preview.nodeIds.size === state.previousIds.size
        && Array.from(preview.nodeIds).every((nodeId) => state?.previousIds.has(nodeId)),
    );
    const positionUnchanged = Boolean(preview && sameNodeIds && state.lastX === preview.x && state.lastY === preview.y);
    for (const nodeId of state.previousIds) {
        if (!positionUnchanged) state.elementsById.get(nodeId)?.style.removeProperty("translate");
    }
    if (!positionUnchanged) state.selectionBounds?.style.removeProperty("translate");

    state.previousIds.clear();
    if (preview) {
        // Build the lookup once per drag session. A single DOM scan is much
        // cheaper than one selector query per selected node on every frame.
        if (state.elementsById.size === 0) {
            container.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
                const nodeId = element.dataset.nodeId;
                if (nodeId) state?.elementsById.set(nodeId, element);
            });
            state.selectionBounds = container.querySelector<HTMLElement>("[data-canvas-selection-bounds]");
        }
        for (const nodeId of preview.nodeIds) {
            const element = state.elementsById.get(nodeId);
            if (!element || !element.isConnected) continue;
            if (!positionUnchanged) element.style.setProperty("translate", `${preview.x}px ${preview.y}px`);
            state.previousIds.add(nodeId);
        }
        if (!state.selectionBounds?.isConnected) {
            state.selectionBounds = container.querySelector<HTMLElement>("[data-canvas-selection-bounds]");
        }
        if (!positionUnchanged) state.selectionBounds?.style.setProperty("translate", `${preview.x}px ${preview.y}px`);
        state.lastX = preview.x;
        state.lastY = preview.y;
    } else {
        state.elementsById.clear();
        state.selectionBounds = null;
        state.lastX = null;
        state.lastY = null;
    }

    container.dispatchEvent(new CustomEvent<CanvasNodeDragPreview | null>(CANVAS_NODE_DRAG_PREVIEW_EVENT, { detail: preview }));
}

export function subscribeCanvasNodeDragPreview(container: HTMLDivElement, listener: (preview: CanvasNodeDragPreview | null) => void) {
    const handlePreview = (event: Event) => listener((event as CustomEvent<CanvasNodeDragPreview | null>).detail);
    container.addEventListener(CANVAS_NODE_DRAG_PREVIEW_EVENT, handlePreview);
    return () => container.removeEventListener(CANVAS_NODE_DRAG_PREVIEW_EVENT, handlePreview);
}

/**
 * Shows the selection delta on mounted nodes without changing React state.
 * The controller commits the final Set once on pointer-up.
 */
export function applyCanvasNodeSelectionPreview(container: HTMLDivElement | null, preview: CanvasNodeSelectionPreview | null) {
    if (!container) return;

    let state = nodeSelectionPreviewDomStates.get(container);
    if (!state) {
        state = { elementsById: new Map(), previousStates: new Map() };
        nodeSelectionPreviewDomStates.set(container, state);
    }

    const nextStates = new Map<string, "include" | "remove">();
    if (preview) {
        for (const nodeId of preview.includeNodeIds) nextStates.set(nodeId, "include");
        for (const nodeId of preview.removeNodeIds) nextStates.set(nodeId, "remove");
    }

    if (state.elementsById.size === 0 && nextStates.size > 0) {
        container.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
            const nodeId = element.dataset.nodeId;
            if (nodeId) state?.elementsById.set(nodeId, element);
        });
    }

    for (const [nodeId, previousState] of state.previousStates) {
        if (nextStates.get(nodeId) === previousState) continue;
        state.elementsById.get(nodeId)?.removeAttribute("data-canvas-selection-preview");
    }
    for (const [nodeId, nextState] of nextStates) {
        if (state.previousStates.get(nodeId) === nextState) continue;
        const element = state.elementsById.get(nodeId);
        if (!element || !element.isConnected) continue;
        element.dataset.canvasSelectionPreview = nextState;
    }

    state.previousStates = nextStates;
    if (!preview) state.elementsById.clear();
}

export function applyCanvasSelectionPreview(container: HTMLDivElement | null, selection: SelectionBox) {
    container?.dispatchEvent(new CustomEvent<SelectionBox>(CANVAS_SELECTION_PREVIEW_EVENT, { detail: selection }));
}

export function subscribeCanvasSelectionPreview(container: HTMLDivElement, listener: (selection: SelectionBox) => void) {
    const handlePreview = (event: Event) => listener((event as CustomEvent<SelectionBox>).detail);
    container.addEventListener(CANVAS_SELECTION_PREVIEW_EVENT, handlePreview);
    return () => container.removeEventListener(CANVAS_SELECTION_PREVIEW_EVENT, handlePreview);
}
