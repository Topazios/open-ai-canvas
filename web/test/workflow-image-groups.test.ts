import { expect, test } from "bun:test";
import { workflowImageFixture } from "./fixtures/workflow-image-project";
import { createWorkflowImages, workflowImageSubjects } from "@/lib/canvas/canvas-workflow-images";
import { nodeWorkflow, workflowAncestors } from "@/lib/canvas/canvas-short-drama-workflow";
import { removeCanvasNodes } from "@/lib/canvas/canvas-project-domain";

const center = { x: 0, y: 0 };
test("images group by source version, append without moving existing images and connect once", () => {
    const f = workflowImageFixture();
    const subjects = workflowImageSubjects(f.request, f.nodes);
    const first = createWorkflowImages({ ...f.request, imageSubjectIds: [subjects[0].id] }, f.nodes, f.connections, center);
    const frame = first.nodes.find((node) => node.id === first.created[0].parentId)!;
    expect(nodeWorkflow(frame)?.mediaGroup?.sourceNodeId).toBe(f.request.sourceNodeIds[0]);
    frame.title = "My reference group";
    frame.metadata!.frame!.collapsed = true;
    frame.width = 300; frame.height = 100;
    const originalPosition = { ...first.created[0].position };
    const second = createWorkflowImages({ ...f.request, imageSubjectIds: [subjects[1].id] }, first.nodes, first.connections, center);
    expect(second.created[0].parentId).toBe(frame.id);
    expect(second.nodes.find((node) => node.id === first.created[0].id)!.position).toEqual(originalPosition);
    expect(second.nodes.find((node) => node.id === frame.id)).toMatchObject({ title: "My reference group", width: 300, height: 100 });
    expect(nodeWorkflow(second.nodes.find((node) => node.id === frame.id))?.sourceNodeIds).toHaveLength(2);
    expect(second.connections.filter((edge) => edge.toNodeId === frame.id)).toHaveLength(1);
    for (const node of second.nodes.filter((node) => node.parentId === frame.id)) Object.assign(node.metadata!, { status: "success", storageKey: `resource:${node.id}` });
    expect(workflowAncestors([frame.id], second.nodes, f.request.pipelineId, second.connections).at(-1)?.id).toBe(frame.id);
    subjects[0].metadata!.content += " changed reference version";
    const third = createWorkflowImages({ ...f.request, imageSubjectIds: [subjects[0].id] }, second.nodes, second.connections, center);
    expect(third.created[0].parentId).not.toBe(frame.id);
});

test("legacy loose images are grouped on append and deletion updates membership without resurrection", () => {
    const f = workflowImageFixture();
    const subjects = workflowImageSubjects(f.request, f.nodes);
    const first = createWorkflowImages({ ...f.request, imageSubjectIds: [subjects[0].id] }, f.nodes, f.connections, center);
    const frameId = first.created[0].parentId!;
    const loose = removeCanvasNodes(first.nodes, new Set([frameId])).nodes;
    const edges = first.connections.filter((edge) => edge.toNodeId !== frameId);
    const second = createWorkflowImages({ ...f.request, imageSubjectIds: [subjects[1].id] }, loose, edges, center);
    const groupId = second.created[0].parentId!;
    expect(second.nodes.find((node) => node.id === first.created[0].id)!.parentId).toBe(groupId);
    const removed = removeCanvasNodes(second.nodes, new Set([first.created[0].id]));
    expect(nodeWorkflow(removed.nodes.find((node) => node.id === groupId))!.sourceNodeIds).toEqual([second.created[0].id]);
    const appended = createWorkflowImages({ ...f.request, imageSubjectIds: [subjects[0].id] }, removed.nodes, second.connections, center);
    expect(appended.created[0].parentId).toBe(groupId);
    expect(appended.nodes.some((node) => node.id === first.created[0].id)).toBe(false);
    expect(nodeWorkflow(appended.nodes.find((node) => node.id === groupId))!.sourceNodeIds).toHaveLength(2);
});
