import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasFrameNode } from "@/components/canvas/canvas-frame-node";
import { assetStackMembers, assetStackPreviews, isCanvasAssetStack, ASSET_STACK_HEIGHT, ASSET_STACK_WIDTH } from "@/lib/canvas/canvas-asset-stack";
import { isNodeHiddenByCollapsedFrame, resolveFrameConnection, toggleCanvasFrameCollapsed } from "@/lib/canvas/canvas-frame";
import { layoutCanvasGridGroups } from "@/lib/canvas/canvas-group-grid";
import { applyAgentCanvasPatch } from "@/lib/canvas/agent-canvas-patch";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function fixture(count = 8, kind = "character"): CanvasNodeData[] {
    return [{ id: "group", title: "人物资产", type: CanvasNodeType.Frame, position: { x: 100, y: 100 }, width: 1296, height: 1100,
        metadata: { frame: { collapsed: false, expandedWidth: 1296, expandedHeight: 1100 }, shortDrama: {
            stage: "story", step: "story.plan", role: "collection", pipelineId: "p", sourceNodeIds: Array.from({ length: count }, (_, i) => `asset-${i}`), sourceSignatures: {},
            planGroup: { rootFrameId: "plan", kind }, assetGroup: { manifestId: "summary" },
        } } } as CanvasNodeData,
        ...Array.from({ length: count }, (_, i): CanvasNodeData => ({ id: `asset-${i}`, parentId: "group", type: CanvasNodeType.Text,
            title: `角色 ${i + 1}`, position: { x: 124, y: 200 + 336 * i }, width: 400, height: 280,
            metadata: { status: i === 0 ? "error" : "success", content: `这是角色 ${i + 1} 的完整档案。`, shortDrama: {
                stage: "story", step: "story.plan", role: "document", pipelineId: "p", sourceNodeIds: [], sourceSignatures: {}, assetKey: `character-${i}`,
            } } })),
    ];
}
const noop = () => {};
function renderFrame(nodes: CanvasNodeData[], renderLOD: "full" | "preview" = "full") {
    return renderToStaticMarkup(<CanvasFrameNode data={nodes[0]} childNodes={nodes.slice(1)} scale={1} isSelected={false} isDropTarget={false} renderLOD={renderLOD}
        onMouseDown={noop} onResize={noop} onToggleCollapsed={noop} onFolderStyleChange={noop} onTitleChange={noop} onContextMenu={noop}
        onOpenTaskDetails={noop} onRetryFailed={noop} />);
}

describe("asset category stacks", () => {
    test("all asset categories default to bounded stacks, preserving every complete document", () => {
        for (const kind of ["character", "environment", "prop", "special", "sound"]) {
            const original = fixture(8, kind), snapshot = JSON.stringify(original);
            const result = layoutCanvasGridGroups(original);
            expect(result[0]).toMatchObject({ width: ASSET_STACK_WIDTH, height: ASSET_STACK_HEIGHT, metadata: { frame: { collapsed: true, assetStackExpanded: false, expandedWidth: 1296 } } });
            expect(result.slice(1).map(node => node.metadata)).toEqual(original.slice(1).map(node => node.metadata));
            expect(result.slice(1).every(node => isNodeHiddenByCollapsedFrame(node, result))).toBe(true);
            expect(JSON.stringify(original)).toBe(snapshot);
            expect(layoutCanvasGridGroups(result)).toBe(result);
        }
    });

    test("the plan root, specifications, episode groups and folders do not become asset stacks", () => {
        const base = fixture()[0];
        for (const workflow of [
            { ...base.metadata!.shortDrama!, planGroup: undefined },
            { ...base.metadata!.shortDrama!, planGroup: undefined, step: "assets.bible", assetGroup: { manifestId: "summary", kind: "bible" } },
            { ...base.metadata!.shortDrama!, planGroup: undefined, step: "story.body", assetGroup: undefined },
            { ...base.metadata!.shortDrama!, planGroup: undefined, step: "assets.character_references", assetGroup: undefined, mediaGroup: { sourceNodeId: "source" } },
        ]) expect(isCanvasAssetStack({ ...base, metadata: { ...base.metadata, shortDrama: workflow as any } })).toBe(false);
        expect(isCanvasAssetStack({ ...base, metadata: { ...base.metadata, folder: { style: "glass", createdAt: "now" } } })).toBe(false);
    });

    test("opening and closing retain all members, dimensions, content and ordering", () => {
        const collapsed = layoutCanvasGridGroups(fixture());
        const expanded = toggleCanvasFrameCollapsed(collapsed, "group");
        expect(expanded[0].metadata!.frame!.collapsed).toBe(false);
        expect(expanded[0].metadata!.frame!.assetStackExpanded).toBe(true);
        expect(expanded[0].position).toEqual(collapsed[0].position);
        expect(expanded[0].width).toBe(1296);
        expect(expanded.slice(1).some(node => isNodeHiddenByCollapsedFrame(node, expanded))).toBe(false);
        const restored = layoutCanvasGridGroups(JSON.parse(JSON.stringify(expanded)));
        expect(restored).toEqual(expanded);
        const closedAgain = toggleCanvasFrameCollapsed(expanded, "group");
        expect(closedAgain).toEqual(collapsed);
        expect(toggleCanvasFrameCollapsed(closedAgain, "group")).toEqual(expanded);
    });

    test("empty groups can open and an arriving asset does not collapse an open group", () => {
        const empty = layoutCanvasGridGroups(fixture(0));
        expect(empty[0].metadata!.frame!.collapsed).toBe(true);
        const opened = toggleCanvasFrameCollapsed(empty, "group");
        const result = layoutCanvasGridGroups([...opened, fixture(1)[1]]);
        expect(result[0].metadata!.frame!.collapsed).toBe(false);
        expect(result).toHaveLength(2);
    });

    test("expanding makes room for nearby groups without separating them from their children", () => {
        const first = layoutCanvasGridGroups(fixture());
        const second = fixture(2, "prop").map(node => ({ ...node, id: `other-${node.id}`, parentId: node.parentId ? "other-group" : undefined,
            position: { x: node.position.x + 400, y: node.position.y } }));
        const nodes = layoutCanvasGridGroups([...first, ...second]);
        const expanded = toggleCanvasFrameCollapsed(nodes, "group");
        expect(expanded[0].position).toEqual(nodes[0].position);
        const before = nodes.find(node => node.id === "other-group")!, after = expanded.find(node => node.id === "other-group")!;
        expect(after.position.x).toBeGreaterThanOrEqual(expanded[0].position.x + expanded[0].width + 36);
        for (const child of nodes.filter(node => node.parentId === before.id)) {
            const next = expanded.find(node => node.id === child.id)!;
            expect(next.position.x - after.position.x).toBe(child.position.x - before.position.x);
            expect(next.position.y - after.position.y).toBe(child.position.y - before.position.y);
            expect(next.metadata).toBe(child.metadata);
        }
    });

    test("locked neighbours keep their position when an asset group expands", () => {
        const locked: CanvasNodeData = { ...fixture()[0], id: "locked", position: { x: 550, y: 100 }, width: 400, height: 300, metadata: { locked: true } };
        const nodes = layoutCanvasGridGroups([...fixture(), locked]);
        const expanded = toggleCanvasFrameCollapsed(nodes, "group");
        expect(expanded.find(node => node.id === locked.id)).toBe(locked);
        expect(expanded[0].position).not.toEqual(nodes[0].position);
    });

    test("summary anchors stay hidden, outgoing connections resolve to the closed stack", () => {
        const original = fixture(3);
        const summary = { ...original[1], id: "summary", metadata: { ...original[1].metadata, shortDrama: { ...original[1].metadata!.shortDrama!, assetKey: "$summary" } } };
        const nodes = layoutCanvasGridGroups([...original, summary]);
        expect(assetStackMembers(nodes[0], nodes.slice(1))).toHaveLength(3);
        const outside = { ...original[1], id: "outside", parentId: undefined };
        const connection = resolveFrameConnection({ id: "link", fromNodeId: "asset-0", toNodeId: outside.id } as any, [...nodes, outside]);
        expect(connection?.from.id).toBe("group");
    });

    test("ten thousand records render only three short previews and retain details and retry controls", () => {
        const nodes = layoutCanvasGridGroups(fixture(10_000));
        expect(assetStackPreviews(nodes.slice(1))).toHaveLength(3);
        const html = renderFrame(nodes);
        expect(html.match(/class="canvas-asset-stack-sheet"/g)).toHaveLength(3);
        expect(html).toContain("10000 项");
        expect(html).toContain("角色 1");
        expect(html).not.toContain("角色 9999");
        expect(html).toContain('aria-label="查看制作任务详情"');
        expect(html).toContain('aria-label="一键重试 1 个失败任务"');
        expect(html).toContain('aria-label="重命名资产分组"');
        expect(html.length).toBeLessThan(20_000);
        expect(renderFrame(nodes, "preview")).toContain("canvas-asset-stack-preview");
        expect(renderFrame(toggleCanvasFrameCollapsed(nodes, "group"))).not.toContain("canvas-asset-stack-preview");
    });

    test("image previews prefer generated images including storage-only resources", () => {
        const nodes = fixture(5).slice(1);
        nodes[4] = { ...nodes[4], type: CanvasNodeType.Image, metadata: { storageKey: "preview/image.png" } };
        expect(assetStackPreviews(nodes)[0].id).toBe(nodes[4].id);
    });

    test("server updates keep the user's expanded state and replay idempotently", () => {
        const raw = fixture(5);
        const opened = toggleCanvasFrameCollapsed(layoutCanvasGridGroups(raw), "group");
        const project = { id: "canvas", title: "stack", nodes: opened, connections: [], chatSessions: [], activeChatId: null,
            viewport: { x: 0, y: 0, k: 1 }, createdAt: "now", updatedAt: "now" } as CanvasProject;
        const updated = { ...raw[1], metadata: { ...raw[1].metadata, content: "后台完成的新内容" } };
        const patch = { canvasId: "canvas", updatedAt: "later", connections: [], nodes: [
            { before: raw[0], after: { ...raw[0], height: 2000, metadata: { ...raw[0].metadata, frame: { ...raw[0].metadata!.frame!, expandedHeight: 2000 } } } },
            { before: raw[1], after: updated },
        ] };
        const result = applyAgentCanvasPatch(project, patch);
        expect(result.nodes[0].metadata!.frame!.assetStackExpanded).toBe(true);
        expect(result.nodes[0].metadata!.frame!.collapsed).toBe(false);
        expect(result.nodes[1].metadata!.content).toBe("后台完成的新内容");
        expect(applyAgentCanvasPatch(result, patch)).toBe(result);
        const created = { ...patch, nodes: raw.map(after => ({ before: null, after })) };
        const fresh = applyAgentCanvasPatch({ ...project, nodes: [] }, created);
        expect(applyAgentCanvasPatch(fresh, created)).toBe(fresh);
    });
});
