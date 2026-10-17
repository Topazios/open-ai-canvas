import { expect, test } from "bun:test";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowAncestors, workflowGenerationSources, workflowSourceSignaturesMatch } from "../src/lib/canvas/canvas-short-drama-workflow";
import { createWorkflowImages, workflowImageSubjects } from "../src/lib/canvas/canvas-workflow-images";
import { completeUnifiedWorkflowPlan } from "./fixtures/workflow-plan";

function partialPlan() {
    const p = createShortDramaPipeline({ x: 0, y: 0 }, true); p.nodes[0].metadata!.content = "选定故事";
    const request = { step: "story.plan" as const, pipelineId: nodeWorkflow(p.nodes[0])!.pipelineId, sourceNodeIds: [p.storyNodeId], model: "fixture", instruction: "", episodeCount: 3, minutesPerEpisode: "2", start: 1, count: 1 };
    const result = createWorkflowDocuments(request, p.nodes, p.connections, { x: 0, y: 0 });
    const plan = completeUnifiedWorkflowPlan(result), hero = plan.docs[1];
    const group = structuredClone(plan.frame); group.id = "character-group";
    Object.assign(nodeWorkflow(group)!, { sourceNodeIds: [hero.id], planGroups: undefined, planGroup: { rootFrameId: plan.frame.id, kind: "character" } });
    nodeWorkflow(plan.frame)!.planGroups = { character: group.id };
    nodeWorkflow(plan.frame)!.sourceNodeIds = nodeWorkflow(plan.frame)!.sourceNodeIds.filter((id) => id !== hero.id);
    hero.parentId = group.id;
    Object.assign(nodeWorkflow(hero)!, { sourceNodeIds: [plan.frame.id], sourceSteps: ["story.plan"], sourceSignatures: {} });
    plan.manifest.metadata!.status = "loading";
    Object.assign(nodeWorkflow(plan.manifest)!, { materializedTaskId: undefined, assetOutput: true });
    const generation = plan.docs.find((node) => nodeWorkflow(node)?.planSection === "generation")!;
    generation.metadata!.content = ""; generation.metadata!.status = "loading";
    plan.docs[2].metadata!.status = "error";
    const pending = structuredClone(hero); pending.id = "pending-character"; pending.metadata!.content = "未完成片段"; pending.metadata!.status = "loading";
    nodeWorkflow(pending)!.assetIdentity = { id: "pending", code: "CHR-0002", kind: "character" }; nodeWorkflow(pending)!.assetKey = "C002";
    nodeWorkflow(group)!.sourceNodeIds.push(pending.id);
    result.nodes.push(group, pending); result.connections.push({ id: "root-to-characters", fromNodeId: plan.frame.id, toNodeId: group.id });
    return { ...result, ...plan, group, hero, pending, generation, request: { ...request, step: "assets.character_references" as const, sourceNodeIds: [group.id], imageSubjectIds: [hero.id], imageSettings: { size: "1536x1024", quality: "auto", transparentBackground: "false" } } };
}

test("completed assets can generate while the plan, sibling assets and final norms are unfinished", () => {
    for (const status of ["loading", "error"] as const) {
        const f = partialPlan(); f.manifest.metadata!.status = status;
        expect(workflowImageSubjects(f.request, f.nodes).map((node) => node.id)).toEqual([f.hero.id]);
        expect(defaultWorkflowSources(f.request.step, f.request.pipelineId, f.nodes)).toEqual([f.group.id]);
        expect(() => workflowAncestors([f.frame.id], f.nodes, f.request.pipelineId)).toThrow("请先完成制作方案");
        const before = JSON.stringify(f.nodes);
        const result = createWorkflowImages(f.request, f.nodes, f.connections, { x: 0, y: 0 });
        expect(JSON.stringify(f.nodes)).toBe(before);
        expect(result.created).toHaveLength(1);
        const image = result.created[0], data = nodeWorkflow(image)!;
        expect(image.metadata?.prompt).toContain(f.hero.metadata!.content!);
        expect(image.metadata?.prompt).toContain("自然写实");
        expect(image.metadata?.prompt).not.toContain("未完成片段");
        expect(Object.keys(data.sourceSignatures)).not.toContain(f.frame.id);
        expect(Object.keys(data.sourceSignatures)).not.toContain(f.group.id);
        expect(Object.keys(data.sourceSignatures)).not.toContain(f.manifest.id);
        expect(Object.keys(data.sourceSignatures)).not.toContain(f.generation.id);
        expect(workflowGenerationSources(data, result.nodes, result.connections).some((node) => node.id === f.hero.id)).toBe(true);
        image.metadata!.content = "fixture-image"; image.metadata!.status = "success";
        expect(() => workflowAncestors([image.id], result.nodes, f.request.pipelineId, result.connections)).not.toThrow();
    }
});

test("new assets and newly finished optional norms do not invalidate a queued image snapshot", () => {
    const f = partialPlan();
    const result = createWorkflowImages(f.request, f.nodes, f.connections, { x: 0, y: 0 }), data = nodeWorkflow(result.created[0])!;
    f.pending.metadata!.status = "success"; f.pending.metadata!.content = "新完成的第二位人物";
    f.generation.metadata!.status = "success"; f.generation.metadata!.content = "新完成的生成规范";
    const more = structuredClone(f.pending); more.id = "pending-third"; more.metadata!.status = "loading";
    result.nodes.push(more); nodeWorkflow(f.group)!.sourceNodeIds.push(more.id);
    expect(workflowSourceSignaturesMatch(data, result.nodes)).toBe(true);
    const sources = workflowGenerationSources(data, result.nodes, result.connections);
    expect(sources.map((node) => node.id)).not.toContain(f.pending.id);
    expect(sources.map((node) => node.id)).not.toContain(f.generation.id);
    expect(sources.map((node) => node.id)).not.toContain(more.id);
});

test("later completed assets append images to the same source and visual-version group", () => {
    const f = partialPlan();
    const first = createWorkflowImages(f.request, f.nodes, f.connections, { x: 0, y: 0 });
    f.pending.metadata!.content = "第二个人物的完整设定"; f.pending.metadata!.status = "success";
    const second = createWorkflowImages({ ...f.request, imageSubjectIds: [f.pending.id] }, first.nodes, first.connections, { x: 0, y: 0 });
    expect(second.created[0].parentId).toBe(first.created[0].parentId);
    expect(Object.keys(nodeWorkflow(second.created[0])!.sourceSignatures)).not.toContain(f.hero.id);
    expect(second.nodes.filter((node) => node.parentId === first.created[0].parentId)).toHaveLength(2);
});

test("only unavailable selected assets, missing visual inputs and broken provenance block images", () => {
    for (const invalid of ["pending", "empty", "missing", "moved", "cross-pipeline", "style", "links", "root-owner"] as const) {
        const f = partialPlan();
        if (invalid === "pending") f.request.imageSubjectIds = [f.pending.id];
        if (invalid === "empty") f.hero.metadata!.content = "";
        if (invalid === "missing") f.nodes = f.nodes.filter((node) => node.id !== f.hero.id);
        if (invalid === "moved") f.hero.parentId = undefined;
        if (invalid === "cross-pipeline") nodeWorkflow(f.hero)!.pipelineId = "other";
        if (invalid === "style") f.nodes.find((node) => nodeWorkflow(node)?.planSection === "visual")!.metadata!.status = "loading";
        if (invalid === "links") f.connections = [];
        if (invalid === "root-owner") nodeWorkflow(f.frame)!.planGroups = {};
        expect(() => createWorkflowImages(f.request, f.nodes, f.connections, { x: 0, y: 0 })).toThrow();
    }
});

test("selected asset edits and used visual edits still invalidate saved image inputs", () => {
    for (const input of ["asset", "style"] as const) {
        const f = partialPlan();
        const result = createWorkflowImages(f.request, f.nodes, f.connections, { x: 0, y: 0 });
        const target = input === "asset" ? f.hero : f.nodes.find((node) => nodeWorkflow(node)?.planSection === "visual")!;
        target.metadata!.content += "修改";
        const image = result.created[0]; image.metadata!.content = "fixture-image"; image.metadata!.status = "success";
        expect(workflowSourceSignaturesMatch(nodeWorkflow(image)!, result.nodes)).toBe(false);
        expect(() => workflowAncestors([image.id], result.nodes, f.request.pipelineId, result.connections)).toThrow("前文已更新");
    }
});
