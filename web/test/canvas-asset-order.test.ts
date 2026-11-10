import { expect, test } from "bun:test";
import { assetStackMembers } from "@/lib/canvas/canvas-asset-stack";
import { currentAssetMembers } from "@/lib/canvas/canvas-asset-versions";
import { layoutCanvasGridGroups } from "@/lib/canvas/canvas-group-grid";
import { projectProductionAssetOrder } from "@/lib/canvas/production-agent-state";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { AgentRun } from "@/services/api/agent";

const frame: CanvasNodeData = { id: "group", type: CanvasNodeType.Frame, position: { x: 0, y: 0 }, width: 1296, height: 800,
    metadata: { frame: { assetStackExpanded: true }, shortDrama: { stage: "story", step: "story.plan", role: "collection", pipelineId: "p", sourceNodeIds: ["support", "hero2", "hero1"], sourceSignatures: {},
        planGroup: { rootFrameId: "root", kind: "character" }, assetGroup: { manifestId: "summary" } } } };
function asset(id: string, key: string, code: string, priority?: number, version = 1): CanvasNodeData {
    return { id, type: CanvasNodeType.Text, parentId: frame.id, position: { x: 0, y: 0 }, width: 400, height: 280,
        metadata: { content: "完整档案", shortDrama: { stage: "story", step: "story.plan", role: "document", pipelineId: "p", sourceNodeIds: [], sourceSignatures: {}, assetKey: key,
            assetIdentity: { id: key, code, kind: "character" }, assetVersion: version,
            planAsset: { key, kind: "character", name: key, episodes: [], priority } } } };
}
const positions = (nodes: CanvasNodeData[]) => currentAssetMembers(nodes.slice(1)).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x).map(n => n.id);

test("importance wins over completion order and only current asset versions occupy the grid", () => {
    const children = [asset("support", "s", "CHR-001", 2), asset("hero2", "h", "CHR-099", 1, 2), asset("hero1", "h", "CHR-099", 1)];
    const nodes = [frame, ...children], snapshot = JSON.stringify(nodes);
    expect(positions(layoutCanvasGridGroups(nodes))).toEqual(["hero2", "support"]);
    expect(assetStackMembers(frame, children).map(n => n.id)).toEqual(["hero2", "support"]);
    expect(JSON.stringify(nodes)).toBe(snapshot);
    const result = layoutCanvasGridGroups(nodes);
    expect(layoutCanvasGridGroups(result)).toBe(result);
    expect(positions(layoutCanvasGridGroups([...result, asset("side", "side", "CHR-002", 3)]))).toEqual(["hero2", "support", "side"]);
});

test("saved run projects exact importance onto existing nodes without modifying their signed documents", () => {
    const children = [asset("support", "s", "CHR-001"), asset("hero2", "h", "CHR-099", undefined, 2), asset("hero1", "h", "CHR-099")];
    const unrelated = { ...frame, id: "other", metadata: { ...frame.metadata, shortDrama: { ...frame.metadata!.shortDrama!, assetGroup: { manifestId: "other-summary" } } } };
    const run = { production: { workKind: "plan", targetNodeId: "summary", assets: [
        { key: "s", kind: "character", priority: 2 }, { key: "h", kind: "character", priority: 1 },
    ] } } as AgentRun;
    const projected = projectProductionAssetOrder([frame, ...children, unrelated], run);
    expect(projected[0].metadata!.frame!.assetOrder).toEqual(["h", "s"]);
    expect(projected.slice(1, 4)).toEqual(children);
    expect(projected[1]).toBe(children[0]);
    expect(projected[4]).toBe(unrelated);
    expect(projectProductionAssetOrder(projected, run)).toBe(projected);
    expect(assetStackMembers(projected[0], children).map(n => n.id)).toEqual(["hero2", "support"]);
    expect(positions(layoutCanvasGridGroups(projected.slice(0, 4)))).toEqual(["hero2", "support"]);
});

test("unranked nodes use numeric stable codes; explicit manual ordering is preserved", () => {
    const children = [asset("ten", "ten", "CHR-10"), asset("two", "two", "CHR-2")];
    expect(assetStackMembers(frame, children).map(n => n.id)).toEqual(["two", "ten"]);
    const manual = { ...frame, metadata: { ...frame.metadata, frame: { ...frame.metadata!.frame, gridOrder: ["ten", "two"] } } };
    expect(assetStackMembers(manual, children).map(n => n.id)).toEqual(["ten", "two"]);
});
