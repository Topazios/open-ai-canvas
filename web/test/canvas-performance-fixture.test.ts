import { describe, expect, test } from "bun:test";
import { CANVAS_BENCHMARK_SIZES, createCanvasPerformanceProject, createCanvasPerformanceAssets } from "./fixtures/canvas-performance-project";
import { summarizeCanvasSamples, measureCanvasComputation } from "../src/lib/canvas/canvas-performance-diagnostics";

describe("canvas benchmark contract", () => {
    for (const count of CANVAS_BENCHMARK_SIZES) test(`${count}: deterministic, complete, non-generating fixtures`, () => {
        const project = createCanvasPerformanceProject(count);
        expect(project).toEqual(createCanvasPerformanceProject(count));
        const counts = (type: string) => project.nodes.filter((node) => node.type === type).length;
        expect([counts("image"), counts("video"), counts("text"), counts("batch-table"), counts("frame")]).toEqual([count * .5, count * .15, count * .2, count * .1, count * .05]);
        expect(project.connections).toHaveLength(count * 1.5);
        const ids = new Set(project.nodes.map((node) => node.id));
        const assets = new Set(createCanvasPerformanceAssets(project).map((asset) => asset.id));
        expect(ids.size).toBe(count);
        for (const edge of project.connections) {
            expect(ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)).toBe(true);
        }
        for (const node of project.nodes) {
            if (node.parentId) expect(ids.has(node.parentId)).toBe(true);
            expect(node.metadata?.status).toBe("idle");
            expect(node.metadata?.batchTable?.rows.every((row) => !row.enabled) ?? true).toBe(true);
            if (node.metadata?.assetId) expect(assets.has(node.metadata.assetId)).toBe(true);
            expect(Object.keys(node.metadata || {}).some((key) => /task|generation|storageKey/i.test(key))).toBe(false);
        }
        const overview = createCanvasPerformanceProject(count, "overview");
        expect(overview.nodes).toEqual(project.nodes);
        expect(overview.viewport.k).toBeLessThan(project.viewport.k);
        expect(overview.viewport.k).toBeGreaterThanOrEqual(0.05);
        for (const node of overview.nodes) {
            expect(node.position.x * overview.viewport.k + overview.viewport.x + node.width * overview.viewport.k).toBeLessThanOrEqual(1440);
            expect(node.position.y * overview.viewport.k + overview.viewport.y + node.height * overview.viewport.k).toBeLessThanOrEqual(1000);
        }
    });
    test("empty samples are not false passes; invalid numbers are excluded", () => {
        expect(summarizeCanvasSamples([])).toEqual({ count: 0, p50: null, p95: null, max: null });
        expect(summarizeCanvasSamples([1, 2, 3, 4, NaN, Infinity])).toEqual({ count: 4, p50: 2, p95: 4, max: 4 });
    });
    test("disabled diagnostics preserve computation results and exceptions without browser globals", () => {
        const result = {};
        expect(measureCanvasComputation("spatial-index", () => result)).toBe(result);
        expect(() => measureCanvasComputation("visible-nodes", () => { throw new Error("test"); })).toThrow("test");
    });
});
