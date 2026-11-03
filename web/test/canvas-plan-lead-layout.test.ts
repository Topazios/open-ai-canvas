import { describe, expect, test } from "bun:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { groupGridMetrics, isPlanLeadNode, layoutCanvasGridGroups, snapGridDrop } from "@/lib/canvas/canvas-group-grid";
import { ShortDramaStep } from "@/lib/short-drama-steps";

function planFixture(specs = 4, opts: { lead?: boolean; gridWidth?: number; leadPlaceholder?: boolean } = {}): CanvasNodeData[] {
    const { lead = true, gridWidth, leadPlaceholder = false } = opts;
    const shortDrama = (extra: object) => ({ stage: "story", step: ShortDramaStep.Plan, role: "document", pipelineId: "p", sourceSignatures: {}, sourceNodeIds: [], ...extra });
    const frame: CanvasNodeData = { id: "plan", type: CanvasNodeType.Frame, title: "Plan", position: { x: 100, y: 100 }, width: 3840, height: 484,
        metadata: { frame: { collapsed: false, expandedWidth: 3840, expandedHeight: 484, layout: "grid", ...(gridWidth ? { gridWidth } : {}) },
            shortDrama: shortDrama({ role: "collection", assetGroup: { manifestId: "summary" } }) as never } };
    const nodes: CanvasNodeData[] = [frame];
    if (lead) nodes.push({ id: "story", parentId: "plan", type: CanvasNodeType.Text, title: "Story", position: { x: 0, y: 0 }, width: 1248, height: 320,
        metadata: { content: leadPlaceholder ? "" : "outline", status: leadPlaceholder ? "idle" : "success",
            shortDrama: shortDrama(leadPlaceholder ? { assetKey: "story" } : { planSection: "story" }) as never } });
    for (let i = 0; i < specs; i++) nodes.push({ id: `spec${i}`, parentId: "plan", type: CanvasNodeType.Text, title: `Spec ${i}`, position: { x: i * 7, y: i * 5 },
        width: 400, height: 280, metadata: { content: "spec", status: "success", shortDrama: shortDrama({ planSection: "rules" }) as never } });
    return nodes;
}

describe("plan container with a full-width story lead", () => {
    test("lead spans the row and spec cards sit below in three columns", () => {
        const result = layoutCanvasGridGroups(planFixture(4));
        expect(result[0].width).toBe(1296);
        expect(result[1].position).toEqual({ x: 124, y: 200 });
        expect(result[1].width).toBe(1248);
        expect(result[1].height).toBe(320);
        expect(result.slice(2).map(n => [n.position.x, n.position.y])).toEqual([[124, 560], [548, 560], [972, 560], [124, 896]]);
        expect(result[0].height).toBe(100 + 320 + 40 + 280 * 2 + 56 + 24);
        expect(layoutCanvasGridGroups(result)).toBe(result);
    });

    test("a placeholder lead recognised only by assetKey does not widen the container", () => {
        const nodes = planFixture(0, { leadPlaceholder: true });
        expect(isPlanLeadNode(nodes[1])).toBe(true);
        const result = layoutCanvasGridGroups(nodes);
        expect(result[0].width).toBe(1296);
        expect(result[0].height).toBe(100 + 320 + 40 + 24);
        expect(result[1].width).toBe(1248);
        expect(layoutCanvasGridGroups(result)).toBe(result);
    });

    test("a stale wide gridWidth is clamped back to three columns", () => {
        const result = layoutCanvasGridGroups(planFixture(3, { gridWidth: 3840 }));
        expect(result[0].width).toBe(1296);
        expect(result[1].width).toBe(1248);
    });

    test("containers without a lead keep the previous layout", () => {
        const nodes = planFixture(5, { lead: false });
        const metrics = groupGridMetrics(nodes[0], nodes.slice(1));
        expect(metrics.lead).toBeUndefined();
        expect(metrics.top).toBe(100);
        expect(metrics.width).toBe(1296);
    });

    test("dropping a card re-flows only the spec cards", () => {
        const laid = layoutCanvasGridGroups(planFixture(4));
        const dragged = laid.map(n => n.id === "spec3" ? { ...n, position: { x: 124, y: 560 } } : n);
        const result = snapGridDrop(dragged, new Set(["spec3"]), dragged[0]);
        expect(result.find(n => n.id === "story")!.position).toEqual({ x: 124, y: 200 });
        expect(result.find(n => n.id === "spec3")!.position).toEqual({ x: 124, y: 560 });
    });
});
