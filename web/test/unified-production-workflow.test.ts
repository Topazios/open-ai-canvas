import { expect, test } from "bun:test";
import { createShortDramaPipeline, deriveShortDramaProgress } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowAncestors, workflowGenerationSources } from "../src/lib/canvas/canvas-short-drama-workflow";
import { createWorkflowImages, workflowImageSubjects } from "../src/lib/canvas/canvas-workflow-images";
import { productionAssetMentions, resolveProductionAssetReferences } from "../src/lib/canvas/production-asset-references";
import { nextShortDramaSteps } from "../src/lib/short-drama-steps";
import { completeUnifiedWorkflowPlan } from "./fixtures/workflow-plan";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function unifiedPlan() {
    const p = createShortDramaPipeline({ x: 0, y: 0 }, true);
    p.nodes[0].metadata!.content = "已采用的选题";
    const request = { step: "story.plan" as const, pipelineId: nodeWorkflow(p.nodes[0])!.pipelineId, sourceNodeIds: [p.storyNodeId], model: "fixture", instruction: "", episodeCount: 3, minutesPerEpisode: "2", start: 1, count: 1 };
    const result = createWorkflowDocuments(request, p.nodes, p.connections, { x: 0, y: 0 });
    return { request, result, ...completeUnifiedWorkflowPlan(result) };
}

function groupedPlan() {
    const f = unifiedPlan();
    const root = nodeWorkflow(f.frame)!;
    root.planGroups = {};
    for (const asset of f.docs.filter((node) => nodeWorkflow(node)?.planAsset)) {
        const data = nodeWorkflow(asset)!;
        const kind = data.planAsset!.kind;
        const group: CanvasNodeData = { ...f.frame, id: `group-${kind}`, type: CanvasNodeType.Frame, title: `${kind} assets`, metadata: { shortDrama: { ...root, planGroups: undefined, planGroup: { rootFrameId: f.frame.id, kind }, sourceNodeIds: [asset.id], sourceSignatures: {} } } };
        root.planGroups[kind] = group.id;
        root.sourceNodeIds = root.sourceNodeIds.filter((id) => id !== asset.id);
        asset.parentId = group.id;
        data.sourceNodeIds = [f.frame.id]; data.sourceSignatures = {}; data.sourceSteps = ["story.plan"];
        f.result.nodes.push(group);
        f.result.connections.push({ id: `edge-${kind}`, fromNodeId: f.frame.id, toNodeId: group.id });
    }
    return f;
}

test("separate plan asset groups preserve downstream outlines, prose, images and defaults", () => {
    const f = groupedPlan();
    const group = nodeWorkflow(f.frame)!.planGroups!.character!;
    expect(defaultWorkflowSources("story.episodes", f.request.pipelineId, f.result.nodes, f.docs[1].id)).toEqual([f.frame.id]);
    expect(workflowImageSubjects({ step: "assets.character_references", sourceNodeIds: [group] }, f.result.nodes).map((node) => node.id)).toEqual([f.docs[1].id]);
    expect(workflowImageSubjects({ step: "assets.character_references", sourceNodeIds: [f.frame.id] }, f.result.nodes).map((node) => node.id)).toEqual([f.docs[1].id]);
    const sources = defaultWorkflowSources("assets.character_references", f.request.pipelineId, f.result.nodes, group).filter(Boolean);
    const images = createWorkflowImages({ ...f.request, step: "assets.character_references", sourceNodeIds: sources, imageSubjectIds: [f.docs[1].id], model: "fixture-image", imageSettings: { size: "1536x1024", quality: "auto", transparentBackground: "false" } }, f.result.nodes, f.result.connections, { x: 0, y: 0 });
    expect(images.created).toHaveLength(1);
    expect(images.created[0].metadata?.prompt).toContain("固定灰色外套");
    const outline = createWorkflowDocuments({ ...f.request, step: "story.episodes", sourceNodeIds: [f.frame.id] }, f.result.nodes, f.result.connections, { x: 0, y: 0 });
    expect(JSON.stringify(outline.created[0].metadata?.shortDrama?.textBatch?.units)).toContain("CHR-0001");
    outline.created[0].metadata!.status = "success"; outline.created[0].metadata!.content = "第1集集纲";
    const body = createWorkflowDocuments({ ...f.request, step: "story.body", sourceNodeIds: [outline.created[0].id] }, outline.nodes, outline.connections, { x: 0, y: 0 });
    expect(body.created[0].metadata?.shortDrama?.bodyContextVersion).toBe(1);
    expect(body.created[0].metadata?.prompt).not.toContain("固定灰色外套");
    const progress = deriveShortDramaProgress(f.result.nodes, f.result.connections);
    expect(progress.steps.find((step) => step.id === "story")?.tasks.find((task) => task.id === "story.plan")?.nodeId).toBe(f.frame.id);
});

test("asset groups reject broken ownership and removed group links", () => {
    const f = groupedPlan(); const groupId = nodeWorkflow(f.frame)!.planGroups!.character!;
    const group = f.result.nodes.find((node) => node.id === groupId)!;
    expect(() => workflowAncestors([f.frame.id], f.result.nodes, f.request.pipelineId, f.result.connections.filter((edge) => edge.toNodeId !== groupId))).toThrow("来源连线");
    nodeWorkflow(group)!.planGroup!.rootFrameId = "missing";
    expect(() => workflowAncestors([f.frame.id], f.result.nodes, f.request.pipelineId, f.result.connections)).toThrow("关联已变化");
});

test("unified plan generates reference images before body, with matching category and stable identity", () => {
    const f = unifiedPlan();
    const sources = defaultWorkflowSources("assets.character_references", f.request.pipelineId, f.result.nodes, f.frame.id).filter(Boolean);
    expect(new Set(sources)).toEqual(new Set([f.frame.id]));
    const request = { ...f.request, step: "assets.character_references" as const, sourceNodeIds: sources, imageSubjectIds: [f.docs[1].id], model: "fixture-image", imageSettings: { size: "1536x1024", quality: "auto", transparentBackground: "false" } };
    expect(workflowImageSubjects(request, f.result.nodes).map((node) => node.id)).toEqual([f.docs[1].id]);
    const images = createWorkflowImages(request, f.result.nodes, f.result.connections, { x: 0, y: 0 });
    expect(images.created).toHaveLength(1);
    expect(nodeWorkflow(images.created[0])?.assetIdentity).toEqual(nodeWorkflow(f.docs[1])?.assetIdentity);
    expect(images.created[0].metadata?.prompt).toContain("固定灰色外套");
    expect(images.created[0].metadata?.prompt).not.toContain("靠南入口");
    expect(images.created[0].metadata?.prompt).toContain("自然写实");
});

test("episode prose flows into one reconciliation job and shared norms cannot be silently removed", () => {
    const f = unifiedPlan();
    const outline = createWorkflowDocuments({ ...f.request, step: "story.episodes", sourceNodeIds: [f.frame.id] }, f.result.nodes, f.result.connections, { x: 0, y: 0 });
    expect(JSON.stringify(outline.created[0].metadata?.shortDrama?.textBatch?.units)).toContain("CHR-0001");
    outline.created[0].metadata!.content = "第1集集纲"; outline.created[0].metadata!.status = "success";
    const body = createWorkflowDocuments({ ...f.request, step: "story.body", sourceNodeIds: [outline.created[0].id] }, outline.nodes, outline.connections, { x: 0, y: 0 });
    body.created[0].metadata!.content = "林岚走进照相馆。"; body.created[0].metadata!.status = "success";
    const sourceNodeIds = defaultWorkflowSources("assets.reconcile", f.request.pipelineId, body.nodes, body.created[0].id).filter(Boolean);
    expect(sourceNodeIds).toContain(f.frame.id);
    const reconcile = createWorkflowDocuments({ ...f.request, step: "assets.reconcile", sourceNodeIds }, body.nodes, body.connections, { x: 0, y: 0 });
    expect(reconcile.created).toHaveLength(1);
    expect(nodeWorkflow(reconcile.created[0])?.productionAgent).toEqual({});
    expect(workflowGenerationSources(nodeWorkflow(reconcile.created[0])!, reconcile.nodes, reconcile.connections).some((node) => node.id === f.docs[1].id)).toBe(true);
    expect(nextShortDramaSteps("assets.reconcile").map((step) => step.id)).not.toContain("assets.reconcile");
    f.frame.metadata!.shortDrama!.sourceNodeIds = f.frame.metadata!.shortDrama!.sourceNodeIds.filter((id) => id !== f.docs[3].id);
    expect(() => workflowAncestors([f.frame.id], f.result.nodes, f.request.pipelineId)).toThrow("四份共用规范");
});

test("asset mentions resolve only supplied versions and reject missing identities or states", () => {
    const f = unifiedPlan();
    const hero = f.docs[1];
    hero.metadata!.shortDrama!.assetProfile!.variants = [{ code: "CHR-0001-V0001", name: "雨中", description: "外套被雨淋湿" }];
    expect(productionAssetMentions(f.docs).map((ref) => ref.mentionToken)).toEqual(["@CHR-0001", "@CHR-0001-V0001", "@SCN-0001"]);
    const resolved = resolveProductionAssetReferences("@CHR-0001-V0001 回头", f.docs);
    expect(resolved.nodes).toEqual([hero]);
    expect(resolved.content).toContain("外套被雨淋湿");
    expect(resolved.content).not.toContain("靠南入口");
    expect(() => resolveProductionAssetReferences("@CHR-9999", f.docs)).toThrow("不存在");
    expect(() => resolveProductionAssetReferences("@CHR-0001-V9999", f.docs)).toThrow("状态不存在");
    expect(() => resolveProductionAssetReferences("@CHR-0001", [hero, { ...hero, id: "other-version" }])).toThrow("多个版本");
    const reconciled = structuredClone(hero); reconciled.id = "checked-hero"; reconciled.metadata!.shortDrama!.step = "assets.reconcile";
    expect(resolveProductionAssetReferences("@CHR-0001", [hero, reconciled]).nodes).toEqual([reconciled]);
    reconciled.metadata!.shortDrama!.assetIdentity!.id = "wrong-identity";
    expect(() => resolveProductionAssetReferences("@CHR-0001", [hero, reconciled])).toThrow("编码冲突");
});

test("explicitly absent props do not demand fabricated reference images", () => {
    const f = unifiedPlan();
    const progress = deriveShortDramaProgress(f.result.nodes, f.result.connections);
    const references = progress.steps.find((step) => step.id === "story")!.tasks.find((task) => task.stepIds?.includes("assets.prop_references"));
    expect(references?.progressLabel).toBe("1/3 项已产出");
});
