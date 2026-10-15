import { StrictMode, useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useCanvasEditorFocus } from "@/pages/canvas/use-canvas-editor-focus";
import { useCanvasRenderModel } from "@/pages/canvas/use-canvas-render-model";
import { CanvasProjectWorldLayers } from "@/pages/canvas/canvas-project-world-layers";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const noop = () => {};
const emptySet = new Set<string>();
const emptyMap = new Map();
export const baseOptions: Omit<Parameters<typeof useCanvasRenderModel>[0], "nodes" | "viewport" | "editingNodeId"> = {
    connections: [], assets: [], viewportSize: { width: 900, height: 600 }, mediaPerformanceMode: "auto",
    selectedNodeIds: emptySet, hoveredNodeId: null, dragPreview: null, collapsingBatchIds: emptySet, addedSkills: [],
    infoNodeId: null, cropNodeId: null, maskEditNodeId: null, imageEditNodeId: null, annotationNodeId: null,
    splitNodeId: null, upscaleNodeId: null, superResolveNodeId: null, angleNodeId: null, lightingNodeId: null,
    emotionNodeId: null, previewNodeId: null, contextMenu: null, versionCompareRootId: null, directorNodeId: null,
    scriptEditorNodeId: null, dialogNodeId: null,
};
const worldCallbacks = {
    onConnectionSelect: noop, onConnectionContextMenu: noop, onNodeMouseDown: noop, onNodeHoverStart: noop, onNodeHoverEnd: noop,
    onConnectStart: noop, onNodeResize: noop, onToggleFrame: noop, onFolderStyleChange: noop, onFolderThemeChange: noop,
    onNodeContextMenu: noop, onNodeContentChange: noop, onToggleBatch: noop, onSetBatchPrimary: noop, onRetry: noop,
    onReloadResource: noop, onOpenTaskDetails: noop, onOpenVersions: noop, onViewImage: noop, onReplaceMedia: noop,
    onOpenTextEditor: noop, onOpenDirector: noop, onOpenDrawing: noop, onStartBatchConnection: noop,
    renderCanvasNodeContentById: emptyMap,
};

export async function runCanvasLifecycleChecks() {
    const results: string[] = [];
    const check = (value: unknown, label: string) => { if (!value) throw new Error(label); results.push(label); };
    const until = async (condition: () => boolean, detail: () => string = () => "") => {
        const deadline = performance.now() + 10000;
        while (!condition()) { if (performance.now() > deadline) throw new Error(`Canvas lifecycle test timed out: ${detail()}`); await wait(20); }
    };
    const videoBlob = await (await fetch("/__canvas-test-video.webm")).blob();
    const videoURL = URL.createObjectURL(videoBlob);
    const replacementURL = URL.createObjectURL(videoBlob);
    const probe = document.createElement("video"); probe.src = videoURL;
    try { await until(() => probe.readyState > 0, () => `fixture: ${probe.error?.message}`); }
    finally { probe.removeAttribute("src"); probe.load(); }
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const initial: CanvasNodeData[] = [
        { id: "text", type: CanvasNodeType.Text, title: "Draft", position: { x: 10, y: 40 }, width: 300, height: 150 },
        ...["video-a", "video-b"].map((id, i) => ({ id, type: CanvasNodeType.Video, title: id, position: { x: 20 + 340 * i, y: 250 }, width: 300, height: 170,
            metadata: { content: videoURL, mimeType: "video/webm", hasAudio: false, naturalWidth: 160, naturalHeight: 90 } })),
    ];
    let api: { camera(viewport: ViewportTransform): void; project(id: string): void; nodes(nodes: CanvasNodeData[]): void; editing(): string | null; data(): CanvasNodeData[] };
    function Harness() {
        const containerRef = useRef<HTMLDivElement>(null);
        const selectionRef = useRef<HTMLDivElement>(null);
        const [projectId, setProjectId] = useState("first");
        const [nodes, setNodes] = useState(initial);
        const [viewport, setViewport] = useState({ x: 0, y: 0, k: 1 });
        const editingNodeId = useCanvasEditorFocus(projectId, containerRef);
        const model = useCanvasRenderModel({ ...baseOptions, nodes, viewport, editingNodeId });
        api = { camera: setViewport, project: setProjectId, nodes: setNodes, editing: () => editingNodeId, data: () => nodes };
        const props: ComponentProps<typeof CanvasProjectWorldLayers> = {
            ...worldCallbacks, projectId, viewportScale: viewport.k, connectionLayerBounds: model.connectionLayerBounds,
            displayConnections: model.displayConnections, selectedConnectionId: null, relatedConnectionIds: emptySet,
            scriptScrollTopById: {}, connectingParams: null, mouseWorld: { x: 0, y: 0 }, connectionTargetNodeId: null,
            connectionApproach: null, nodeById: model.nodeById, visibleNodes: model.visibleNodes, viewportNodeIds: model.viewportNodeIds,
            upstreamNodesById: model.upstreamNodesById,
            nodeRenderLODById: model.nodeRenderLODById, nodeStackOrder: [], frameChildrenById: model.frameChildrenById,
            linkedFolderPreviewNodesById: emptyMap, dragPreview: null, selectedNodeIds: emptySet, frameDropTargetId: null,
            relatedNodeIds: emptySet, activeNodeId: null, selectionBox: null, batchChildCountById: model.batchChildCountById,
            collapsingBatchIds: emptySet, openingBatchIds: emptySet, batchMotionById: model.batchMotionById, showImageInfo: false,
            reduceMediaEffects: false, resourceReferenceByNodeId: model.resourceReferenceByNodeId, mentionReferencesByNodeId: model.mentionReferencesByNodeId,
            selectedNodeBounds: null, batchSourceNodeIds: [], batchConnectionPreview: null, isNodeDragging: false, selectionBoundsElementRef: selectionRef,
            onNodeTitleChange: (id, title) => setNodes((current) => current.map((node) => node.id === id ? { ...node, title } : node)),
        };
        return <div ref={containerRef} style={{ position: "relative", width: 900, height: 600 }}><CanvasProjectWorldLayers {...props} /></div>;
    }
    const camera = (viewport = { x: 0, y: 0, k: 1 }) => flushSync(() => api.camera(viewport));
    const nodeElement = (id: string) => host.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
    const play = async (id: string) => {
        const button = nodeElement(id)?.querySelector<HTMLButtonElement>(`button[aria-label="播放 ${id}"]`);
        if (!button) throw new Error(`No video activation button for ${id}`);
        flushSync(() => button.click());
        await until(() => Boolean(nodeElement(id)?.querySelector("video")?.readyState), () => {
            const element = nodeElement(id);
            const video = element?.querySelector("video");
            return JSON.stringify({ id, lod: element?.dataset.nodeLod, videos: host.querySelectorAll("video").length,
                player: Boolean(element?.querySelector(".canvas-video-player")), src: video?.getAttribute("src"),
                ready: video?.readyState, error: video?.error?.message, content: element?.textContent?.slice(0, 150) });
        });
        const video = nodeElement(id)!.querySelector("video")!;
        video.muted = true;
        await video.play();
        return video;
    };
    try {
        flushSync(() => root.render(<StrictMode><Harness /></StrictMode>)); await wait();
        flushSync(() => nodeElement("text")!.querySelector<HTMLButtonElement>('button[aria-label="编辑节点名称：Draft"]')!.click());
        const input = nodeElement("text")!.querySelector<HTMLInputElement>('input[aria-label="节点名称"]')!;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        flushSync(() => { setter.call(input, "未提交的中文草稿"); input.dispatchEvent(new Event("input", { bubbles: true })); });
        await wait();
        check(api.editing() === "text" && document.activeElement === input, "editor: actual title focus pins an unselected node");
        flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
        check(document.activeElement === input && api.data()[0].title === "Draft", "editor: IME Enter does not commit or blur the title");
        camera({ x: -100000, y: -100000, k: 0.1 }); await wait();
        check(nodeElement("text")?.dataset.nodeLod === "full" && document.activeElement === input && input.value === "未提交的中文草稿", "editor: offscreen overview preserves the same editor DOM, focus and draft");
        window.dispatchEvent(new Event("blur")); await wait();
        check(api.editing() === "text", "editor: window blur does not discard an inline draft");
        flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
        await wait();
        check(api.data()[0].title === "未提交的中文草稿" && !nodeElement("text") && api.editing() === null, "editor: commit saves the draft and releases offscreen pinning");
        camera(); await wait();
        check(nodeElement("text")?.textContent?.includes("未提交的中文草稿"), "editor: returning to the viewport restores the committed title");

        let previous = await play("video-a");
        check(host.querySelectorAll("video").length === 1, "media: explicit activation mounts one real player");
        const second = await play("video-b"); await wait();
        check(!previous.isConnected && previous.paused && host.querySelectorAll("video").length === 1, "media: switching nodes stops and detaches the previous player");
        // Still inside the overscan margin: it is playback, not node mounting, that stops.
        camera({ x: -800, y: 0, k: 1 }); await wait(150);
        check(Boolean(nodeElement("video-b")) && !host.querySelector("video") && second.paused, "media: leaving the real viewport stops playback even while the node is retained");
        camera(); await wait();
        check(!host.querySelector("video"), "media: reentering the viewport does not resume playback implicitly");
        previous = await play("video-a");
        flushSync(() => api.nodes(api.data().map((node) => node.id === "video-a" ? { ...node, metadata: { ...node.metadata, storageKey: "video:guest:missing-lifecycle-fixture", content: replacementURL } } : node)));
        check(!previous.isConnected && !nodeElement("video-a")?.querySelector("video"), "media: replacing a source removes the old player before async resolution");
        await until(() => Boolean(nodeElement("video-a")?.querySelector("video")?.readyState));
        check(nodeElement("video-a")?.querySelector("video")?.currentSrc === replacementURL, "media: replacement mounts only the resolved new source");
        previous = nodeElement("video-a")!.querySelector("video")!;
        flushSync(() => api.project("second")); await wait(150);
        check(!host.querySelector("video") && previous.paused, "media: project switch clears activation even for reused node IDs");
        previous = await play("video-a");
        flushSync(() => api.nodes(api.data().filter((node) => node.id !== "video-a"))); await wait(150);
        check(!host.querySelector("video") && previous.paused, "media: deleting the active node stops its player");
        flushSync(() => api.nodes(initial)); await wait();
        check(!host.querySelector("video"), "media: restoring a node does not restore transient autoplay intent");
        const retired: HTMLVideoElement[] = [];
        for (let cycle = 0; cycle < 10; cycle++) {
            retired.push(await play(cycle % 2 ? "video-b" : "video-a"));
            camera({ x: -800, y: 0, k: 1 }); await wait(100);
            camera(); await wait(60);
        }
        // Chrome can retain the historical currentSrc string after load() on a
        // detached element. Check decoder/network state and actual source ownership.
        const released = (video: HTMLVideoElement) => !video.isConnected && video.paused && video.readyState === HTMLMediaElement.HAVE_NOTHING && video.networkState === HTMLMediaElement.NETWORK_EMPTY && !video.srcObject && !video.getAttribute("src") && !video.querySelector("source[src]");
        check(!host.querySelector("video") && retired.every(released), "media: ten browse/play cycles leave no mounted players, sources or active decoders");
        previous = await play("video-b");
        flushSync(() => root.unmount()); await wait(150);
        check(released(previous), "media: closing the canvas releases the active player's source");
    } finally {
        flushSync(() => root.unmount()); host.remove(); URL.revokeObjectURL(videoURL); URL.revokeObjectURL(replacementURL);
    }
    return results;
}
