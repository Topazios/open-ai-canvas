type Summary = { count: number; p50: number | null; p95: number | null; max: number | null };
const SAMPLE_LIMIT = 36_000;

export function summarizeCanvasSamples(values: readonly number[]): Summary {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
    return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null };
}

export type CanvasComputation = "spatial-index" | "connection-spatial-index" | "visible-nodes";
let recordComputation: ((name: CanvasComputation, elapsed: number) => void) | undefined;
export type CanvasRenderSurface = "node" | "content" | "frame" | "upstream";
let recordRender: ((surface: CanvasRenderSurface, nodeId: string) => void) | undefined;

// Render attempts, not commits. IDs stay inside the collector; reports use numeric slots.
export function recordCanvasRender(surface: CanvasRenderSurface, nodeId: string) {
    recordRender?.(surface, nodeId);
}

export function measureCanvasComputation<T>(name: CanvasComputation, compute: () => T): T {
    if (!recordComputation) return compute();
    const start = performance.now();
    try { return compute(); }
    finally { recordComputation(name, performance.now() - start); }
}

/** Explicit opt-in; only numeric aggregates leave this collector, never document content or URLs. */
export function startCanvasPerformanceDiagnostics(root: HTMLElement, readCounts: () => { nodes: number; connections: number }) {
    const frames: number[] = [];
    const feedback: number[] = [];
    const longTasks: number[] = [];
    const computations: Record<CanvasComputation, number[]> = { "spatial-index": [], "connection-spatial-index": [], "visible-nodes": [] };
    const observers: PerformanceObserver[] = [];
    const pendingFrames = new Set<number>();
    const renderCounts = { node: 0, content: 0, frame: 0, upstream: 0 };
    let watchedNodes = new Map<string, typeof renderCounts>();
    const renderRecorder = (surface: CanvasRenderSurface, nodeId: string) => {
        renderCounts[surface]++;
        const watched = watchedNodes.get(nodeId);
        if (watched) watched[surface]++;
    };
    recordRender = renderRecorder;
    let resources = 0;
    let dropped = 0;
    let hidden = 0;
    let lastFrame = 0;
    let active = true;
    let start = performance.now();
    const append = (values: number[], value: number) => {
        if (values.length < SAMPLE_LIMIT) values.push(value);
        else dropped += 1;
    };
    const recorder = (name: CanvasComputation, elapsed: number) => append(computations[name], elapsed);
    recordComputation = recorder;
    const frame = (now: number) => {
        if (document.visibilityState === "visible") {
            if (lastFrame) append(frames, now - lastFrame);
            lastFrame = now;
        } else { hidden += 1; lastFrame = 0; }
        if (active) raf = requestAnimationFrame(frame);
    };
    let raf = requestAnimationFrame(frame);
    const observe = (type: string, receive: (entries: PerformanceEntry[]) => void) => {
        if (!PerformanceObserver.supportedEntryTypes.includes(type)) return false;
        const observer = new PerformanceObserver((list) => receive(list.getEntries()));
        observer.observe({ type });
        observers.push(observer);
        return true;
    };
    const longTasksSupported = observe("longtask", (entries) => entries.forEach((entry) => append(longTasks, entry.duration)));
    observe("resource", (entries) => { resources += entries.length; });
    const onInput = () => {
        const inputAt = performance.now();
        // Double rAF is a paint-opportunity proxy, not proof that a particular operation committed.
        const first = requestAnimationFrame(() => {
            pendingFrames.delete(first);
            const second = requestAnimationFrame(() => {
                pendingFrames.delete(second);
                if (active && document.visibilityState === "visible") append(feedback, performance.now() - inputAt);
            });
            pendingFrames.add(second);
        });
        pendingFrames.add(first);
    };
    const events = ["pointerdown", "pointerup", "wheel", "keydown"] as const;
    events.forEach((event) => root.addEventListener(event, onInput, { capture: true, passive: true }));
    const api = {
        watchNodeRenders(nodeIds: string[]) {
            watchedNodes = new Map(nodeIds.slice(0, 2000).map((id) => [id, { node: 0, content: 0, frame: 0, upstream: 0 }]));
        },
        reset() {
            frames.length = feedback.length = longTasks.length = 0;
            Object.values(computations).forEach((values) => { values.length = 0; });
            pendingFrames.forEach(cancelAnimationFrame);
            pendingFrames.clear();
            observers.forEach((observer) => observer.takeRecords());
            resources = dropped = hidden = lastFrame = 0;
            for (const counts of [renderCounts, ...watchedNodes.values()]) {
                for (const key of Object.keys(counts) as CanvasRenderSurface[]) counts[key] = 0;
            }
            start = performance.now();
        },
        snapshot() {
            return {
                version: 1,
                elapsedMs: performance.now() - start,
                document: readCounts(),
                mountedNodes: root.querySelectorAll("[data-node-id]").length,
                lod: Object.fromEntries(["shell", "preview", "full"].map((lod) => [lod, root.querySelectorAll(`[data-node-lod="${lod}"]`).length])),
                videoElements: root.querySelectorAll("video").length,
                audioElements: root.querySelectorAll("audio").length,
                playingMedia: [...root.querySelectorAll<HTMLMediaElement>("video,audio")].filter((media) => !media.paused).length,
                frameMs: summarizeCanvasSamples(frames),
                inputPaintOpportunityMs: summarizeCanvasSamples(feedback),
                longTaskMs: summarizeCanvasSamples(longTasks),
                longTasksSupported,
                resourceRequestsCompleted: resources,
                computations: Object.fromEntries(Object.entries(computations).map(([key, values]) => [key, summarizeCanvasSamples(values)])),
                renderAttempts: { total: { ...renderCounts }, watched: [...watchedNodes.values()].map((counts) => ({ ...counts })) },
                droppedSamples: dropped,
                hiddenFrames: hidden,
                viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
            };
        },
    };
    window.__canvasDiagnostics = api;
    return () => {
        active = false;
        cancelAnimationFrame(raf);
        pendingFrames.forEach(cancelAnimationFrame);
        observers.forEach((observer) => observer.disconnect());
        events.forEach((event) => root.removeEventListener(event, onInput, true));
        if (recordComputation === recorder) recordComputation = undefined;
        if (recordRender === renderRecorder) recordRender = undefined;
        watchedNodes.clear();
        if (window.__canvasDiagnostics === api) delete window.__canvasDiagnostics;
    };
}

declare global {
    interface Window {
        __canvasDiagnostics?: { reset(): void; watchNodeRenders(nodeIds: string[]): void; snapshot(): unknown };
    }
}
