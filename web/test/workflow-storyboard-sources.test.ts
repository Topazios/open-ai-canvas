import { expect, test } from "bun:test";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { createWorkflowDocuments, defaultWorkflowSources, workflowGenerationSources, type WorkflowGenerationRequest } from "@/lib/canvas/canvas-short-drama-workflow";
import { storyboardBodyMembers } from "@/lib/canvas/workflow-storyboard-sources";
import { CanvasNodeType } from "@/types/canvas";
import { ShortDramaStep as S } from "@/lib/short-drama-steps";

function fixture() {
    const bodies = [1, 2, 3, 4].map(episodeNumber => createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, {
        content: episodeNumber <= 3 ? `第${episodeNumber}集正文：她进门放下相机。` : "", status: episodeNumber === 1 ? "error" : "loading",
        shortDrama: { pipelineId: "p", stage: "story", step: S.Body, role: "document", episodeNumber, sourceNodeIds: ["deleted-outline"], sourceSignatures: { "deleted-outline": "old" } },
    }));
    const group = createCanvasNode(CanvasNodeType.Frame, { x: 0, y: 0 }, { shortDrama: { pipelineId: "p", stage: "story", step: S.Body, role: "collection", sourceNodeIds: bodies.map(node => node.id), sourceSignatures: {} } });
    const request: WorkflowGenerationRequest = { step: S.Shots, pipelineId: "p", sourceNodeIds: [group.id], model: "test::text", instruction: "", episodeCount: 12, minutesPerEpisode: "3-5", start: 1, count: 3, shotDurationSeconds: 25, shotDurationToleranceSeconds: 5 };
    return { bodies, group, nodes: [group, ...bodies], request };
}

test("body collection with failed/running text and an empty later episode permits selected episodes", () => {
    const f = fixture();
    expect(storyboardBodyMembers(f.group, f.nodes, "p").map(node => node.metadata!.shortDrama!.episodeNumber)).toEqual([1, 2, 3]);
    expect(defaultWorkflowSources(S.Shots, "p", f.nodes, f.group.id)).toContain(f.group.id);
    expect(defaultWorkflowSources(S.Shots, "p", f.nodes)).toContain(f.group.id);
    expect(workflowGenerationSources(f.request, f.nodes).map(node => node.id)).not.toContain(f.bodies[3].id);
    const result = createWorkflowDocuments(f.request, f.nodes, [], { x: 0, y: 0 });
    expect(result.created.map(node => node.metadata!.shortDrama!.episodeNumber)).toEqual([1, 2, 3]);
    result.created.forEach((node, i) => {
        expect(node.metadata!.shortDrama!.sourceNodeIds).toEqual([f.bodies[i].id]);
        expect(node.metadata!.shortDrama!.parameters).toMatchObject({ shotDurationSeconds: 25, shotDurationToleranceSeconds: 5 });
        expect(workflowGenerationSources(node.metadata!.shortDrama!, result.nodes).some(source => source.id === f.bodies[i].id)).toBe(true);
    });
});

test("missing selected episode blocks specifically, while other ready ranges remain usable", () => {
    const f = fixture();
    expect(() => createWorkflowDocuments({ ...f.request, count: 4 }, f.nodes, [], { x: 0, y: 0 })).toThrow("缺少对应正文");
    f.bodies[1].metadata!.content = "";
    expect(() => createWorkflowDocuments(f.request, f.nodes, [], { x: 0, y: 0 })).toThrow("缺少对应正文");
    expect(createWorkflowDocuments({ ...f.request, start: 3, count: 1 }, f.nodes, [], { x: 0, y: 0 }).created).toHaveLength(1);
});

test("optional scene collection does not require every selected episode", () => {
    const f = fixture();
    const scene = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: "场次资料", shortDrama: { pipelineId: "p", stage: "storyboard", step: S.Scenes, role: "document", episodeNumber: 1, sourceNodeIds: [], sourceSignatures: {} } });
    const scenes = createCanvasNode(CanvasNodeType.Frame, { x: 0, y: 0 }, { shortDrama: { pipelineId: "p", stage: "storyboard", step: S.Scenes, role: "collection", sourceNodeIds: [scene.id], sourceSignatures: {} } });
    scene.parentId = scenes.id;
    const result = createWorkflowDocuments({ ...f.request, sourceNodeIds: [f.group.id, scenes.id] }, [...f.nodes, scenes, scene], [], { x: 0, y: 0 });
    expect(result.created).toHaveLength(3);
    expect(result.created[0].metadata!.shortDrama!.sourceNodeIds).toContain(scene.id);
    expect(result.created[1].metadata!.shortDrama!.sourceNodeIds).toEqual([f.bodies[1].id]);
});

test("empty, removed, foreign bodies and ambiguous versions never fall back to another source", () => {
    const f = fixture();
    expect(() => workflowGenerationSources({ ...f.request, sourceNodeIds: ["deleted"] }, f.nodes)).toThrow();
    expect(() => workflowGenerationSources({ ...f.request, pipelineId: "other" }, f.nodes)).toThrow();
    expect(() => workflowGenerationSources({ ...f.request, sourceNodeIds: [f.bodies[3].id] }, f.nodes)).toThrow("暂无正文");
    f.bodies[1].metadata!.shortDrama!.episodeNumber = 1;
    expect(() => workflowGenerationSources(f.request, f.nodes)).toThrow("多个版本");
});
