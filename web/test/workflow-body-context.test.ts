import { expect, test } from "bun:test";
import { bodySourceRecords, episodeOutlineContext } from "../src/lib/canvas/workflow-body-context";
import { workflowBodyBatch } from "../src/lib/canvas/workflow-text-batch";
import { MAX_CANVAS_PAYLOAD_BYTES } from "../src/lib/canvas/generation-contract.generated";
import { createWorkflowDocuments, nodeWorkflow, workflowBodyTaskInput, workflowSignature } from "../src/lib/canvas/canvas-short-drama-workflow";
import { compactWorkflowNodes } from "../src/lib/canvas/canvas-workflow-persistence";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { completeUnifiedWorkflowPlan } from "./fixtures/workflow-plan";
import { ShortDramaStep } from "../src/lib/short-drama-steps";
import { apiClient } from "../src/services/api/request";
import { upsertRemoteCanvasProject } from "../src/services/api/user-data";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { retryWorkflowGeneration } from "../src/services/workflow-generation-retry";
import { defaultConfig } from "../src/stores/use-config-store";
import type { GenerationTask } from "../src/services/api/task-center";

const requestText = (input: ReturnType<typeof workflowBodyTaskInput>) => `${input.prompt}\n${JSON.stringify(input.workflowBatch)}`;

function fixture(count = 4) {
    const p = createShortDramaPipeline({ x: 0, y: 0 }, true); p.nodes[0].metadata!.content = "选定故事";
    const request = { step: ShortDramaStep.Plan, pipelineId: nodeWorkflow(p.nodes[0])!.pipelineId, sourceNodeIds: [p.storyNodeId], model: "test", instruction: "", episodeCount: count, minutesPerEpisode: "2", start: 1, count };
    const result = createWorkflowDocuments(request, p.nodes, p.connections, { x: 0, y: 0 });
    const plan = completeUnifiedWorkflowPlan(result);
    const outlineResult = createWorkflowDocuments({ ...request, step: ShortDramaStep.Episodes, sourceNodeIds: [plan.frame.id] }, result.nodes, result.connections, { x: 0, y: 0 });
    const outline = outlineResult.created[0];
    outline.metadata!.content = Array.from({ length: count }, (_, i) => `## 第 ${i + 1} 集｜标题\n本集独有剧情${i + 1} ${i === 0 ? "CHR-0001" : "SCN-0001"}`).join("\n\n");
    outline.metadata!.status = "success";
    const bodyRequest = { ...request, step: ShortDramaStep.Body, sourceNodeIds: [outline.id] };
    return { ...outlineResult, plan, bodyRequest, outline };
}

test("episode context keeps current and neighbor boundaries, rejects missing and duplicates", () => {
    const text = [1, 2, 3, 4].map(n => `## 第 ${n} 集｜标题\n独有${n}`).join("\n\n");
    expect(episodeOutlineContext(text, 2).context).toContain("独有1");
    expect(episodeOutlineContext(text, 2).current).not.toContain("独有1");
    expect(episodeOutlineContext(text, 2).context).not.toContain("独有4");
    expect(() => episodeOutlineContext(text, 5)).toThrow("缺失");
    expect(() => episodeOutlineContext(`${text}\n## 第 2 集\n重复`, 2)).toThrow("重复");
    expect(episodeOutlineContext("手工无标题集纲", 1).current).toBe("手工无标题集纲");
});

test("body nodes persist references and assemble only the relevant episode and assets at submission", () => {
    const f = fixture();
    const bodies = createWorkflowDocuments(f.bodyRequest, f.nodes, f.connections, { x: 0, y: 0 });
    const body = bodies.created[0];
    expect(body.metadata!.shortDrama!.bodyContextVersion).toBe(1);
    expect(body.metadata!.prompt).not.toContain("本集独有剧情");
    expect(body.metadata!.shortDrama!.textBatch).toBeUndefined();
    const input = workflowBodyTaskInput(body, bodies.nodes, bodies.connections);
    expect(input.workflowBatch).toMatchObject({ version: 4, bodyWriting: { targetSeconds: 120 } });
    expect(requestText(input)).toContain("本集独有剧情1");
    expect(requestText(input)).toContain("本集独有剧情2");
    expect(requestText(input)).not.toContain("本集独有剧情4");
    expect(requestText(input)).toContain("声音低沉");
    expect(requestText(input)).not.toContain("靠南入口");
    f.outline.metadata!.content += "\n改稿";
    expect(() => workflowBodyTaskInput(body, bodies.nodes)).toThrow("来源已变化");
});

test("60 planned bodies stay small even when the full-series outline is large", () => {
    const f = fixture(60);
    f.outline.metadata!.content = Array.from({ length: 60 }, (_, i) => `## 第 ${i + 1} 集\n` + "独有剧情 ".repeat(1000)).join("\n");
    const result = createWorkflowDocuments(f.bodyRequest, f.nodes, f.connections, { x: 0, y: 0 });
    expect(result.created).toHaveLength(60);
    expect(new TextEncoder().encode(JSON.stringify(result.nodes)).length).toBeLessThan(2 * 1024 * 1024);
});

test("current outline codes override planned appearances, keep voice and drop image prompts", () => {
    const f = fixture();
    f.outline.metadata!.content = "## 第 1 集\nCHR-0001 SCN-0001\n## 第 2 集\n第二集\n## 第 3 集\n第三集\n## 第 4 集\n第四集";
    const character = f.plan.docs.find(node => node.metadata?.shortDrama?.planAsset?.kind === "character")!;
    character.metadata!.content = "## 人物声线设计与声音资产引用\n低沉而克制\n## 人物参考图生成提示词\n三视图长篇参数\n## 用户补充\n对母亲始终礼貌";
    // Update the outline's pinned sources to simulate an outline made after this edit.
    f.outline.metadata!.shortDrama!.sourceSignatures[character.id] = workflowSignature(character);
    const result = createWorkflowDocuments(f.bodyRequest, f.nodes, f.connections, { x: 0, y: 0 });
    const input = workflowBodyTaskInput(result.created[0], result.nodes, result.connections);
    expect(requestText(input)).toContain("低沉而克制");
    expect(requestText(input)).toContain("对母亲始终礼貌");
    expect(requestText(input)).toContain("靠南入口");
    expect(requestText(input)).not.toContain("三视图长篇参数");
});

test("body references remove production-only chapters while retaining voice, causal rules and user edits", () => {
    const f = fixture();
    const character = f.plan.docs.find(node => node.metadata?.shortDrama?.planAsset?.kind === "character")!;
    character.metadata!.content = [
        "## 人物编码、别名、选题依据与预计出场\n选择论证与全季出场排期",
        "## 人物身份与剧情功能\n保留身份与动机",
        "## 人物声线设计与声音资产引用\n声音低沉 @AUD-0001",
        "## 声线音色、质感与辨识点\n保留沙哑口吻",
        "## 音域、音高与共鸣位置\n不需要录音频段参数\n### 技术子节\n技术细节",
        "## 语言、口音与咬字习惯\n保留口音和措辞",
        "## 人物跨集不变项与变化条件\n保留能力代价与关系边界",
        "## 人物参考图生成提示词（新版）\n不需要三视图参数",
        "## 用户新增事实\n保留最新手工事实\n```md\n## 生图参数\n代码示例不是新章节\n```",
    ].join("\n");
    const records = bodySourceRecords([f.outline, character], 1, "");
    const text = records.find(record => record.id === character.id)!.content;
    for (const fact of ["保留身份与动机", "声音低沉 @AUD-0001", "保留沙哑口吻", "保留口音和措辞", "保留能力代价与关系边界", "保留最新手工事实", "代码示例不是新章节"]) expect(text).toContain(fact);
    for (const production of ["选择论证与全季出场排期", "不需要录音频段参数", "技术细节", "不需要三视图参数"]) expect(text).not.toContain(production);
    expect(records.find(record => record.id === character.id)?.assetIdentity).toEqual(character.metadata!.shortDrama!.assetIdentity);
});

test("retry entry assembles reference-only body requests and keeps the existing task identity", async () => {
    const f = fixture();
    const result = createWorkflowDocuments(f.bodyRequest, f.nodes, f.connections, { x: 0, y: 0 });
    const body = result.created[0];
    let input: any;
    const calls: string[] = [];
    const task: GenerationTask = { id: "mock", operation: "text", type: "canvas_text", status: "queued", prompt: "", attempts: 1, createdAt: "", updatedAt: "" };
    const api = {
        prepare: async (value: any) => { input = value; return value; },
        create: async () => { calls.push("create"); return task; },
        query: async () => task,
        retry: async (id: string) => { calls.push(`retry:${id}`); return task; },
    };
    await retryWorkflowGeneration(body, undefined, "canvas", defaultConfig, api, result.nodes);
    expect(requestText(input)).toContain("本集独有剧情1");
    expect(requestText(input)).not.toContain("本集独有剧情4");
    expect(input.clientOperationId).toBe(body.metadata!.shortDrama!.operationId);
    await retryWorkflowGeneration(body, { ...task, status: "failed", operation: "short_drama_batch" }, "canvas", defaultConfig, api, result.nodes);
    expect(calls).toEqual(["create", "create"]);
    expect(input.retryOf).toBe("mock");
    expect(requestText(input)).toContain("本集独有剧情1");
    expect(input.workflowBatch).toMatchObject({ version: 4, bodyWriting: { targetSeconds: 120 } });
    await retryWorkflowGeneration(body, { ...task, status: "running" }, "canvas", defaultConfig, api, result.nodes);
    expect(calls).toHaveLength(2);
});

test("recover old never-submitted bodies in place, preserving requests and historical tasks", () => {
    const f = fixture();
    const result = createWorkflowDocuments(f.bodyRequest, f.nodes, f.connections, { x: 0, y: 0 });
    const old = result.created[0];
    delete old.metadata!.shortDrama!.bodyContextVersion;
    old.metadata!.shortDrama!.textBatch = { version: 1, units: [{ label: "旧材料", text: "重复材料".repeat(100000) }] };
    const metadata = old.metadata!;
    const repaired = compactWorkflowNodes(result.nodes).find(node => node.id === old.id)!;
    expect(repaired.id).toBe(old.id);
    expect(repaired.position).toEqual(old.position);
    expect(repaired.parentId).toBe(old.parentId);
    expect(repaired.metadata!.shortDrama!.operationId).toBe(metadata.shortDrama!.operationId);
    expect(repaired.metadata!.shortDrama!.sourceSignatures).toEqual(metadata.shortDrama!.sourceSignatures);
    expect(repaired.metadata!.shortDrama!.textBatch).toBeUndefined();
    expect(requestText(workflowBodyTaskInput(repaired, result.nodes))).toContain("本集独有剧情1");
    metadata.shortDrama!.submission = "submitted"; metadata.taskId = "paid-task";
    expect(compactWorkflowNodes(result.nodes).find(node => node.id === old.id)).toBe(old);
    metadata.shortDrama!.submission = "planned"; delete metadata.taskId;
    metadata.composerContent = "用户独立修改";
    expect(compactWorkflowNodes(result.nodes).find(node => node.id === old.id)).toBe(old);
    delete metadata.composerContent;
    f.outline.metadata!.content += "changed";
    expect(workflowSignature(f.outline)).not.toBe(metadata.shortDrama!.sourceSignatures[f.outline.id]);
    expect(compactWorkflowNodes(result.nodes).find(node => node.id === old.id)).toBe(old);
});

test("oversized UTF-8 canvas fails explicitly before sending a network request", async () => {
    const previous = apiClient.defaults.adapter;
    let requests = 0;
    apiClient.defaults.adapter = async () => { requests++; throw new Error("must not send"); };
    try {
        const f = fixture(); f.outline.metadata!.content = "汉".repeat(Math.ceil(MAX_CANVAS_PAYLOAD_BYTES / 3));
        await expect(upsertRemoteCanvasProject({ id: "test", nodes: f.nodes, connections: f.connections } as CanvasProject)).rejects.toMatchObject({ status: 413, retryable: false });
        expect(requests).toBe(0);
    } finally { apiClient.defaults.adapter = previous; }
});

test("large body reference inputs use episode writing, never generic asset extraction", () => {
    const batch = workflowBodyBatch([{ title: "本集集纲", step: "story.episodes", content: "第1集剧情" }, { title: "人物", content: "人物设定".repeat(20000) }], 1000);
    expect(batch?.version).toBe(4);
    expect(batch && "context" in batch && batch.context[0].text).toContain("第1集剧情");
    expect(batch?.units.every(unit => !unit.text.includes("第1集剧情"))).toBe(true);
});

test("current outline references take precedence over broad planned episode ranges", () => {
    const f = fixture();
    f.outline.metadata!.content = "## 第 1 集\n本集没有提及任何已登记角色\n## 第 2 集\n边界";
    const result = createWorkflowDocuments({ ...f.bodyRequest, count: 1 }, f.nodes, f.connections, { x: 0, y: 0 });
    const input = workflowBodyTaskInput(result.created[0], result.nodes, result.connections);
    expect(input.prompt).not.toContain("声音低沉");
    expect(input.prompt).not.toContain("靠南入口");
});
