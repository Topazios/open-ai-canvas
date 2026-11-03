import { describe, expect, test } from "bun:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { materializeWorkflowAssetGroup } from "@/lib/canvas/canvas-workflow-assets";
import { ShortDramaStep } from "@/lib/short-drama-steps";

function fixture(frameExtra: object = {}): { nodes: CanvasNodeData[]; manifest: CanvasNodeData } {
    const base = { stage: "story", step: ShortDramaStep.Plan, pipelineId: "p", sourceSignatures: {}, sourceNodeIds: [] };
    const frame: CanvasNodeData = { id: "plan", type: CanvasNodeType.Frame, title: "Plan", position: { x: 100, y: 100 }, width: 3840, height: 484,
        metadata: { frame: { collapsed: false, expandedWidth: 3840, expandedHeight: 484, layout: "grid" },
            shortDrama: { ...base, role: "collection", assetGroup: { manifestId: "summary" }, ...frameExtra } as never } };
    const items = [1, 2, 3, 4].map((n) => ({ priority: n, name: `Spec ${n}`, content: `spec ${n}` }));
    const manifest: CanvasNodeData = { id: "summary", parentId: "plan", type: CanvasNodeType.Text, title: "Story", position: { x: 124, y: 200 }, width: 1248, height: 320,
        metadata: { content: JSON.stringify({ summary: "ok", items }), status: "success", shortDrama: { ...base, role: "document", assetOutput: true } as never } };
    return { nodes: [frame, manifest], manifest };
}

describe("materializing the plan container", () => {
    test("a full-width story lead does not widen the container beyond three columns", () => {
        const { nodes, manifest } = fixture();
        const result = materializeWorkflowAssetGroup(nodes, manifest, "task-1");
        const frame = result.find((node) => node.id === "plan")!;
        expect(frame.width).toBe(1296);
        expect(frame.metadata?.frame?.expandedWidth).toBe(1296);
        const cards = result.filter((node) => node.id.startsWith("summary:asset:"));
        expect(cards).toHaveLength(4);
        expect(Math.max(...cards.map((card) => card.position.x + card.width))).toBeLessThanOrEqual(frame.position.x + frame.width);
    });

    test("other asset groups still size columns from the manifest", () => {
        const { nodes, manifest } = fixture({ step: ShortDramaStep.Episodes });
        const frame = materializeWorkflowAssetGroup(nodes, manifest, "task-1").find((node) => node.id === "plan")!;
        expect(frame.width).toBeGreaterThan(1296);
    });
});
