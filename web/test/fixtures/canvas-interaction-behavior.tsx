import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useCanvasSelectionController } from "@/pages/canvas/use-canvas-selection-controller";
import { useCanvasHistory } from "@/pages/canvas/use-canvas-history";
import { useCanvasKeyboard } from "@/pages/canvas/use-canvas-keyboard";
import { useCanvasNodeContentUpdates } from "@/pages/canvas/use-canvas-node-content-updates";
import { createCanvasStateWriter } from "@/lib/canvas/canvas-editor-state";
import { canvasAppearanceForTheme } from "@/lib/canvas/canvas-appearance";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection, type CanvasAssistantSession } from "@/types/canvas";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { setImageBlob, deleteStoredImages } from "@/services/image-storage";
import { canvasImagePreparationStats } from "@/services/canvas-image-loader";
import { startCanvasPerformanceDiagnostics, measureCanvasComputation, recordCanvasRender } from "@/lib/canvas/canvas-performance-diagnostics";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { applyCanvasLiveViewport, setCanvasViewportInteracting } from "@/lib/canvas/canvas-live-viewport";
import "@/styles/globals.css";
import { runCanvasLifecycleChecks } from "./canvas-lifecycle-behavior";
import { runCanvasRenderChecks } from "./canvas-render-behavior";

const noop = () => {};
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const emptyConnections: CanvasConnection[] = [];
const emptyChats: CanvasAssistantSession[] = [];
const appearance = canvasAppearanceForTheme("dark");

function mountHarness(host: HTMLDivElement) {
    const initial: CanvasNodeData[] = [
        { id: "node", type: CanvasNodeType.Text, title: "Initial", position: { x: 100, y: 100 }, width: 120, height: 80, metadata: { content: "original" } },
        { id: "folder", type: CanvasNodeType.Frame, title: "Linked", position: { x: 0, y: 0 }, width: 800, height: 600, metadata: { folder: { style: "glass", createdAt: "2026-10-09", assetFolderId: "test-only" } } },
        { id: "unrelated", type: CanvasNodeType.Text, title: "Other", position: { x: 1200, y: 1000 }, width: 120, height: 80 },
    ];
    const counts = { writes: 0, drops: 0, ends: 0, clicks: 0, deletes: 0, search: 0, zoom: 0, save: 0, paste: 0 };
    let api: {
        nodes(): CanvasNodeData[]; paused(): boolean; preview(): boolean; stable(): boolean; canUndo(): boolean;
        update(fn: (nodes: CanvasNodeData[]) => CanvasNodeData[]): void; undo(): void; redo(): void;
    };
    function Harness() {
        const [nodes, publish] = useState(initial);
        const nodesRef = useRef(nodes);
        const writer = useMemo(() => createCanvasStateWriter(nodesRef, publish), []);
        const setNodes = useMemo(() => (update: Parameters<typeof writer>[0]) => { counts.writes++; writer(update); }, [writer]);
        const containerRef = useRef<HTMLDivElement>(null);
        const viewportRef = useRef({ x: 0, y: 0, k: 1 });
        const [selected, setSelected] = useState(new Set(["node"]));
        const selectedNodeIdsRef = useRef(selected);
        selectedNodeIdsRef.current = selected;
        const snapshot = { nodes, connections: emptyConnections, chatSessions: emptyChats, activeChatId: null, canvasAppearance: appearance, backgroundMode: "dots" as const, showImageInfo: false };
        const history = useCanvasHistory({ ...snapshot, projectLoaded: true, setNodes, setConnections: noop, setChatSessions: noop, setActiveChatId: noop, applyCanvasAppearance: noop, setBackgroundMode: noop, setShowImageInfo: noop, setSelectedNodeIds: setSelected, setSelectedConnectionId: noop, setContextMenu: noop });
        useEffect(() => { history.resetHistory(snapshot); }, []);
        const ctrl = useCanvasSelectionController({ containerRef, nodesRef, viewportRef, selectedNodeIdsRef, historyPausedRef: history.historyPausedRef,
            screenToCanvas: (x, y) => ({ x, y }), setNodes, setSelectedNodeIds: setSelected, setSelectedConnectionId: noop, cancelPendingConnectionCreate: noop,
            onCanvasSelectionStart: noop, onNodeInteractionStart: noop, onDeselect: noop,
            onNodeClick: () => { counts.clicks++; }, onNodeDragEnd: () => { counts.ends++; }, onLinkedFolderDrop: () => { counts.drops++; } });
        useCanvasKeyboard({ nodesRef, selectedNodeIdsRef, selectedConnectionId: null, setSelectedNodeIds: setSelected, setSelectedConnectionId: noop, setContextMenu: noop,
            setShortcutRequestNonce: noop, setInfoNodeId: noop, setCropNodeId: noop, setMaskEditNodeId: noop, setAnnotationNodeId: noop,
            saveCanvasProject: () => { counts.save++; }, zoomToActualSize: () => { counts.zoom++; }, fitCanvasContent: noop, fitCanvasSelection: noop,
            undoCanvas: history.undoCanvas, redoCanvas: history.redoCanvas, cancelSelectionBox: ctrl.cancelSelectionBox, copySelectedNodes: noop,
            pasteCopiedNodes: () => { counts.paste++; return true; }, restoreCopiedNodesFromText: () => false, shouldPreferCopiedNodes: () => true,
            pasteSystemClipboard: () => { counts.paste++; return true; }, deleteNodes: () => { counts.deletes++; }, deleteConnection: noop,
            deselectCanvas: ctrl.deselectCanvas, zoomCanvasIn: () => { counts.zoom++; }, zoomCanvasOut: () => { counts.zoom++; },
            focusMode: false, exitFocusMode: noop, toggleFocusMode: noop, onOpenSearch: () => { counts.search++; }, beginBatchConnection: noop });
        api = { nodes: () => nodesRef.current, paused: () => history.historyPausedRef.current, preview: () => ctrl.nodeDraggingRef.current, canUndo: () => history.historyState.canUndo,
            stable: () => nodesRef.current.find((node) => node.id === "unrelated") === initial[2], update: writer, undo: history.undoCanvas, redo: history.redoCanvas };
        return <div ref={containerRef}>
            <div data-node-id="node" onMouseDown={(event) => ctrl.handleNodeMouseDown(event, "node")} style={{ position: "absolute", left: nodes[0]?.position.x, top: nodes[0]?.position.y, width: 120, height: 80 }}>Drag</div>
            <input id="editor" /><div contentEditable id="rich-editor" suppressContentEditableWarning>Editable</div>
            <div className="ant-popover"><button id="popover-button">Menu</button></div>
        </div>;
    }
    const root = createRoot(host);
    flushSync(() => root.render(<Harness />));
    return { get api() { return api; }, counts, unmount: () => flushSync(() => root.unmount()) };
}

export async function runCanvasInteractionChecks() {
    const results: string[] = [];
    const check = (value: unknown, message: string) => { if (!value) throw new Error(message); results.push(message); };
    const setup = async () => {
        const host = document.createElement("div"); document.body.append(host);
        const harness = mountHarness(host); await wait();
        return { ...harness, get api() { return harness.api; }, host, dispose() { harness.unmount(); host.remove(); } };
    };
    const mouse = (type: string, x: number, y: number, target: EventTarget = window) => flushSync(() => target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true })));
    const key = (target: EventTarget, value: string, options: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
        flushSync(() => target.dispatchEvent(event)); return event;
    };
    const begin = async (host: HTMLElement) => { mouse("mousedown", 110, 110, host.querySelector("[data-node-id]")!); mouse("mousemove", 210, 210); await wait(); };
    for (const reason of ["pointercancel", "blur", "Escape"]) {
        const h = await setup();
        try {
            await begin(h.host);
            check(!h.api.paused() && h.api.preview(), `${reason}: preview starts without pausing concurrent document updates`);
            check(document.documentElement.dataset.canvasNodeDragging === "true", `${reason}: drag preview shields iframe pointer targets`);
            if (reason === "Escape") key(window, "Escape");
            else flushSync(() => window.dispatchEvent(new Event(reason)));
            mouse("mouseup", 210, 210); await wait(220);
            check(h.counts.writes === 0 && h.counts.drops === 0 && h.counts.ends === 0 && h.counts.clicks === 0, `${reason}: cancellation has no commit or callback`);
            check(h.api.nodes()[0].position.x === 100 && !h.api.paused() && !h.api.preview(), `${reason}: position and interaction state restored`);
            check(document.documentElement.dataset.canvasNodeDragging === undefined, `${reason}: cancellation releases iframe pointer shielding`);
        } finally { h.dispose(); }
    }
    {
        const h = await setup();
        try {
            await begin(h.host);
            flushSync(() => window.dispatchEvent(new PointerEvent("pointerup", { clientX: 210, clientY: 210 })));
            mouse("mouseup", 210, 210); await wait(240);
            check(h.counts.writes === 1 && h.counts.ends === 1 && h.counts.drops === 1, "pointerup + mouseup commit only once");
            check(h.api.nodes()[0].position.x === 200 && h.api.stable(), "completion updates only selected geometry");
            flushSync(() => h.api.undo()); await wait();
            check(h.api.nodes()[0].position.x === 100, "single undo restores drag position");
            flushSync(() => h.api.redo()); await wait();
            check(h.api.nodes()[0].position.x === 200, "single redo restores completed position");
        } finally { h.dispose(); }
    }
    {
        const h = await setup();
        try {
            await begin(h.host);
            flushSync(() => h.api.update((nodes) => nodes.map((node) => node.id === "node" ? { ...node, title: "Latest", width: 130, metadata: { content: "generated", status: "success" } } : node)));
            mouse("mouseup", 210, 210); await wait();
            const node = h.api.nodes()[0];
            check(node.title === "Latest" && node.width === 130 && node.metadata?.content === "generated" && node.position.x === 200, "concurrent generation fields survive drag commit");
        } finally { h.dispose(); }
    }
    {
        const h = await setup();
        try {
            await begin(h.host);
            flushSync(() => h.api.update((nodes) => nodes.map((node) => node.id === "node" ? { ...node, metadata: { content: "arrived during drag" } } : node)));
            await wait(240);
            check(h.api.canUndo() && !h.api.paused(), "concurrent content is recorded while drag preview is active");
            flushSync(() => window.dispatchEvent(new Event("pointercancel")));
            check(h.api.nodes()[0].metadata?.content === "arrived during drag" && h.counts.writes === 0, "cancellation preserves concurrent content without a synthetic document write");
        } finally { h.dispose(); }
    }
    {
        const h = await setup();
        try {
            await begin(h.host);
            flushSync(() => h.api.update((nodes) => nodes.filter((node) => node.id !== "node")));
            mouse("mouseup", 210, 210); await wait();
            check(!h.api.nodes().some((node) => node.id === "node") && h.counts.writes === 0 && h.counts.ends === 0, "concurrently deleted node is not revived or committed");
        } finally { h.dispose(); }
    }
    {
        const h = await setup();
        try {
            await begin(h.host);
            flushSync(() => h.api.update((nodes) => nodes.map((node) => node.id === "folder" ? { ...node, position: { x: 2000, y: 2000 } } : node)));
            mouse("mouseup", 210, 210); await wait();
            check(h.counts.drops === 0 && !h.api.nodes()[0].parentId, "drop target uses latest frame geometry");
        } finally { h.dispose(); }
    }
    {
        const h = await setup();
        try {
            await begin(h.host); h.unmount();
            check(!h.api.paused() && !h.api.preview(), "unmount releases drag/history ownership");
        } finally { h.host.remove(); }
    }
    {
        const h = await setup();
        try {
            key(window, "Delete", { isComposing: true });
            key(window, "Backspace", { keyCode: 229 });
            check(h.counts.deletes === 0, "IME does not delete selected nodes");
            for (const selector of ["#editor", "#rich-editor", "#popover-button"]) {
                const target = h.host.querySelector(selector)!;
                key(target, "Delete"); key(target, "f", { ctrlKey: true });
                const zoom = key(target, "+", { ctrlKey: true });
                flushSync(() => target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true })));
                check(!zoom.defaultPrevented, `${selector}: native shortcuts are not swallowed`);
            }
            check(h.counts.deletes === 0 && h.counts.search === 0 && h.counts.zoom === 0 && h.counts.paste === 0, "editors and portal controls isolate canvas commands");
            key(h.host.querySelector("#editor")!, "s", { ctrlKey: true });
            check(h.counts.save === 1, "Ctrl+S remains available in inline editors");
            key(window, "Delete"); key(window, "f", { ctrlKey: true }); key(window, "+", { ctrlKey: true });
            check(h.counts.deletes === 1 && h.counts.search === 1 && h.counts.zoom === 1, "canvas commands still work outside editors");
        } finally { h.dispose(); }
    }
    results.push(...await runMediaAndDiagnosticsChecks());
    results.push(...await runCanvasLifecycleChecks());
    results.push(...await runCanvasRenderChecks());
    results.push(...await runViewportChecks());
    results.push(...await runContentUpdateChecks());
    return results;
}

async function runContentUpdateChecks() {
    const results: string[] = [];
    const check = (value: unknown, message: string) => { if (!value) throw new Error(message); results.push(message); };
    const makeNode = (title = "Initial"): CanvasNodeData => ({ id: "node", type: CanvasNodeType.Text, title, position: { x: 0, y: 0 }, width: 120, height: 80, metadata: { content: "original" } });
    const other = { ...makeNode(), id: "other" };
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    let mounted = true;
    let publishes = 0;
    let api: ReturnType<typeof useCanvasNodeContentUpdates> & { read(): CanvasNodeData[]; write(update: (nodes: CanvasNodeData[]) => CanvasNodeData[]): void; switchProject(): void };
    function Harness() {
        const [nodes, setNodes] = useState([makeNode(), other]);
        const [projectId, setProjectId] = useState("first");
        const nodesRef = useRef(nodes);
        const publish = useMemo(() => (next: CanvasNodeData[]) => { publishes++; setNodes(next); }, []);
        const write = useMemo(() => createCanvasStateWriter(nodesRef, publish), [publish]);
        const updates = useCanvasNodeContentUpdates(projectId, nodesRef, publish);
        api = { ...updates, read: () => nodesRef.current, write, switchProject: () => { write([makeNode("Second"), other]); setProjectId("second"); } };
        return null;
    }
    try {
        flushSync(() => root.render(<StrictMode><Harness /></StrictMode>));
        let calls = 0;
        flushSync(() => {
            api.updateNode("node", (node) => { calls++; return { ...node, title: "Renamed" }; });
            api.write((nodes) => nodes.map((node) => node.id === "node" ? { ...node, position: { x: 50, y: 80 } } : node));
            api.updateNode("node", (node) => { calls++; return { ...node, metadata: { ...node.metadata, content: `${node.title}: latest` } }; });
        });
        check(calls === 2 && api!.read()[0].metadata?.content === "Renamed: latest" && api!.read()[0].position.x === 50, "content writes: StrictMode commands run once against synchronous latest state");
        check(api!.read()[1] === other, "content writes: unrelated node retains its object identity");
        const before = publishes;
        api!.updateMediaNode("node", (node) => ({ ...node, width: node.width + 10 }));
        api!.updateMediaNode("node", (node) => ({ ...node, height: node.width / 2 }));
        flushSync(() => api.write((nodes) => nodes.map((node) => node.id === "node" ? { ...node, title: "Concurrent result" } : node)));
        await wait(180);
        check(publishes === before + 2 && api!.read()[0].width === 130 && api!.read()[0].height === 65 && api!.read()[0].title === "Concurrent result", "media writes: one ordered batch preserves concurrent content");
        api!.updateMediaNode("node", (node) => { calls++; return { ...node, width: 999 }; });
        flushSync(() => api.write((nodes) => nodes.filter((node) => node.id !== "node")));
        await wait(180);
        check(calls === 2 && !api!.read().some((node) => node.id === "node"), "media writes: queued measurement cannot revive a deleted node");
        const previous = api!;
        previous.updateMediaNode("other", (node) => { calls++; return { ...node, width: 999 }; });
        flushSync(() => previous.switchProject());
        previous.updateNode("node", (node) => { calls++; return { ...node, title: "Stale" }; });
        previous.updateMediaNode("node", (node) => { calls++; return { ...node, width: 999 }; });
        await wait(180);
        check(calls === 2 && api!.read()[0].title === "Second" && api!.read()[1].width === 120, "media writes: canvas switch cancels queued and late callbacks, including reused node IDs");
        flushSync(() => api.updateNode("node", (node) => ({ ...node, title: "Active canvas" })));
        check(api!.read()[0].title === "Active canvas", "content writes: the new canvas writer remains active");
        api!.updateMediaNode("node", (node) => { calls++; return { ...node, width: 999 }; });
        flushSync(() => root.unmount()); mounted = false;
        api!.updateNode("node", (node) => { calls++; return node; });
        await wait(180);
        check(calls === 2, "media writes: unmount releases timers and rejects late writes");
    } finally {
        if (mounted) flushSync(() => root.unmount());
        host.remove();
    }
    return results;
}

async function runViewportChecks() {
    const results: string[] = [];
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:600px;height:400px";
    document.body.append(host);
    const root = createRoot(host);
    let commit: (viewport: { x: number; y: number; k: number }) => void;
    function Harness() {
        const [viewport, setViewport] = useState({ x: 30, y: 20, k: 0.5 });
        const containerRef = useRef<HTMLDivElement>(null);
        commit = setViewport;
        return <InfiniteCanvas containerRef={containerRef} viewport={viewport} onViewportChange={setViewport}>
            <div data-node-id="geometry" style={{ position: "absolute", left: 100, top: 80, width: 120, height: 90 }} />
        </InfiniteCanvas>;
    }
    try {
        flushSync(() => root.render(<Harness />));
        const container = host.querySelector<HTMLDivElement>("[data-canvas-viewport]")!;
        const checkGeometry = (viewport: { x: number; y: number; k: number }, label: string) => {
            const bounds = container.getBoundingClientRect();
            const node = host.querySelector<HTMLElement>("[data-node-id]")!.getBoundingClientRect();
            const error = Math.max(Math.abs(node.left - bounds.left - viewport.x - 100 * viewport.k), Math.abs(node.top - bounds.top - viewport.y - 80 * viewport.k), Math.abs(node.width - 120 * viewport.k), Math.abs(node.height - 90 * viewport.k));
            if (error > 0.1) throw new Error(`${label}: geometry mismatch ${error}px`);
            results.push(label);
        };
        checkGeometry({ x: 30, y: 20, k: 0.5 }, "viewport: initial committed coordinates and scale are aligned");
        for (const viewport of [{ x: -70, y: 60, k: 0.5 }, { x: 45, y: -25, k: 0.05 }, { x: 30, y: 20, k: 2 }]) {
            setCanvasViewportInteracting(container, true);
            applyCanvasLiveViewport(container, viewport);
            checkGeometry(viewport, `viewport: live preview aligned at scale ${viewport.k}`);
            setCanvasViewportInteracting(container, false);
            flushSync(() => commit(viewport));
            checkGeometry(viewport, `viewport: committed transform does not jump at scale ${viewport.k}`);
        }
        if (getComputedStyle(host.querySelector("[data-node-id]")!).getPropertyValue("--canvas-live-x")) throw new Error("Pan coordinates leaked into node inheritance");
        results.push("viewport: pan coordinates are not inherited by node descendants");
    } finally {
        flushSync(() => root.unmount());
        host.remove();
    }
    return results;
}

async function runMediaAndDiagnosticsChecks() {
    const results: string[] = [];
    const check = (value: unknown, message: string) => { if (!value) throw new Error(message); results.push(message); };
    const until = async (condition: () => boolean) => {
        const deadline = performance.now() + 5000;
        while (!condition()) { if (performance.now() > deadline) throw new Error("Media test timed out"); await wait(20); }
    };
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 16;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#37866d"; ctx.fillRect(0, 0, 16, 16);
    const good = canvas.toDataURL("image/png");
    const goodBlob = await (await fetch(good)).blob();
    const invalidBlob = new Blob(["invalid image fixture"], { type: "image/png" });
    const key = "image:guest:canvas-browser-tests";
    const host = document.createElement("div"); document.body.append(host);
    const urls: string[] = [];
    let root = createRoot(host);
    try {
        urls.push(await setImageBlob(key, invalidBlob));
        flushSync(() => root.render(<CachedResourceImage storageKey={key} src={good} fallback={<span>Failed</span>} />));
        await until(() => Boolean(host.querySelector("img")?.naturalWidth));
        check(host.querySelector("img")?.src === good, "failed local candidate displays the successfully decoded fallback URL");
        flushSync(() => root.unmount());
        for (const action of ["unmount", "identity-switch"]) {
            root = createRoot(host);
            urls.push(await setImageBlob(key, goodBlob));
            let errors = 0;
            flushSync(() => root.render(<CachedResourceImage storageKey={key} onError={() => { errors++; }} />));
            await until(() => Boolean(host.querySelector("img")?.naturalWidth));
            urls.push(await setImageBlob(key, invalidBlob));
            flushSync(() => host.querySelector("img")!.dispatchEvent(new Event("error")));
            if (action === "unmount") flushSync(() => root.unmount());
            else flushSync(() => root.render(<CachedResourceImage src={good} onError={() => { errors++; }} />));
            await wait(100);
            check(errors === 0, `${action}: stale image recovery cannot invoke error callbacks`);
            if (action === "identity-switch") {
                await until(() => Boolean(host.querySelector("img")?.naturalWidth));
                check(host.querySelector("img")?.src === good, "identity switch keeps the new image");
                flushSync(() => root.unmount());
            }
        }
        check(canvasImagePreparationStats().active === 0 && canvasImagePreparationStats().consumers === 0, "image consumers and jobs return to zero after unmount");
        check(!window.__canvasDiagnostics, "diagnostics are not enabled by importing the module");
        const stop = startCanvasPerformanceDiagnostics(host, () => ({ nodes: 3, connections: 4 }));
        const diagnostic = window.__canvasDiagnostics!;
        diagnostic.watchNodeRenders(["private-node-marker"]);
        recordCanvasRender("node", "private-node-marker");
        const renders = diagnostic.snapshot() as { renderAttempts: { total: { node: number }; watched: { node: number }[] } };
        check(renders.renderAttempts.total.node === 1 && renders.renderAttempts.watched[0].node === 1 && !JSON.stringify(renders).includes("private-node-marker"), "diagnostics render probe emits numeric counts without node identifiers");
        diagnostic.reset();
        check((diagnostic.snapshot() as typeof renders).renderAttempts.watched[0].node === 0, "diagnostics reset clears render counts but retains watched slots");
        measureCanvasComputation("spatial-index", () => 1);
        host.dispatchEvent(new Event("pointerdown")); await wait(100);
        const snapshot = diagnostic.snapshot() as { inputPaintOpportunityMs: { count: number }; frameMs: { count: number }; computations: Record<string, { count: number }> };
        check(snapshot.inputPaintOpportunityMs.count === 1 && snapshot.computations["spatial-index"].count === 1, "diagnostics collect input and computation samples");
        stop();
        const before = (diagnostic.snapshot() as typeof snapshot).frameMs.count;
        await wait(100);
        check(!window.__canvasDiagnostics && (diagnostic.snapshot() as typeof snapshot).frameMs.count === before, "diagnostics cleanup removes globals, listeners and animation frames");
    } finally {
        await deleteStoredImages([key]);
        urls.forEach((url) => URL.revokeObjectURL(url));
        host.remove();
    }
    return results;
}
