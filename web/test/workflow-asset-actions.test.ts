import { expect, test } from "bun:test";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowAncestors, workflowGenerationSources, workflowSourceSignaturesMatch } from "../src/lib/canvas/canvas-short-drama-workflow";
import { workflowAssetActions } from "../src/lib/canvas/canvas-workflow-asset-actions";
import { createWorkflowImages } from "../src/lib/canvas/canvas-workflow-images";
import { commitCanvasGenerationResult } from "../src/lib/canvas/canvas-generation-result";
import { completeUnifiedWorkflowPlan } from "./fixtures/workflow-plan";
import type { CanvasNodeData } from "../src/types/canvas";

function fixture() {
    const p = createShortDramaPipeline({ x: 0, y: 0 }, true);
    p.nodes[0].metadata!.content = "选定故事";
    const request = { step: "story.plan" as const, pipelineId: nodeWorkflow(p.nodes[0])!.pipelineId, sourceNodeIds: [p.storyNodeId], model: "fixture", instruction: "保留身份，调整服装", episodeCount: 3, minutesPerEpisode: "2", start: 1, count: 1 };
    const result = createWorkflowDocuments(request, p.nodes, p.connections, { x: 0, y: 0 });
    const plan = completeUnifiedWorkflowPlan(result);
    const hero = plan.docs[1];
    const group: CanvasNodeData = { ...plan.frame, id: "characters", title: "人物资产", metadata: { shortDrama: { ...nodeWorkflow(plan.frame)!, sourceNodeIds: [hero.id], planGroup: { rootFrameId: plan.frame.id, kind: "character" }, planGroups: undefined } } };
    nodeWorkflow(plan.frame)!.planGroups = { character: group.id };
    nodeWorkflow(plan.frame)!.sourceNodeIds = nodeWorkflow(plan.frame)!.sourceNodeIds.filter((id) => id !== hero.id);
    hero.parentId = group.id;
    Object.assign(nodeWorkflow(hero)!, { sourceNodeIds: [plan.frame.id], sourceSteps: ["story.plan"], sourceSignatures: {} });
    result.nodes.push(group);
    result.connections.push({ id: "root-characters", fromNodeId: plan.frame.id, toNodeId: group.id });
    return { ...result, ...plan, request, group, hero };
}

test("asset actions classify category containers and members, leaving plans and norms alone", () => {
    const f = fixture();
    expect(workflowAssetActions(f.group)).toMatchObject({ step: "assets.characters", imageStep: "assets.character_references" });
    expect(workflowAssetActions(f.hero)).toMatchObject({ step: "assets.characters", imageStep: "assets.character_references" });
    expect(workflowAssetActions(f.frame)).toBeUndefined();
    expect(workflowAssetActions(f.docs[0])).toBeUndefined();
    expect(workflowAssetActions(f.manifest)).toBeUndefined();
    for (const [kind, imageStep] of [["environment", "assets.environment_references"], ["prop", "assets.prop_references"], ["sound", undefined]] as const) {
        const node = structuredClone(f.hero);
        nodeWorkflow(node)!.assetIdentity!.kind = kind;
        expect(workflowAssetActions(node)?.imageStep).toBe(imageStep);
    }
    const image = structuredClone(f.hero); nodeWorkflow(image)!.mediaKind = "image";
    expect(workflowAssetActions(image)).toBeUndefined();
});

test("remake creates only the selected asset, keeps identity, and never starts a whole-plan agent", () => {
    const f = fixture(), before = JSON.stringify(f.nodes);
    const result = createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.hero.id], assetRevisionSourceId: f.hero.id }, f.nodes, f.connections, { x: 0, y: 0 });
    expect(JSON.stringify(f.nodes)).toBe(before);
    expect(result.created).toHaveLength(1);
    const node = result.created[0], data = nodeWorkflow(node)!;
    expect(data.assetIdentity).toEqual(nodeWorkflow(f.hero)!.assetIdentity);
    expect(data.productionAgent).toBeUndefined(); expect(data.assetOutput).toBeUndefined();
    expect(data.version).toBe(2); expect(data.sourceNodeIds).toEqual([f.hero.id]);
    expect(node.metadata?.taskId).toBeUndefined(); expect(data.operationId).toBeTruthy();
    expect(node.metadata?.prompt).toContain("配音提示词");
    expect(node.metadata?.prompt).toContain(f.hero.metadata!.content!);
    expect(node.metadata?.prompt).toContain("自然写实");
    expect(node.metadata?.prompt).not.toContain(f.docs[2].metadata!.content!);
    expect(workflowGenerationSources(data, result.nodes, result.connections).map((source) => source.id)).toContain(f.hero.id);
    expect(result.connections.at(-1)).toMatchObject({ fromNodeId: f.group.id, toNodeId: node.parentId });
});

test("group remake creates one document per member and preserves originals", () => {
    const f = fixture();
    const second = structuredClone(f.hero); second.id = "second-character";
    Object.assign(nodeWorkflow(second)!, { assetKey: "C002", assetIdentity: { id: "asset-2", code: "CHR-0002", kind: "character" } });
    second.metadata!.content = "另一位人物的完整设定";
    f.nodes.push(second); nodeWorkflow(f.group)!.sourceNodeIds.push(second.id);
    const result = createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.group.id], assetRevisionSourceId: f.group.id }, f.nodes, f.connections, { x: 0, y: 0 });
    expect(result.created).toHaveLength(2);
    expect(result.created[0].metadata?.prompt).not.toContain(second.metadata!.content!);
    expect(new Set(result.created.map((node) => node.parentId)).size).toBe(1);
    expect(result.nodes.find((node) => node.id === f.group.id)).toBe(f.group);
    expect(result.connections.length).toBe(f.connections.length + 1);
});

test("completed remake feeds image generation with its own version and shared visual norms", () => {
    const f = fixture();
    const result = createWorkflowDocuments({ ...f.request, step: "assets.characters", sourceNodeIds: [f.hero.id], assetRevisionSourceId: f.hero.id }, f.nodes, f.connections, { x: 0, y: 0 });
    const draft = result.created[0];
    const nodes = commitCanvasGenerationResult(result.nodes, draft, { ...draft, metadata: { ...draft.metadata, status: "success", content: "新版人物，蓝色外套、低沉声音。" } }, "revision-task");
    const revised = nodes.find((node) => node.id === draft.id)!;
    expect(nodes).toHaveLength(result.nodes.length);
    const ancestors = workflowAncestors([revised.parentId!], nodes, f.request.pipelineId, result.connections);
    expect(ancestors.some((node) => node.id === f.hero.id)).toBe(false);
    expect(ancestors.some((node) => node.metadata?.content?.includes("自然写实"))).toBe(true);
    const sourceNodeIds = defaultWorkflowSources("assets.character_references", f.request.pipelineId, nodes, revised.id);
    expect(sourceNodeIds).toEqual([revised.parentId!]);
    const images = createWorkflowImages({ ...f.request, step: "assets.character_references", sourceNodeIds, imageSubjectIds: [revised.id], imageSettings: { size: "1536x1024", quality: "auto", transparentBackground: "false" } }, nodes, result.connections, { x: 0, y: 0 });
    expect(images.created[0].metadata?.prompt).toContain("蓝色外套");
    expect(images.created[0].metadata?.prompt).not.toContain("固定灰色外套");
    expect(() => workflowAncestors([revised.parentId!], nodes, f.request.pipelineId, [])).toThrow("连线");
    f.hero.metadata!.content += "原稿已修改";
    expect(workflowSourceSignaturesMatch(nodeWorkflow(revised)!, nodes)).toBe(false);
    expect(() => workflowAncestors([revised.parentId!], nodes, f.request.pipelineId, result.connections)).toThrow("前文已更新");
});

test("remake rejects deleted, cross-pipeline, incomplete, and wrong-category sources", () => {
    const f = fixture();
    const request = { ...f.request, step: "assets.characters" as const, sourceNodeIds: [f.hero.id], assetRevisionSourceId: f.hero.id };
    expect(() => createWorkflowDocuments(request, f.nodes.filter((node) => node.id !== f.hero.id), f.connections, { x: 0, y: 0 })).toThrow("已删除");
    expect(() => createWorkflowDocuments({ ...request, pipelineId: "other" }, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("制作流程");
    expect(() => createWorkflowDocuments({ ...request, step: "assets.props" }, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("类别");
    f.hero.metadata!.status = "loading";
    expect(() => createWorkflowDocuments(request, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("先完成");
});

test("group remake does not silently skip missing members or accept an empty group", () => {
    const f = fixture();
    const request = { ...f.request, step: "assets.characters" as const, sourceNodeIds: [f.group.id], assetRevisionSourceId: f.group.id };
    nodeWorkflow(f.group)!.sourceNodeIds.push("deleted-asset");
    expect(() => createWorkflowDocuments(request, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("成员已删除");
    nodeWorkflow(f.group)!.sourceNodeIds = [];
    expect(() => createWorkflowDocuments(request, f.nodes, f.connections, { x: 0, y: 0 })).toThrow("没有可重做");
});
