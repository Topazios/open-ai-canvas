import { expect, test } from "bun:test";
import { workflowImageFixture } from "./fixtures/workflow-image-project";
import { createWorkflowImages, workflowImageSubjects } from "@/lib/canvas/canvas-workflow-images";
import { layoutWorkflowImageGroups, WORKFLOW_IMAGE_GRID as grid } from "@/lib/canvas/canvas-workflow-image-layout";
import { commitCanvasGenerationResult } from "@/lib/canvas/canvas-generation-result";
import { removeCanvasNodes } from "@/lib/canvas/canvas-project-domain";
import { resetInterruptedGeneration } from "@/lib/canvas/canvas-project-generation";
import { ensureMediaNodeMinimumSize, MEDIA_NODE_MIN_SIZE } from "@/lib/canvas/canvas-node-size";

function fixture() {
    const f = workflowImageFixture();
    const request = { ...f.request, imageSubjectIds: workflowImageSubjects(f.request, f.nodes).map((node) => node.id) };
    const first = createWorkflowImages(request, f.nodes, f.connections, { x: 0, y: 0 });
    const second = createWorkflowImages(request, first.nodes, first.connections, { x: 0, y: 0 });
    return { ...second, ids: [...first.created, ...second.created].map((node) => node.id), groupId: first.created[0].parentId! };
}

test("fixed image cells append in row order and remain inside the container", () => {
    const f = fixture();
    const frame = f.nodes.find((node) => node.id === f.groupId)!;
    f.ids.forEach((id, index) => {
        const node = f.nodes.find((node) => node.id === id)!;
        expect([node.width, node.height]).toEqual([grid.size, grid.size]);
        expect(node.metadata?.manualSize).toBe(true);
        expect(node.position).toEqual({ x: frame.position.x + grid.padding + (index % grid.columns) * (grid.size + grid.gapX), y: frame.position.y + grid.top + Math.floor(index / grid.columns) * (grid.size + grid.gapY) });
        expect(node.position.x + node.width).toBeLessThan(frame.position.x + frame.width);
        expect(node.position.y + node.height).toBeLessThan(frame.position.y + frame.height);
    });
    expect(layoutWorkflowImageGroups(f.nodes)).toBe(f.nodes);
});

test("old groups normalize once, retaining source, natural resolution and unrelated nodes", () => {
    const f = fixture();
    const frame = f.nodes.find((node) => node.id === f.groupId)!;
    delete frame.metadata!.shortDrama!.mediaGroup!.layout;
    const child = f.nodes.find((node) => node.id === f.ids[0])!;
    Object.assign(child, { width: 999, height: 2400, position: { x: 0, y: 0 } });
    Object.assign(child.metadata!, { naturalWidth: 1024, naturalHeight: 4096, content: "original-image", manualSize: false });
    const nodes = layoutWorkflowImageGroups(f.nodes);
    expect(nodes.find((node) => node.id === child.id)).toMatchObject({ width: grid.size, height: grid.size, metadata: { naturalWidth: 1024, naturalHeight: 4096, content: "original-image" } });
    expect(nodes.find((node) => node.id === f.nodes[0].id)).toBe(f.nodes[0]);
    expect(layoutWorkflowImageGroups(nodes)).toBe(nodes);
});

test("asynchronous image completion preserves cell size and location", () => {
    const f = fixture();
    const before = f.nodes.find((node) => node.id === f.ids[0])!;
    const result = { ...before, width: 1200, height: 4000, position: { x: 1, y: 1 }, metadata: { ...before.metadata, content: "high-resolution-result", naturalWidth: 1200, naturalHeight: 4000, status: "success" as const } };
    const nodes = commitCanvasGenerationResult(f.nodes, before, result, "test-task");
    expect(nodes.find((node) => node.id === before.id)).toMatchObject({ width: grid.size, height: grid.size, position: before.position, metadata: { content: "high-resolution-result", naturalWidth: 1200, naturalHeight: 4000 } });
});

test("reopening queued, failed and completed grid images preserves fixed geometry", () => {
    const f = fixture();
    const statuses = ["loading", "error", "success", "idle"] as const;
    f.ids.forEach((id, index) => {
        const node = f.nodes.find((entry) => entry.id === id)!;
        Object.assign(node.metadata!, { status: statuses[index], size: "16:9", taskId: `task-${index}` });
    });
    const restored = layoutWorkflowImageGroups(resetInterruptedGeneration(f.nodes));
    f.ids.forEach((id) => {
        const before = f.nodes.find((node) => node.id === id)!;
        const after = restored.find((node) => node.id === id)!;
        expect(after.position).toEqual(before.position);
        expect([after.width, after.height]).toEqual([grid.size, grid.size]);
        expect(after.metadata?.taskId).toBe(before.metadata?.taskId);
        expect(after.metadata?.status).toBe(before.metadata?.status);
        expect(ensureMediaNodeMinimumSize(after)).toBe(after);
    });
    const standalone = { ...restored.find((node) => node.id === f.ids[0])!, parentId: undefined };
    expect(ensureMediaNodeMinimumSize(standalone).width).toBe(MEDIA_NODE_MIN_SIZE.width);
});

test("already marked grids repair stale dimensions and offsets once without changing tasks or unrelated nodes", () => {
    const f = fixture();
    const child = f.nodes.find((node) => node.id === f.ids[3])!;
    const position = { ...child.position };
    const metadata = child.metadata;
    const damaged = f.nodes.map((node) => node.id === child.id ? { ...node, width: 420, height: 420, position: { x: node.position.x - 70, y: node.position.y - 70 } } : node);
    const repaired = layoutWorkflowImageGroups(damaged);
    expect(repaired.find((node) => node.id === child.id)).toMatchObject({ width: grid.size, height: grid.size, position, metadata });
    expect(repaired.find((node) => node.id === f.groupId)).toBe(damaged.find((node) => node.id === f.groupId));
    expect(repaired.find((node) => node.id === f.nodes[0].id)).toBe(f.nodes[0]);
    expect(layoutWorkflowImageGroups(repaired)).toBe(repaired);
});

test("delete compacts the remaining cells, collapsed dimensions survive, deleting a group only detaches", () => {
    const f = fixture();
    const frame = f.nodes.find((node) => node.id === f.groupId)!;
    frame.metadata!.frame!.collapsed = true; frame.width = 240; frame.height = 144;
    const removed = removeCanvasNodes(f.nodes, new Set([f.ids[1]]));
    const shifted = removed.nodes.find((node) => node.id === f.ids[3])!;
    expect(shifted.position.y).toBe(frame.position.y + grid.top);
    expect(removed.nodes.find((node) => node.id === frame.id)).toMatchObject({ width: 240, height: 144 });
    const detached = removeCanvasNodes(removed.nodes, new Set([frame.id]));
    expect(detached.nodes.find((node) => node.id === shifted.id)?.parentId).toBeUndefined();
    expect(detached.nodes.find((node) => node.id === shifted.id)?.position).toEqual(shifted.position);
});
