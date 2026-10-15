import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "../../src/types/canvas";
import type { CanvasProject } from "../../src/stores/canvas/use-canvas-store";
import { canvasNodeToAsset } from "../../src/lib/canvas/canvas-node-asset";

export const CANVAS_BENCHMARK_SIZES = [100, 500, 2000] as const;
export const CANVAS_BENCHMARK_FIXTURE_VERSION = 2;
export type CanvasBenchmarkSize = typeof CANVAS_BENCHMARK_SIZES[number];
const timestamp = "2026-10-09T00:00:00.000Z";

export function createCanvasPerformanceProject(count: CanvasBenchmarkSize, view: "spread" | "overview" = "spread"): CanvasProject {
    const columns = Math.ceil(Math.sqrt(count / 20));
    const nodes: CanvasNodeData[] = [];
    for (let i = 0; i < count; i += 1) {
        const slot = i % 20;
        const group = Math.floor(i / 20);
        const origin = { x: (group % columns) * 2720, y: Math.floor(group / columns) * 1540 };
        const type = slot < 10 ? CanvasNodeType.Image : slot < 13 ? CanvasNodeType.Video : slot < 17 ? CanvasNodeType.Text : slot < 19 ? CanvasNodeType.BatchTable : CanvasNodeType.Frame;
        const frame = type === CanvasNodeType.Frame;
        const metadata: NonNullable<CanvasNodeData["metadata"]> = { status: "idle", ...(!frame ? { manualSize: true } : {}) };
        if (type === CanvasNodeType.Image) Object.assign(metadata, { content: `/__benchmark/media/image-${i % 8}.png`, naturalWidth: 640, naturalHeight: 360 });
        if (type === CanvasNodeType.Video) Object.assign(metadata, { content: "/__benchmark/media/motion.webm", previewContent: `/__benchmark/media/image-${i % 8}.png`, durationMs: 2000, hasAudio: false, naturalWidth: 640, naturalHeight: 360 });
        if (type === CanvasNodeType.Text) Object.assign(metadata, { content: `Fixture text ${i}: local editing and composition.\nSecond paragraph for selection and scrolling.`, prompt: `Fixture prompt ${i}` });
        if (type === CanvasNodeType.BatchTable) metadata.batchTable = {
            operation: "creative", concurrency: 1, contentKind: "storyboard", aiGenerated: true,
            referenceColumns: [], textColumns: [{ id: "shot", label: "Shot" }, { id: "action", label: "Action" }],
            rows: Array.from({ length: 8 }, (_, row) => ({ id: `row-${i}-${row}`, enabled: false, inputNodeIds: [], prompt: "", cells: { shot: String(row + 1), action: `Local storyboard ${row + 1}` } })),
        };
        if (slot < 17) metadata.assetId = `benchmark-asset-${count}-${i}`;
        if (frame) metadata.frame = { collapsed: false, expandedWidth: 2680, expandedHeight: 1500 };
        nodes.push({ id: `bench-${i}`, type, title: `Fixture ${type} ${i}`, createdAt: timestamp, updatedAt: timestamp,
            position: frame ? origin : type === CanvasNodeType.BatchTable
                ? { x: origin.x + 40 + (slot - 17) * 1340, y: origin.y + 1040 }
                : { x: origin.x + 40 + slot % 6 * 440, y: origin.y + 80 + Math.floor(slot / 6) * 320 },
            width: frame ? 2680 : type === CanvasNodeType.BatchTable ? 1280 : 420, height: frame ? 1500 : type === CanvasNodeType.BatchTable ? 420 : 236.25,
            ...(frame ? {} : { parentId: `bench-${group * 20 + 19}` }), metadata });
    }
    const connections: CanvasConnection[] = [];
    for (let i = 0; i < count * 1.5; i += 1) {
        const from = i % count;
        const to = (from + (i < count ? 1 : 7)) % count;
        connections.push({ id: `edge-${i}`, fromNodeId: `bench-${from}`, toNodeId: `bench-${to}` });
    }
    const rows = Math.ceil(count / 20 / columns);
    const k = view === "spread" ? 0.6 : Math.min(1360 / (columns * 2720), 780 / (rows * 1540));
    return { id: `benchmark-${count}-${view}`, revision: 1, title: `Canvas benchmark ${count} ${view}`, createdAt: timestamp, updatedAt: timestamp,
        nodes, connections, chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false,
        viewport: { x: 60, y: 80, k }, directorScenes: [] };
}

export function createCanvasPerformanceAssets(project: CanvasProject) {
    return project.nodes.flatMap((node) => {
        if (!node.metadata?.assetId) return [];
        const asset = canvasNodeToAsset(node, { canvasId: project.id, source: "canvas-upload" });
        return asset ? [{ ...asset, id: node.metadata.assetId, createdAt: timestamp, updatedAt: timestamp }] : [];
    });
}
