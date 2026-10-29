import { expect, test } from "bun:test";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowContextContent, workflowSources, workflowSignature } from "../src/lib/canvas/canvas-short-drama-workflow";
import { completeWorkflowPlan } from "./fixtures/workflow-plan";
import { ProductionPlanSection, storyPlanInstruction } from "../src/lib/production-plan";
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
    expect(node.metadata!.prompt).toContain("故事总纲");
    expect(node.metadata!.prompt).not.toContain("完整资产档案");
    expect(result.connections.filter((edge) => edge.toNodeId === node.id)).toHaveLength(0);
    expect(result.connections.filter((edge) => edge.toNodeId === node.parentId)).toHaveLength(1);
});

test("new plans use four asset categories and no separate special workflow", () => {
    const { result } = plan();
    expect(nodeWorkflow(result.created[0])?.planVersion).toBe(5);
    expect(productionAssetKinds.map((kind) => kind.kind)).toEqual(["character", "environment", "prop", "sound"]);
    expect(activeShortDramaSteps.some((step) => step.id === "assets.special_references")).toBe(false);
    expect(nextShortDramaSteps("story.plan").some((step) => step.id === "assets.special_references")).toBe(false);
    expect(result.created[0].metadata!.prompt).toContain("本步骤只生成故事总纲与世界规则");
});

test("submitted story plan contains only the story outline and world rules", () => {
    const prompt = plan().result.created[0].metadata!.prompt!;
    expect(prompt).toContain(storyPlanInstruction);
    expect(prompt).toContain("结局遵循全局设置与用户要求");
    expect(prompt).toContain("按项目参数为每集建立规划骨架");
    expect(prompt).toContain("不以固定悬念、反转或节奏模板替代题材适配");
    expect(prompt).toContain("保存到当前文稿后立即结束");
    expect(prompt).toContain("不要登记资产清单、制作规范或资产档案");
    expect(prompt).not.toContain("生产资产模板");
    expect(prompt).not.toContain("全剧资产清单与系统编码");
    expect(prompt).not.toContain("视觉与美术规范");
    expect(prompt).not.toContain("导演与视听规范");
    expect(prompt).not.toContain("生成与一致性规范");
    expect(prompt).not.toContain("明确结局");
    expect(prompt).not.toContain("不以悬念代替结局");
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
    expect(() => workflowSources("story.episodes", request.pipelineId, result.nodes, [frameId], result.connections)).toThrow("先完成故事总纲");
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
