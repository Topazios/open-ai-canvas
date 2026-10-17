import { expect, test } from "bun:test";
import { outlineAssetNarrative } from "../src/lib/canvas/workflow-outline-context";
import { createShortDramaPipeline, deriveShortDramaProgress } from "../src/lib/canvas/canvas-short-drama";
import { createCanvasNode } from "../src/lib/canvas/canvas-project-domain";
import { CanvasNodeType } from "../src/types/canvas";
import { createWorkflowDocuments, nodeWorkflow, workflowContextContent } from "../src/lib/canvas/canvas-short-drama-workflow";
import { completeUnifiedWorkflowPlan } from "./fixtures/workflow-plan";
import { ShortDramaStep } from "../src/lib/short-drama-steps";
import { workflowTextBatch, WORKFLOW_UNIT_LIMIT } from "../src/lib/canvas/workflow-text-batch";
import { applyGenerationTaskResultToNodes } from "../src/lib/canvas/canvas-generation-task-sync";

test("outline batching packs short assets without losing content or changing other steps", () => {
    const sources = Array.from({ length: 52 }, (_, index) => ({ id: `asset-${index}`, title: `资产${index}`, content: `唯一事实${index}:` + "剧情".repeat(700) }));
    const original = workflowTextBatch(sources)!;
    const packed = workflowTextBatch(sources, 0, true)!;
    expect(original.units).toHaveLength(52);
    expect(packed.units.length).toBeLessThanOrEqual(5);
    expect(packed.units.every((unit) => unit.text.length <= WORKFLOW_UNIT_LIMIT)).toBe(true);
    for (const source of sources) expect(packed.units.filter((unit) => unit.text.includes(source.content))).toHaveLength(1);
    expect(packed.units.map((unit) => unit.text).join("\n\n")).toBe(original.units.map((unit) => unit.text).join("\n\n"));
});

test("ordinary generation nodes without a drama pipeline do not crash stage derivation", () => {
    const nodes = [CanvasNodeType.Text, CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio].map((type) => createCanvasNode(type, { x: 0, y: 0 }, { status: "loading", taskId: "test" }));
    expect(() => deriveShortDramaProgress(nodes, [])).not.toThrow();
});

test("keeps narrative, custom edits and nested headings, drops only known technical sections", () => {
    const content = "# 人物\n## 人物关系与关系弧光\n兄妹\n### 转折\n反目\n## 人物参考图生成提示词\n三视图\n### 细节\n补光\n## 用户补充\n结尾和解";
    const result = outlineAssetNarrative(content);
    expect(result).toContain("反目"); expect(result).toContain("结尾和解"); expect(result).not.toContain("三视图"); expect(result).not.toContain("补光");
    expect(outlineAssetNarrative("任意手工文稿")).toBe("任意手工文稿");
});
test("outlines use story and asset identities, never load the full asset library", () => {
    const p = createShortDramaPipeline({ x: 0, y: 0 }, true); p.nodes[0].metadata!.content = "原始选题内容";
    const request = { step: ShortDramaStep.Plan, pipelineId: nodeWorkflow(p.nodes[0])!.pipelineId, sourceNodeIds: [p.storyNodeId], model: "fixture", instruction: "", episodeCount: 3, minutesPerEpisode: "2", start: 1, count: 1 };
    const result = createWorkflowDocuments(request, p.nodes, p.connections, { x: 0, y: 0 });
    const plan = completeUnifiedWorkflowPlan(result);
    for (const node of plan.docs) {
        if (nodeWorkflow(node)?.planAsset) node.metadata!.content = "## 人物关系与关系弧光\n最新关系：反目\n## 人物参考图生成提示词\n" + "无关生图描述".repeat(10000);
        if (["visual","generation"].includes(nodeWorkflow(node)?.planSection || "")) node.metadata!.content = "排除技术规范".repeat(10000);
    }
    const outline = createWorkflowDocuments({ ...request, step: ShortDramaStep.Episodes, sourceNodeIds: [plan.frame.id] }, result.nodes, result.connections, { x: 0, y: 0 }).created[0];
    const batch = outline.metadata?.shortDrama?.textBatch!;
    expect(batch.version).toBe(3);
    const context = batch.units.map((unit) => unit.text).join("\n");
    expect(context).toContain("CHR-0001"); expect(context).not.toContain("最新关系：反目");
    expect(context).not.toContain("无关生图描述"); expect(context).not.toContain("排除技术规范"); expect(context).not.toContain("原始选题内容");
    expect(context).toContain(plan.docs[0].metadata!.content!);
    expect(context.length).toBeLessThan(5000);
    expect(outline.metadata?.shortDrama?.sourceSignatures?.[plan.docs[1].id]).toBeTruthy();
    expect(workflowContextContent(plan.docs[1], ShortDramaStep.Body, 1)).toContain("无关生图描述");
});

test("outline director rules retain narrative and pacing without camera details", async () => {
    const { outlineDirectionContext } = await import("../src/lib/canvas/workflow-outline-context");
    const result = outlineDirectionContext("# 导演规范\n## 叙事视角与信息差\n主角不知道秘密\n## 节奏安排\n结尾揭示\n## 摄影与剪辑\n" + "镜头参数".repeat(20000));
    expect(result).toContain("主角不知道秘密"); expect(result).toContain("结尾揭示"); expect(result).not.toContain("镜头参数");
});

test("full-series outlines create one project document per version even with a batch count", async () => {
    const pipeline = createShortDramaPipeline({ x: 0, y: 0 }, true);
    pipeline.nodes[0].metadata!.content = "已采用的选题";
    const request = { step: ShortDramaStep.Plan, pipelineId: nodeWorkflow(pipeline.nodes[0])!.pipelineId, sourceNodeIds: [pipeline.storyNodeId], model: "fixture", instruction: "", episodeCount: 3, minutesPerEpisode: "2", start: 1, count: 1 };
    const result = createWorkflowDocuments(request, pipeline.nodes, pipeline.connections, { x: 0, y: 0 });
    const plan = completeUnifiedWorkflowPlan(result);
    const outlineRequest = { ...request, step: ShortDramaStep.Episodes, sourceNodeIds: [plan.frame.id], start: 2, count: 3 };
    const outlines = createWorkflowDocuments(outlineRequest, result.nodes, result.connections, { x: 0, y: 0 });
    expect(outlines.created).toHaveLength(1);
    expect(outlines.nodes).toHaveLength(result.nodes.length + 1);
    const outline = outlines.created[0];
    expect(outline.type).toBe(CanvasNodeType.Text);
    expect(outline.parentId).toBeUndefined();
    expect(nodeWorkflow(outline)?.episodeNumber).toBeUndefined();
    expect(nodeWorkflow(outline)?.parameters?.episodeCount).toBe(3);
    expect(outline.metadata?.prompt).toContain("第 1–3 集的全部集纲");
    expect(outlines.connections.filter((edge) => edge.toNodeId === outline.id).map((edge) => edge.fromNodeId)).toEqual([plan.frame.id]);

    const text = "# 全剧集纲\n\n## 第 1 集｜相机\n本集目标：找到相机。\n\n## 第 2 集｜真相\n核心冲突：真假难辨。\n\n## 第 3 集｜选择\n结尾钩子：回收伏笔。";
    const completed = await applyGenerationTaskResultToNodes(outlines.nodes, {
        id: "fixture-outline", type: "canvas_text", status: "succeeded", prompt: outline.metadata!.prompt!,
        attempts: 1, createdAt: "", updatedAt: "", resultJson: JSON.stringify({ mode: "text", text }),
    }, outline.id);
    expect(completed.updated).toBe(true);
    expect(completed.nodes).toHaveLength(outlines.nodes.length);
    expect(completed.node?.metadata?.content).toBe(text);
    expect(completed.node?.metadata?.status).toBe("success");
    expect(completed.nodes.filter((node) => nodeWorkflow(node)?.step === ShortDramaStep.Episodes)).toHaveLength(1);

    const another = createWorkflowDocuments(outlineRequest, completed.nodes, outlines.connections, { x: 0, y: 0 });
    expect(another.created).toHaveLength(1);
    expect(nodeWorkflow(another.created[0])?.version).toBe(2);
    expect(another.nodes.find((node) => node.id === outline.id)?.metadata?.content).toBe(text);

    const bodies = createWorkflowDocuments({ ...request, step: ShortDramaStep.Body, sourceNodeIds: [outline.id], count: 3 }, completed.nodes, outlines.connections, { x: 0, y: 0 });
    expect(bodies.created).toHaveLength(3);
    expect(bodies.created.map((node) => nodeWorkflow(node)?.episodeNumber)).toEqual([1, 2, 3]);
    for (const body of bodies.created) {
        expect(nodeWorkflow(body)?.sourceNodeIds).toEqual([outline.id]);
        expect(body.metadata?.prompt).toContain(`本次只生成第 ${nodeWorkflow(body)!.episodeNumber} 集。`);
        expect(body.parentId).toBeTruthy();
    }
    expect(new Set(bodies.created.map((node) => node.parentId)).size).toBe(1);
});
