import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createCanvasNode } from "../src/lib/canvas/canvas-project-domain";
import { createWorkflowDocuments, nodeWorkflow, workflowSignature } from "../src/lib/canvas/canvas-short-drama-workflow";
import { screenplayAuditChecks, screenplayAuditState, screenplayReportMarkdown, type AutoReviewState, type ScreenplayAuditReport } from "../src/lib/canvas/workflow-screenplay-audit";
import { CanvasScreenplayNodeContent } from "../src/components/canvas/canvas-screenplay-audit";
import { isTransientReviewFailure, recoverReviewBody } from "../src/pages/canvas/use-screenplay-auto-review";
import { ShortDramaStep as S } from "../src/lib/short-drama-steps";
import { CanvasNodeType } from "../src/types/canvas";
import { canonicalize } from "json-canonicalize";

function fixture() {
    const outline = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: "## 第 1 集\n主角面对阻力后作出决定。", status: "success", shortDrama: { step: S.Episodes, stage: "story", pipelineId: "p", role: "document", sourceNodeIds: [], sourceSignatures: {} } });
    const body = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: "场1 内景 照相馆 日\n林晓举起相机。\n两人沉默。", status: "success", shortDrama: { step: S.Body, stage: "story", pipelineId: "p", role: "document", episodeNumber: 1, version: 1, sourceNodeIds: [outline.id], sourceSignatures: { [outline.id]: workflowSignature(outline) }, parameters: { episodeCount: 1, minutesPerEpisode: "1-2", instruction: "" } } });
    const request = { step: S.Audit, pipelineId: "p", sourceNodeIds: [body.id], anchorId: body.id, model: "test", instruction: "", episodeCount: 1, minutesPerEpisode: "1-2", start: 1, count: 1 };
    const result = createWorkflowDocuments(request, [outline, body], [], { x: 0, y: 0 });
    const node = result.created[0];
    const value: ScreenplayAuditReport = {
        version: 1, quality: "有条件通过", usability: "不通过", summary: "关键行动尚未展开。", limitations: ["未试读配音。"],
        checks: (Object.keys(screenplayAuditChecks) as (keyof typeof screenplayAuditChecks)[]).map(key => ({ key, verdict: "有条件通过", note: "根据本集正文判断" })),
        coverage: [{ sourceId: node.id, mode: "全文审读", note: "本集全文" }],
        findings: [{ id: "F1", severity: "P1", certainty: "确认错误", title: "关键事件只剩概述", location: "场1末段", evidence: [{ sourceId: node.id, quote: "两人沉默。" }], basis: "集纲约定", impact: "分镜需自行补剧情", suggestion: "补充具体反应", recheck: "核对选择与后果", repairPrompt: "展开沉默前后的行动。" }],
        repairPrompt: "只修复F1。",
    };
    node.metadata = { ...node.metadata, status: "success", shortDrama: { ...nodeWorkflow(node)!, screenplayAudit: { ...nodeWorkflow(node)!.screenplayAudit!, report: value, reportSignature: canonicalize(value), reportMarkdown: screenplayReportMarkdown(value) } } };
    return { outline, node, nodes: [outline, node] };
}

test("transient upstream failures are retryable, content and unconfirmed ones are not", () => {
    expect(isTransientReviewFailure("任务失败:上游流式请求失败,生成未完成")).toBe(true);
    expect(isTransientReviewFailure("网络中断")).toBe(true);
    expect(isTransientReviewFailure("请求超时 504")).toBe(true);
    expect(isTransientReviewFailure("内容审核未通过")).toBe(false);
    expect(isTransientReviewFailure("诊断报告待核对")).toBe(false);
    expect(isTransientReviewFailure("提交结果待确认,网络中断")).toBe(false);
    expect(isTransientReviewFailure("连续两轮阻塞数没有下降")).toBe(false);
});

test("a failed repair restores the body so the report is valid and repairable again", () => {
    const f = fixture();
    const original = f.node.metadata!.content!;
    const failed = {
        ...f.node,
        metadata: {
            ...f.node.metadata!, status: "error" as const, content: "修复到一半的内容",
            shortDrama: { ...nodeWorkflow(f.node)!, screenplayRepair: { bodyNodeId: f.node.id, contextNodeIds: [], reportSignature: "x" } },
        },
    };
    expect(screenplayAuditState(failed, [f.outline, failed]).report).toBeUndefined();
    const recovered = recoverReviewBody([f.outline, failed], f.node.id, { content: original, stage: "准备重新修复" });
    const body = recovered.find(node => node.id === f.node.id)!;
    expect(body.metadata?.status).toBe("success");
    expect(body.metadata?.content).toBe(original);
    expect(nodeWorkflow(body)?.screenplayRepair).toBeUndefined();
    expect(nodeWorkflow(body)?.screenplayAudit?.report).toBeDefined();
    expect(screenplayAuditState(body, recovered).report).toBeDefined();
});

test("an interrupted auto review shows a retry entry and never mentions manual handling", () => {
    const f = fixture();
    const review: AutoReviewState = { status: "manual", round: 1, maxRounds: 3, startedAt: "t", stopReason: "修复失败:上游流式请求失败", rounds: [] };
    const paused = { ...f.node, metadata: { ...f.node.metadata!, shortDrama: { ...nodeWorkflow(f.node)!, autoReview: review } } };
    const props = { node: paused, nodes: [f.outline, paused], onEdit: () => {}, onReport: () => {}, onAudit: () => {}, onRepair: () => {}, onResume: () => {} };
    const html = renderToStaticMarkup(createElement(CanvasScreenplayNodeContent, props));
    expect(html).toContain("重试自动修复");
    expect(html).toContain("已中断");
    expect(html).not.toContain("人工");
    expect(html).not.toContain("手动");
    const withoutResume = renderToStaticMarkup(createElement(CanvasScreenplayNodeContent, { ...props, onResume: undefined }));
    expect(withoutResume).not.toContain("重试自动修复");
});
