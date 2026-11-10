import { expect, test } from "bun:test";
import { applyAgentCanvasPatch, mergeAgentCanvasEditor } from "@/lib/canvas/agent-canvas-patch";
import { assetStackMembers } from "@/lib/canvas/canvas-asset-stack";
import { currentAssetMemberIds, currentAssetMembers } from "@/lib/canvas/canvas-asset-versions";
import { layoutCanvasGridGroups } from "@/lib/canvas/canvas-group-grid";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function fixture(count = 39) {
    const frame: CanvasNodeData = { id: "group", title: "人物资产", type: CanvasNodeType.Frame, width: 1296, height: 8860, position: { x: 100, y: 100 },
        metadata: { frame: { collapsed: false, assetStackExpanded: true, expandedWidth: 1296, expandedHeight: 8860 }, shortDrama: {
            stage: "story", step: "story.plan", role: "collection", pipelineId: "p", sourceNodeIds: [], sourceSignatures: {},
            planGroup: { kind: "character", rootFrameId: "root" }, assetGroup: { manifestId: "summary" },
        } } };
    const children = Array.from({ length: count }, (_, i) => {
        const key = `character-${i}`, identity = { id: `person-${i}`, code: `CHR-D001-${i + 1}`, kind: "character" as const };
        const node: CanvasNodeData = { id: `old-${i}`, title: `角色 ${i + 1}`, type: CanvasNodeType.Text, parentId: frame.id, width: 400, height: 280,
            position: { x: 124 + ((i * 2) % 3) * 424, y: 200 + Math.floor(i * 2 / 3) * 336 }, metadata: { status: "success", content: "完整档案", shortDrama: {
                stage: "story", step: "story.plan", role: "document", pipelineId: "p", sourceNodeIds: [], sourceSignatures: {}, assetKey: key,
                planAsset: { key, kind: "character", name: `角色 ${i + 1}`, priority: i + 1 }, assetIdentity: identity, assetVersion: 1, assetAdopted: false,
            } } };
        const current: CanvasNodeData = { ...node, id: `current-${i}`, position: { x: 124 + ((i * 2 + 1) % 3) * 424, y: 200 + Math.floor((i * 2 + 1) / 3) * 336 },
            metadata: { ...node.metadata, shortDrama: { ...node.metadata!.shortDrama!, assetAdopted: true, assetVersion: 2 } } };
        const pending: CanvasNodeData = { ...node, id: `pending-${i}`, metadata: { content: "等待生成", status: "processing", shortDrama: {
            ...node.metadata!.shortDrama!, assetIdentity: undefined, assetAdopted: undefined, assetVersion: undefined, planGeneration: { runId: "run", status: "queued" },
        } } };
        return [node, current, pending];
    }).flat();
    return [frame, ...children];
}

function project(nodes: CanvasNodeData[]): CanvasProject {
    return { id: "canvas", title: "Assets", nodes, connections: [], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 }, createdAt: "2026-11-10", updatedAt: "2026-11-10" };
}

test("rendering, layout and previews share one slot for history and recovery placeholders", () => {
    const original = fixture(), before = JSON.stringify(original);
    const nodes = layoutCanvasGridGroups(original), members = assetStackMembers(nodes[0], nodes.slice(1));
    expect(members).toHaveLength(39);
    expect(members.every(node => node.id.startsWith("current-"))).toBe(true);
    expect(nodes[0].height).toBe(4436);
    expect(members.slice(0, 4).map(node => node.position)).toEqual([{ x: 124, y: 200 }, { x: 548, y: 200 }, { x: 972, y: 200 }, { x: 124, y: 536 }]);
    expect([...currentAssetMemberIds(nodes)]).toEqual(currentAssetMembers(nodes).map(node => node.id));
    expect(JSON.stringify(original)).toBe(before);
    expect(layoutCanvasGridGroups(nodes)).toBe(nodes);
    expect(assetStackMembers(nodes[0], [...nodes.slice(1)].reverse()).map(node => node.id)).toEqual(members.map(node => node.id));
});

test("repeated progress patches and full snapshots cannot alternate compact and history grids", () => {
    const raw = fixture(), normalized = layoutCanvasGridGroups(raw);
    let local = project(normalized), baseline = project(raw);
    const geometry = () => assetStackMembers(local.nodes[0], local.nodes.slice(1)).map(node => [node.id, node.position, node.width, node.height]);
    const stable = geometry();
    for (let i = 0; i < 12; i++) {
        const before = baseline.nodes[0];
        const after = { ...before, height: i % 2 ? 8860 : 13172, metadata: { ...before.metadata, taskProgress: i + 1 } };
        const incoming = { ...baseline, nodes: baseline.nodes.map((node, index) => node === before ? after : {
            ...node, position: { x: 124 + ((index + i) % 3) * 424, y: 200 + Math.floor((index + i) / 3) * 336 },
        }) };
        const merged = mergeAgentCanvasEditor(baseline, incoming, local.nodes, local.connections);
        local = { ...local, nodes: merged.nodes, connections: merged.connections };
        baseline = incoming;
        expect(geometry()).toEqual(stable);
        expect(local.nodes[0].height).toBe(4436);
        expect(local.nodes[0].metadata?.taskProgress).toBe(i + 1);
        expect(layoutCanvasGridGroups(local.nodes)).toBe(local.nodes);
        expect(applyAgentCanvasPatch(local, { canvasId: local.id, updatedAt: local.updatedAt, nodes: [], connections: [] })).toBe(local);
    }
});

test("unfinished new assets retain a slot; the same identity in another container remains visible", () => {
    const nodes = fixture(1), pending = nodes[3];
    expect(currentAssetMembers([pending]).map(node => node.id)).toEqual([pending.id]);
    const other = { ...nodes[2], id: "other-current", parentId: "other-group" };
    expect(currentAssetMembers([...nodes, other]).map(node => node.id)).toEqual(["group", "current-0", "other-current"]);
    const distinct = { ...nodes[2], id: "distinct", metadata: { ...nodes[2].metadata, shortDrama: { ...nodes[2].metadata!.shortDrama!, assetIdentity: { ...nodes[2].metadata!.shortDrama!.assetIdentity!, id: "another-person" } } } };
    expect(currentAssetMembers([nodes[2], distinct]).map(node => node.id)).toEqual(["current-0", "distinct"]);
});
