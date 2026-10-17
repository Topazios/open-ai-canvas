import { expect, test } from "bun:test";
import { generationBatchCandidates } from "../src/lib/canvas/canvas-generation-batch";
import { CanvasNodeType, type CanvasNodeData, type CanvasGenerationBatch } from "../src/types/canvas";
import { freshRuntimeLimits } from "../src/services/runtime-limits";
import { installRuntimeLimits } from "./fixtures/runtime-limits";

function fixture(mode: CanvasGenerationBatch["mode"], legacyConcurrency: number): CanvasNodeData[] {
    const targets: CanvasNodeData[] = Array.from({ length: 6 }, (_, i) => ({ id: `${mode}-${i}`, type: CanvasNodeType.Image, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: {} }));
    const batch: CanvasGenerationBatch = { id: mode, projectId: "project", sourceNodeId: `source-${mode}`, mode, status: "queued", concurrency: legacyConcurrency, createdAt: "", updatedAt: "", items: targets.map((node) => ({ id: node.id, rowId: node.id, nodeId: node.id, status: "waiting", retryCount: 0 })) };
    return [{ ...targets[0], id: batch.sourceNodeId, metadata: { batchTable: { operation: "creative", concurrency: legacyConcurrency, rows: [] }, generationBatches: [batch] } }, ...targets];
}

test("legacy table/batch overrides never cap or expand system image/video capacity", () => {
    installRuntimeLimits({ image: 3, video: 2 }, 0);
    for (const legacy of [1, 999]) {
        const selected = generationBatchCandidates([...fixture("batch_image", legacy), ...fixture("storyboard_video", legacy)], "project", freshRuntimeLimits()!, [], { image: 0, video: 0 });
        expect(selected.filter((item) => item.batch.mode === "batch_image")).toHaveLength(3);
        expect(selected.filter((item) => item.batch.mode === "storyboard_video")).toHaveLength(2);
    }
});

test("admission, account-wide category counts and pending reservations still apply", () => {
    installRuntimeLimits({ image: 9, video: 9 }, 3);
    const selected = generationBatchCandidates([...fixture("batch_image", 999), ...fixture("storyboard_video", 999)], "project", freshRuntimeLimits()!, [
        { type: "canvas_image", status: "queued" }, { type: "canvas_text", status: "running", operation: "cloud_agent_step" },
    ], { image: 1, video: 0 });
    expect(selected.filter((item) => item.batch.mode === "batch_image")).toHaveLength(1);
    expect(selected.filter((item) => item.batch.mode === "storyboard_video")).toHaveLength(3);
});

test("already submitted, completed and duplicate targets cannot be billed again", () => {
    installRuntimeLimits({ image: 20 }, 0);
    const nodes = fixture("batch_image", 999);
    nodes[1].metadata = { taskId: "persisted" };
    nodes[2].metadata = { status: "success", content: "saved" };
    nodes[0].metadata!.generationBatches!.push({ ...nodes[0].metadata!.generationBatches![0], id: "duplicate" });
    const selected = generationBatchCandidates(nodes, "project", freshRuntimeLimits()!, [], { image: 0, video: 0 });
    expect(selected).toHaveLength(4);
    expect(new Set(selected.map((item) => item.node.id)).size).toBe(4);
});
