import { expect, test } from "bun:test";
import { createCanvasNode } from "../src/lib/canvas/canvas-project-domain";
import { createWorkflowDocuments, workflowBodyTaskInput, workflowGenerationSources, workflowAncestors, workflowSignature, nodeWorkflow } from "../src/lib/canvas/canvas-short-drama-workflow";
import { selectedAuditBodies, parseScreenplayAuditReport, screenplayAuditState, screenplayReportMarkdown, auditContextNodes, latestBodyAudit, screenplayAuditChecks, screenplayBodySignature, type ScreenplayAuditReport } from "../src/lib/canvas/workflow-screenplay-audit";
import { buildGenerationTaskNodeResult } from "../src/lib/canvas/canvas-generation-task-sync";
import { deriveShortDramaProgress } from "../src/lib/canvas/canvas-short-drama";
import { ShortDramaStep as S, activeShortDramaSteps, nextShortDramaSteps } from "../src/lib/short-drama-steps";
import { CanvasNodeType } from "../src/types/canvas";
import type { GenerationTask } from "../src/services/api/task-center";
import { defaultShortDramaSettings } from "../src/lib/short-drama-settings";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { CanvasScreenplayNodeContent } from "../src/components/canvas/canvas-screenplay-audit";
import { buildCanvasCustomNodeScopes } from "../src/pages/canvas/use-canvas-scoped-node-renderers";
import { retryWorkflowGeneration } from "../src/services/workflow-generation-retry";
import { defaultConfig } from "../src/stores/use-config-store";
import { canonicalize } from "json-canonicalize";

function fixture() {
    const outline = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: "## 第 1 集\n主角面对阻力后作出决定。\n## 第 2 集\n决定的后果。\n## 第 3 集\n后续独有内容", status: "success", shortDrama: { step: S.Episodes, stage: "story", pipelineId: "p", role: "document", sourceNodeIds: [], sourceSignatures: {} } });
    const body = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: "场1 内景 照相馆 日\n林晓举起相机。\n林晓：靠近一点。\n两人沉默。", status: "success", shortDrama: { step: S.Body, stage: "story", pipelineId: "p", role: "document", episodeNumber: 1, version: 1, sourceNodeIds: [outline.id], sourceSignatures: { [outline.id]: workflowSignature(outline) }, parameters: { episodeCount: 3, minutesPerEpisode: "1-2", instruction: "" } } });
    const unrelated = createCanvasNode(CanvasNodeType.Text, { x: 500, y: 500 }, { content: "无关资产库的大量细节", status: "success", shortDrama: { step: S.Characters, stage: "assets", pipelineId: "p", role: "document", assetKey: "CHR-0002", sourceNodeIds: [], sourceSignatures: {} } });
    const request = { step: S.Audit, pipelineId: "p", sourceNodeIds: [body.id], anchorId: body.id, model: "test", instruction: "", episodeCount: 3, minutesPerEpisode: "1-2", start: 1, count: 3 };
    const nodes = [outline, body, unrelated];
    const result = createWorkflowDocuments(request, nodes, [], { x: 0, y: 0 });
    return { outline, body: result.created[0], unrelated, request, ...result, audit: result.created[0] };
}

function report(f: ReturnType<typeof fixture>): ScreenplayAuditReport {
    return { version: 1, quality: "有条件通过", usability: "不通过", summary: "关键行动尚未展开，需补足选择与后果。", limitations: ["未读取其他集正文，未试读配音，时长未实测。"],
        checks: (Object.keys(screenplayAuditChecks) as (keyof typeof screenplayAuditChecks)[]).map(key => ({ key, verdict: key === "causality" ? "不通过" : "有条件通过", note: "根据所提供本集正文与集纲判断" })),
        coverage: [f.body, f.outline].map(node => ({ sourceId: node.id, mode: "全文审读", note: node === f.outline ? "仅所提供的本集与相邻集纲片段" : "本集全文" })), findings: [{ id: "F1", severity: "P1", certainty: "确认错误", title: "关键事件只剩概述", location: "场1末段", evidence: [{ sourceId: f.body.id, quote: "两人沉默。" }], basis: "集纲约定呈现阻力和选择", impact: "分镜需自行补剧情", suggestion: "补充具体反应与决定，不延长空白停顿", recheck: "核对选择与后果是否发生且不改变集纲", repairPrompt: "展开沉默前后造成局面变化的行动，不更改身份、设定与结局。" }], repairPrompt: "只修复F1，补足关键行动、选择和结果；保留有效正文和编号，修订后重新审核。" };
}

function complete(f: ReturnType<typeof fixture>) {
    const value = report(f);
    f.audit.metadata = { ...f.audit.metadata, status: "success", content: f.body.metadata!.content, shortDrama: { ...nodeWorkflow(f.audit)!, screenplayAudit: { ...nodeWorkflow(f.audit)!.screenplayAudit!, report: value, reportSignature: canonicalize(value), reportMarkdown: screenplayReportMarkdown(value) } } };
    return value;
}

test("audit runs on the正文节点, never creates a report node or changes正文", () => {
    const f = fixture(); const before = JSON.stringify(f.body);
    const input = workflowBodyTaskInput(f.audit, f.nodes);
    expect(input.workflowBatch).toBeUndefined();
    expect(input.structuredOutput).toMatchObject({ name: "screenplay_episode_audit", strict: true });
    expect(nodeWorkflow(f.audit)?.productionAgent).toBeUndefined();
    expect(input.prompt).toContain(JSON.stringify(f.body.metadata!.content!).slice(1, -1));
    expect(input.prompt).toContain("单集时长（分钟）：1-2");
    expect(input.prompt).toContain("不改原稿");
    expect(input.prompt).toContain("本土叙事只按项目明确的故事发生地/文化来源判断");
    expect(input.prompt).not.toContain("无关资产库");
    expect(input.prompt).not.toContain("后续独有内容");
    expect(nodeWorkflow(f.audit)?.sourceNodeIds).toEqual([f.outline.id]);
    expect(nodeWorkflow(f.audit)?.screenplayAudit?.bodyNodeId).toBe(f.body.id);
    expect(nodeWorkflow(f.audit)?.screenplayAudit?.contextSignatures?.[f.outline.id]).toBeTruthy();
    expect(f.created).toHaveLength(1);
    expect(f.nodes.filter(node => node.id === f.body.id)).toHaveLength(1);
    expect(JSON.stringify(f.body)).toBe(before);
    expect(activeShortDramaSteps.some(step => step.id === S.Reconcile)).toBe(false);
    expect(nextShortDramaSteps(S.Body).map(step => step.id)).toContain(S.Audit);
});

test("all completed group episodes reuse their正文节点; unfinished episodes are explicitly excluded", () => {
    const f = fixture();
    const body2 = structuredClone(f.body); body2.id = "body2"; nodeWorkflow(body2)!.episodeNumber = 2;
    const body3 = structuredClone(f.body); body3.id = "body3"; nodeWorkflow(body3)!.episodeNumber = 3; body3.metadata!.status = "loading";
    const frame = createCanvasNode(CanvasNodeType.Frame, { x: 0, y: 0 }, { shortDrama: { ...nodeWorkflow(f.body)!, role: "collection", episodeNumber: undefined, sourceNodeIds: [f.body.id, body2.id, body3.id], sourceSignatures: {} } });
    for (const body of [f.body, body2, body3]) body.parentId = frame.id;
    const nodes = [...f.nodes, body2, body3, frame];
    expect(selectedAuditBodies([frame.id], "p", nodes).omittedEpisodes).toEqual([3]);
    const result = createWorkflowDocuments({ ...f.request, sourceNodeIds: [frame.id] }, nodes, [], { x: 0, y: 0 });
    expect(result.created).toHaveLength(2);
    expect(result.created.map(node => node.id).sort()).toEqual(["body2", f.body.id].sort());
    expect(result.created.every(node => nodeWorkflow(node)?.screenplayAudit?.omittedEpisodes[0] === 3)).toBe(true);
    expect(workflowBodyTaskInput(result.created[0], result.nodes).prompt).not.toContain(body2.id);
    expect(result.nodes.filter(node => nodeWorkflow(node)?.step === S.Body)).toHaveLength(4);
});

test("audit range limits a collection to the requested episode interval", () => {
    const f = fixture();
    const body2 = structuredClone(f.body); body2.id = "body2"; nodeWorkflow(body2)!.episodeNumber = 2;
    const body3 = structuredClone(f.body); body3.id = "body3"; nodeWorkflow(body3)!.episodeNumber = 3;
    const frame = createCanvasNode(CanvasNodeType.Frame, { x: 0, y: 0 }, { shortDrama: { ...nodeWorkflow(f.body)!, role: "collection", sourceNodeIds: [f.body.id, body2.id, body3.id], sourceSignatures: {} } });
    for (const body of [f.body, body2, body3]) body.parentId = frame.id;
    const nodes = [...f.nodes, body2, body3, frame];
    const selected = selectedAuditBodies([frame.id], "p", nodes, { start: 2, end: 2 });
    expect(selected.selectedEpisodes).toEqual([2]);
    expect(selected.bodies.map(node => nodeWorkflow(node)?.episodeNumber)).toEqual([2]);
    const result = createWorkflowDocuments({ ...f.request, sourceNodeIds: [frame.id], start: 2, count: 1 }, nodes, f.connections, { x: 0, y: 0 });
    expect(result.created).toHaveLength(1);
    expect(nodeWorkflow(result.created[0])?.episodeNumber).toBe(2);
});

test("report validates scope, severity, certainty and exact evidence rather than accepting headings as quality", () => {
    const f = fixture(); const value = report(f);
    expect(parseScreenplayAuditReport(JSON.stringify(value), f.audit, f.nodes)).toEqual(value);
    value.findings[0].evidence[0].quote = "拼接的不存在原文";
    expect(() => parseScreenplayAuditReport(JSON.stringify(value), f.audit, f.nodes)).toThrow("未匹配");
    value.findings[0].evidence[0].quote = "两人沉默。";
    value.quality = "通过";
    expect(() => parseScreenplayAuditReport(JSON.stringify(value), f.audit, f.nodes)).toThrow("重大");
    value.findings = []; value.usability = "通过"; value.coverage[0].mode = "抽样";
    expect(() => parseScreenplayAuditReport(JSON.stringify(value), f.audit, f.nodes)).toThrow("未全文审读");
});

test("report normalizes evidence that omits standalone duration markers", () => {
    const f = fixture();
    const content = "场1 内景 照相馆 日\n林晓举起相机。\n【节拍时长：13秒】\n林晓：靠近一点。";
    f.body.metadata!.content = content;
    f.audit.metadata!.content = content;
    const value = report(f);
    value.findings[0].evidence[0].quote = "林晓举起相机。\n林晓：靠近一点。";
    const parsed = parseScreenplayAuditReport(JSON.stringify(value), f.audit, f.nodes);
    expect(parsed.findings[0].evidence[0].quote).toContain("【节拍时长：13秒】");
});

test("explicit repair updates the正文节点 in place and keeps a recoverable previous version", () => {
    const f = fixture(); complete(f);
    const before = JSON.stringify(f.body);
    const result = createWorkflowDocuments({ ...f.request, step: S.Body, auditRepairReportId: f.audit.id }, f.nodes, f.connections, { x: 0, y: 0 });
    expect(result.created).toHaveLength(1);
    const repair = result.created[0];
    expect(repair.id).toBe(f.body.id);
    expect(nodeWorkflow(repair)?.version).toBe(1);
    expect(nodeWorkflow(repair)?.screenplayRepair?.bodyNodeId).toBe(f.body.id);
    expect(nodeWorkflow(repair)?.sourceNodeIds).toContain(f.outline.id);
    expect(nodeWorkflow(repair)?.screenplayRepair?.previousContent).toContain("两人沉默");
    expect(workflowBodyTaskInput(repair, result.nodes).workflowBatch).toBeUndefined();
    expect(workflowBodyTaskInput(repair, result.nodes).prompt).toContain("只修复F1");
    expect(JSON.stringify(f.body)).toBe(before);
    repair.metadata!.content = "修订正文，尚未复检"; repair.metadata!.status = "success";
    expect(latestBodyAudit(repair, result.nodes)?.id).toBe(repair.id);
    expect(() => workflowAncestors([repair.id], result.nodes, "p", result.connections)).not.toThrow();
    expect(auditContextNodes(repair, result.nodes).map(node => node.id)).toContain(f.outline.id);
});

test("inline diagnosis repair keeps the body report binding and remains submittable", () => {
    const f = fixture();
    const value = report(f);
    f.body.metadata!.shortDrama!.screenplayAudit = {
        bodyNodeId: f.body.id,
        contextNodeIds: [f.outline.id],
        contextSignatures: { [f.outline.id]: workflowSignature(f.outline) },
        selectedEpisodes: [1],
        omittedEpisodes: [],
        bodySignature: workflowSignature(f.body),
        report: value,
        reportSignature: canonicalize(value),
        reportMarkdown: screenplayReportMarkdown(value),
    };
    f.body.metadata!.status = "success";
    const result = createWorkflowDocuments({ ...f.request, step: S.Body, auditRepairReportId: f.body.id }, f.nodes, f.connections, { x: 0, y: 0 });
    const repair = result.created[0];
    expect(repair.id).toBe(f.body.id);
    expect(nodeWorkflow(repair)?.screenplayRepair?.reportNodeId).toBeUndefined();
    expect(() => workflowBodyTaskInput(repair, result.nodes)).not.toThrow();
    expect(workflowBodyTaskInput(repair, result.nodes).prompt).toContain("只修复F1");
});

test("re-audit replaces stale repair state before the next review submission", () => {
    const f = fixture(); complete(f);
    const repairResult = createWorkflowDocuments({ ...f.request, step: S.Body, auditRepairReportId: f.audit.id }, f.nodes, f.connections, { x: 0, y: 0 });
    const repaired = repairResult.created[0];
    repaired.metadata!.content = "修订正文，待重新审核";
    repaired.metadata!.status = "error";
    nodeWorkflow(repaired)!.materializedTaskId = "old-repair-task";
    const reAudit = createWorkflowDocuments({ ...f.request, sourceNodeIds: [repaired.id], step: S.Audit }, repairResult.nodes, repairResult.connections, { x: 0, y: 0 });
    const next = reAudit.created[0];
    expect(next.id).toBe(repaired.id);
    expect(nodeWorkflow(next)?.screenplayRepair).toBeUndefined();
    expect(nodeWorkflow(next)?.screenplayAudit?.bodyNodeId).toBe(next.id);
    expect(nodeWorkflow(next)?.materializedTaskId).toBeUndefined();
    expect(nodeWorkflow(next)?.submission).toBe("planned");
    expect(workflowBodyTaskInput(next, reAudit.nodes).structuredOutput).toMatchObject({ name: "screenplay_episode_audit" });
});

test("edited or deleted sources, changed report and global settings prohibit stale repairs", () => {
    for (const kind of ["body", "outline", "report", "deleted", "settings"] as const) {
        const f = fixture(); complete(f);
        if (kind === "body") f.body.metadata!.content += "后续修改";
        if (kind === "outline") f.outline.metadata!.content += "集纲修改";
        if (kind === "report") f.audit.metadata!.shortDrama!.screenplayAudit!.report!.summary += "手改报告";
        if (kind === "deleted") f.nodes = f.nodes.filter(node => node.id !== f.body.id);
        const settings = kind === "settings" ? defaultShortDramaSettings() : undefined;
        expect(screenplayAuditState(f.audit, f.nodes, settings).stale).toBe(true);
        expect(() => createWorkflowDocuments({ ...f.request, step: S.Body, auditRepairReportId: f.audit.id, globalSettings: settings }, f.nodes, f.connections, { x: 0, y: 0 })).toThrow();
    }
});

test("a persistence-only global settings revision does not block a valid repair", () => {
    const f = fixture();
    const settings = defaultShortDramaSettings();
    const data = nodeWorkflow(f.audit)!;
    data.parameters = { ...data.parameters!, globalSettings: settings };
    data.screenplayAudit!.bodySignature = workflowSignature(f.audit);
    complete(f);
    const current = { ...settings, revision: settings.revision + 1 };
    expect(screenplayAuditState(f.audit, f.nodes, current).stale).toBe(false);
});

test("audit remains valid after task metadata and the inline report are persisted", () => {
    const f = fixture();
    const binding = nodeWorkflow(f.audit)!.screenplayAudit!;
    expect(binding.bodySignature).toBe(screenplayBodySignature(f.audit));
    const value = report(f);
    f.audit.metadata = {
        ...f.audit.metadata,
        status: "success",
        taskStage: "正文诊断完成",
        taskId: "audit-task",
        content: f.body.metadata!.content,
        shortDrama: {
            ...nodeWorkflow(f.audit)!,
            materializedTaskId: "audit-task",
            submission: "submitted",
            screenplayAudit: {
                ...binding,
                report: value,
                reportSignature: canonicalize(value),
                reportMarkdown: screenplayReportMarkdown(value),
            },
        },
    };
    expect(screenplayAuditState(f.audit, f.nodes).stale).toBe(false);
    expect(() => workflowBodyTaskInput(f.audit, f.nodes)).not.toThrow();
});

test("task result stores the report on the正文节点 and never replaces正文 with report text", async () => {
    const f = fixture(); const before = f.body.metadata!.content;
    const task: GenerationTask = { id: "audit-task", type: "canvas_text", status: "succeeded", prompt: "", attempts: 1, createdAt: "", updatedAt: "", resultJson: JSON.stringify({ text: JSON.stringify(report(f)) }) };
    const restored = await buildGenerationTaskNodeResult(f.audit, task, f.nodes);
    expect(restored.metadata?.status).toBe("success");
    expect(nodeWorkflow(restored)?.screenplayAudit?.report?.findings).toHaveLength(1);
    const roundtrip = JSON.parse(JSON.stringify([...f.nodes.filter(node => node.id !== restored.id), restored]));
    expect(screenplayAuditState(restored, roundtrip).stale).toBe(false);
    expect(f.body.metadata!.content).toBe(before);
    const invalid = await buildGenerationTaskNodeResult(f.audit, { ...task, resultJson: JSON.stringify({ text: "模型没有按合同返回" }) }, f.nodes);
    expect(invalid.metadata?.status).toBe("error");
    expect(invalid.metadata?.content).toBe(before);
    expect(nodeWorkflow(invalid)?.screenplayAudit?.rawResult).toBe("模型没有按合同返回");
    expect(nodeWorkflow(invalid)?.screenplayAudit?.report).toBeUndefined();
    expect(nodeWorkflow(invalid)?.materializedTaskId).toBe(task.id);
});

test("a failed inline diagnosis keeps the正文 eligible for single retry and batch diagnosis", () => {
    const f = fixture();
    const audit = nodeWorkflow(f.audit)!;
    f.audit.metadata!.status = "error";
    audit.screenplayAudit!.rawResult = "模型暂时没有返回合法报告";
    expect(workflowBodyTaskInput(f.audit, f.nodes).structuredOutput).toMatchObject({ name: "screenplay_episode_audit" });
    const selected = selectedAuditBodies([f.audit.id], "p", f.nodes);
    expect(selected.bodies.map((node) => node.id)).toEqual([f.audit.id]);
});

test("a diagnosis remains valid during its own loading submission", () => {
    const f = fixture();
    f.audit.metadata!.status = "loading";
    expect(() => workflowBodyTaskInput(f.audit, f.nodes)).not.toThrow();
    expect(workflowBodyTaskInput(f.audit, f.nodes).structuredOutput).toMatchObject({ name: "screenplay_episode_audit" });
});

test("diagnosis accepts a fenced or double-encoded JSON report before contract validation", () => {
    const f = fixture();
    const value = report(f);
    expect(parseScreenplayAuditReport(`说明文字\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, f.audit, f.nodes)).toEqual(value);
    expect(parseScreenplayAuditReport(JSON.stringify(JSON.stringify(value)), f.audit, f.nodes)).toEqual(value);
});

test("正文节点 exposes repair while its inline report is current and hides it when stale", () => {
    const f = fixture(); complete(f);
    const props = { node: f.body, nodes: f.nodes, onEdit: () => {}, onReport: () => {}, onAudit: () => {}, onRepair: () => {} };
    expect(renderToStaticMarkup(createElement(CanvasScreenplayNodeContent, props))).toContain("修复正文");
    f.body.metadata!.content += "手动改稿";
    const html = renderToStaticMarkup(createElement(CanvasScreenplayNodeContent, props));
    expect(html).toContain("诊断待复检");
    expect(html).not.toContain("修复正文");
});

test("a正文节点 without a report exposes diagnosis instead of re-audit", () => {
    const f = fixture();
    const props = { node: f.audit, nodes: f.nodes, onEdit: () => {}, onReport: () => {}, onAudit: () => {}, onRepair: () => {} };
    const html = renderToStaticMarkup(createElement(CanvasScreenplayNodeContent, props));
    expect(html).toContain(">诊断<");
    expect(html).not.toContain("重新审核");
});

test("custom node subscription only follows the bound report and used context", () => {
    const f = fixture(); complete(f);
    const scopes = buildCanvasCustomNodeScopes({ nodes: f.nodes, visibleNodes: [f.body], connections: f.connections, mentionReferencesByNodeId: new Map(), configInputsById: new Map(), runningNodeId: null });
    expect(scopes.get(f.body.id)?.nodes).toContain(f.audit);
    expect(scopes.get(f.body.id)?.nodes).toContain(f.outline);
    expect(scopes.get(f.body.id)?.nodes).not.toContain(f.unrelated);
});

test("audit submission/retry uses the existing persistent task API with structured output", async () => {
    const f = fixture(); let prepared: any; let calls = 0;
    const task: GenerationTask = { id: "audit-task", type: "canvas_text", status: "queued", prompt: "", attempts: 1, createdAt: "", updatedAt: "" };
    const api = { prepare: async (input: any) => { prepared = input; return input; }, create: async () => { calls++; return task; }, query: async () => task, retry: async () => task };
    await retryWorkflowGeneration(f.audit, undefined, "canvas", defaultConfig, api, f.nodes);
    expect(calls).toBe(1);
    expect(prepared.workflowBatch).toBeUndefined();
    expect(prepared.structuredOutput.name).toBe("screenplay_episode_audit");
    expect(prepared.metadata.workflowStep).toBe("story.audit");
    expect(prepared.prompt).not.toContain("无关资产库");
});

test("repair submits one prose request, keeps the complete episode and does not resend the entire diagnosis", async () => {
    const f = fixture(); const value = complete(f);
    value.findings[0].impact = "诊断长篇影响说明".repeat(1000);
    value.findings[0].basis = "诊断长篇依据说明".repeat(1000);
    nodeWorkflow(f.audit)!.screenplayAudit!.reportSignature = canonicalize(value);
    const result = createWorkflowDocuments({ ...f.request, step: S.Body, auditRepairReportId: f.audit.id }, f.nodes, f.connections, { x: 0, y: 0 });
    const repair = result.created[0];
    let prepared: any; let calls = 0;
    const api = { prepare: async (input: any) => { prepared = input; return input; }, create: async () => { calls++; return { id: "repair", status: "queued" } as GenerationTask; }, query: async () => ({} as GenerationTask), retry: async () => ({} as GenerationTask) };
    await retryWorkflowGeneration(repair, undefined, "canvas", defaultConfig, api, result.nodes);
    expect(calls).toBe(1);
    expect(prepared.metadata.workflowStep).toBe("story.body");
    expect(prepared.workflowBatch).toBeUndefined();
    expect(prepared.structuredOutput).toBeUndefined();
    expect(prepared.prompt).toContain(JSON.stringify(f.body.metadata!.content!).slice(1, -1));
    expect(prepared.prompt).toContain(value.repairPrompt);
    expect(prepared.prompt).toContain(value.findings[0].recheck);
    expect(prepared.prompt).toContain("确认错误");
    expect(prepared.prompt).not.toContain("诊断长篇影响说明");
    expect(prepared.prompt).not.toContain("诊断长篇依据说明");
    expect(prepared.prompt).not.toContain("无关资产库");
});

test("new guide has five stages and keeps reference images after plan, with audit after prose", () => {
    const f = fixture();
    const stages = deriveShortDramaProgress(f.nodes, f.connections).steps;
    expect(stages).toHaveLength(5);
    expect(stages.some(step => step.id === "assets")).toBe(false);
    expect(stages[0].tasks.map(task => task.id)).toEqual(["story.topic", "story.plan", "guide.assets.references", "story.episodes", "story.body", "story.audit"]);
    expect(stages.flatMap(stage => stage.tasks).some(task => task.id === "guide.assets.fixed")).toBe(false);
});

test("audit uses the exact pinned episode, refuses cross-pipeline/ambiguous versions and stale submissions", () => {
    const f = fixture();
    expect(() => selectedAuditBodies([f.body.id], "other", f.nodes)).toThrow();
    expect(() => selectedAuditBodies([f.body.id, f.body.id], "p", f.nodes)).toThrow();
    f.outline.metadata!.content += "改变的前文";
    expect(() => workflowBodyTaskInput(f.audit, f.nodes)).toThrow("已变化");
    expect(() => workflowGenerationSources(nodeWorkflow(f.audit)!, f.nodes)).toThrow("审核依据已变化");
});

test("audit does not reuse the正文 generation guard when an upstream outline has a newer version", () => {
    const f = fixture();
    f.outline.metadata!.content += "\n补充当前版本的集纲信息";
    const result = createWorkflowDocuments(f.request, f.nodes, f.connections, { x: 0, y: 0 });
    expect(result.created).toHaveLength(1);
    expect(() => workflowBodyTaskInput(result.created[0], result.nodes, result.connections)).not.toThrow();
    expect(nodeWorkflow(result.created[0])?.screenplayAudit?.contextSignatures?.[f.outline.id]).toBe(workflowSignature(f.outline));
});
