import { expect, test } from "bun:test";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowContextContent, workflowSources, workflowSignature } from "../src/lib/canvas/canvas-short-drama-workflow";
import { completeWorkflowPlan } from "./fixtures/workflow-plan";
import { ProductionPlanSection, unifiedProductionPlanInstruction } from "../src/lib/production-plan";
import { productionAssetKinds } from "../src/lib/production-plan";
import { activeShortDramaSteps, nextShortDramaSteps } from "../src/lib/short-drama-steps";

function plan() {
    const p = createShortDramaPipeline({ x: 0, y: 0 }, true);
    p.nodes[0].metadata!.content = "已采用的选题";
    const request = { step: "story.plan" as const, pipelineId: nodeWorkflow(p.nodes[0])!.pipelineId, sourceNodeIds: [p.storyNodeId], model: "fixture", instruction: "", episodeCount: 3, minutesPerEpisode: "2", start: 1, count: 1 };
    return { request, result: createWorkflowDocuments(request, p.nodes, p.connections, { x: 0, y: 0 }) };
}

test("plan is a durable grouped agent job with only container edges and required voices", () => {
    const { result } = plan(); const node = result.created[0];
    expect(nodeWorkflow(node)?.productionAgent).toEqual({});
    expect(nodeWorkflow(node)?.textBatch).toBeUndefined();
    expect(node.metadata!.prompt).toContain("人物必须包含性格");
    expect(node.metadata!.prompt).toContain("配音提示词");
    expect(result.connections.filter((edge) => edge.toNodeId === node.id)).toHaveLength(0);
    expect(result.connections.filter((edge) => edge.toNodeId === node.parentId)).toHaveLength(1);
});

test("new plans use four asset categories and no separate special workflow", () => {
    const { result } = plan();
    expect(nodeWorkflow(result.created[0])?.planVersion).toBe(3);
    expect(productionAssetKinds.map((kind) => kind.kind)).toEqual(["character", "environment", "prop", "sound"]);
    expect(activeShortDramaSteps.some((step) => step.id === "assets.special_references")).toBe(false);
    expect(nextShortDramaSteps("story.plan").some((step) => step.id === "assets.special_references")).toBe(false);
    expect(result.created[0].metadata!.prompt).toContain("不增加规范节点");
});

test("submitted plan prompt follows the shared ordered workflow and system field templates", () => {
    const prompt = plan().result.created[0].metadata!.prompt!;
    expect(prompt).toContain(unifiedProductionPlanInstruction);
    expect(prompt).toContain("每项资产按系统提供的固定字段模板完整填写");
    expect(prompt).toContain("不适用字段注明理由");
    expect(prompt).toContain("结局遵循全局设置与用户要求");
    expect(prompt).not.toContain("明确结局");
    expect(prompt).not.toContain("不以悬念代替结局");
    expect(prompt).not.toContain("四份共用文稿，再逐项设计");
});

test("downstream context uses asset indexes without repeating the system catalog body", () => {
    const { result } = plan();
    const { docs } = completeWorkflowPlan(result);
    docs[0].metadata!.shortDrama!.planSection = ProductionPlanSection.Inventory;
    docs[0].metadata!.content = "LARGE_SYSTEM_CATALOG".repeat(1000);
    expect(workflowContextContent(docs[0], "story.episodes")).not.toContain("LARGE_SYSTEM_CATALOG");
    const asset = docs[1].metadata!.shortDrama!.planAsset!;
    asset.episodes = [];
    asset.purpose = "调查相机秘密的主角";
    asset.plannedRange = "第一篇章";
    expect(workflowContextContent(docs[1], "story.episodes")).not.toContain("调查相机秘密的主角");
    expect(workflowContextContent(docs[1], "story.body", 2)).toContain("第一篇章");
});

test("partial plans cannot advance; finished plan container carries the correct branch", () => {
    const { result, request } = plan();
    const frameId = result.created[0].parentId!;
    expect(() => workflowSources("story.episodes", request.pipelineId, result.nodes, [frameId], result.connections)).toThrow("完整资产清单");
    const { frame, docs } = completeWorkflowPlan(result);
    expect(defaultWorkflowSources("story.episodes", request.pipelineId, result.nodes, docs[1].id)).toEqual([frame.id]);
    const episodes = createWorkflowDocuments({ ...request, step: "story.episodes", sourceNodeIds: [frame.id] }, result.nodes, result.connections, { x: 0, y: 0 });
    expect(episodes.created[0].metadata!.prompt).toContain("故事总纲");
    const outlineContext = episodes.created[0].metadata!.shortDrama!.textBatch!.units.map((unit) => unit.text).join("\n");
    expect(outlineContext).toContain("C001");
    expect(outlineContext).not.toContain("固定灰色外套");
    const body1 = workflowContextContent(docs[1], "story.body", 1);
    const body2 = workflowContextContent(docs[1], "story.body", 2);
    expect(body1).toContain("固定灰色外套");
    expect(body2).not.toContain("固定灰色外套");
    const before = workflowSignature(docs[1]);
    docs[1].metadata!.shortDrama!.planAsset!.episodes = [1, 2];
    expect(workflowSignature(docs[1])).not.toBe(before);
    expect(workflowContextContent(docs[1], "story.body", 2)).toContain("固定灰色外套");
});

test("edited asset content bypasses stale appearance index instead of silently hiding changes", () => {
    const { result } = plan(); const { docs } = completeWorkflowPlan(result);
    docs[1].metadata!.content += "新增第3集出场";
    expect(workflowContextContent(docs[1], "story.body", 3)).toContain("新增第3集出场");
});
