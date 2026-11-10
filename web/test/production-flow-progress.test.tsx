import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasProductionFlowProgress } from "../src/pages/canvas/canvas-production-flow-progress";
import { CanvasGroupTaskDetails } from "../src/pages/canvas/canvas-group-task-details";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { AgentRun } from "../src/services/api/agent";

const flow: NonNullable<NonNullable<AgentRun["production"]>["flow"]> = {
    root: "story", stage: "连续性检查", total: 180, saved: 170, accepted: 169, running: 1, held: 1, repair: 0, lastProgressAt: "2026-11-08",
    stages: [
        { key: "detail", name: "逐集详细规划", total: 120, totalKnown: true, completed: 120, percent: 100, running: 0, held: 0, repair: 0, status: "completed" },
        { key: "review", name: "连续性检查", total: 20, totalKnown: true, completed: 19, percent: 95, running: 0, held: 1, repair: 0, status: "blocked" },
        { key: "publish", name: "汇总与发布", total: 1, totalKnown: true, completed: 0, percent: 0, running: 0, held: 0, repair: 0, status: "pending" },
    ],
    units: [{ id: "held", key: "flow/story/review/1", name: "第1至6集检查", stage: "review", status: "held", generation: 3, attempts: 0, percent: 0, issues: [{ layer: "execution", rule: "request_failed", target: "task", message: "模型服务暂时不可用", action: "重试未完成步骤", severity: "blocking", code: "upstream_error", errorSource: "upstream" }] }],
    stopReason: "连续性检查未完成，已保留其他成果",
};

test("stages show exact percentages and directly actionable causes", () => {
    const html = renderToStaticMarkup(<CanvasProductionFlowProgress flow={flow} runId="run" onRefresh={() => {}} />);
    expect(html).toContain("100%"); expect(html).toContain("95%"); expect(html).toContain("0%");
    expect(html).toContain("120/120"); expect(html).toContain("19/20");
    expect(html).toContain("停止原因：连续性检查未完成"); expect(html).toContain("模型服务暂时不可用");
    expect(html).toContain("重试此步骤"); expect(html).toContain('aria-label="连续性检查完成进度"');
    expect(html).not.toContain("任务中心");
});

test("large stage lists are not mounted until expanded and blockers are bounded", () => {
    const units = Array.from({ length: 2000 }, (_, index) => ({ ...flow.units[0], id: `${index}`, name: `未完成项${index}`, key: `flow/story/${index}` }));
    const html = renderToStaticMarkup(<CanvasProductionFlowProgress flow={{ ...flow, units }} runId="run" onRefresh={() => {}} />);
    expect(html).toContain("未完成项0"); expect(html).toContain("显示更多未完成步骤");
    expect(html).not.toContain("未完成项6"); expect(html).not.toContain("未完成项1999");
});

test("container exposes the same server progress before a final document is published", () => {
    const owner = { id: "group", title: "故事总纲", type: CanvasNodeType.Frame, position: { x: 0, y: 0 }, width: 600, height: 400, metadata: { shortDrama: { pipelineId: "pipeline", role: "collection", sourceNodeIds: ["manifest"], assetGroup: { manifestId: "manifest" } } } } as CanvasNodeData;
    const manifest = { ...owner, id: "manifest", type: CanvasNodeType.Text, parentId: owner.id, metadata: { shortDrama: { pipelineId: "pipeline", assetKey: "$summary", productionAgent: { runId: "run" } } } } as CanvasNodeData;
    const run = { id: "run", status: "waiting_user", production: { targetNodeId: manifest.id, workKind: "plan", flow } } as AgentRun;
    const html = renderToStaticMarkup(<CanvasGroupTaskDetails node={owner} nodes={[owner, manifest]} submitting={false} onResume={() => {}} onRetry={() => {}} onCancel={() => {}} agentState={{ runs: [run], nodeErrors: {}, readErrors: {}, syncError: "", busy: {}, control: async () => {}, refresh: () => {} }} />);
    expect(html).toContain("120/120"); expect(html).toContain("95%"); expect(html).toContain("停止原因");
    expect(html).toContain("重试此步骤");
});

test("scheduler shows queued work, actual calls and one main recovery entry", () => {
    const html = renderToStaticMarkup(<CanvasProductionFlowProgress flow={{ ...flow, queued: 3, scheduler: { window: 4, submitted: 12, received: 8, retrySpent: 2, retryBudget: 6, totalRetries: 2 } }} runId="run" onRefresh={() => {}} />);
    expect(html).toContain("任务已停止派发"); expect(html).toContain("本阶段请求 12 次");
    expect(html).toContain("已接收 8 次"); expect(html).toContain("并发窗口 4");
    expect(html).toContain("连续无进展重试 2/6");
    expect(html).toContain("累计自动重试 2 次");
    expect(html).not.toContain("执行中 1");
    expect(html).toContain("继续未完成部分");
});

test("active generation is not confused with placeholder queue counts or synchronization errors", () => {
    const owner = { id: "group", title: "故事总纲", type: CanvasNodeType.Frame, position: { x: 0, y: 0 }, width: 600, height: 400, metadata: { shortDrama: { pipelineId: "pipeline", role: "collection", sourceNodeIds: ["manifest"], assetGroup: { manifestId: "manifest" } } } } as CanvasNodeData;
    const manifest = { ...owner, id: "manifest", type: CanvasNodeType.Text, parentId: owner.id, metadata: { shortDrama: { pipelineId: "pipeline", assetKey: "$summary", productionAgent: { runId: "run" } } } } as CanvasNodeData;
    const activeFlow = { ...flow, stage: "确定主线", stopReason: undefined, held: 0, accepted: 0, saved: 0, total: 1, units: [], scheduler: { window: 8, submitted: 1, received: 0, retryBudget: 6 } };
    const run = { id: "run", status: "running", production: { targetNodeId: manifest.id, workKind: "plan", flow: activeFlow } } as AgentRun;
    const html = renderToStaticMarkup(<CanvasGroupTaskDetails node={owner} nodes={[owner, manifest]} submitting={false} onResume={() => {}} onRetry={() => {}} onCancel={() => {}} agentState={{ runs: [run], nodeErrors: {}, readErrors: {}, syncError: "旧任务状态整理未完成：系统处理失败，请稍后重试", busy: {}, control: async () => {}, refresh: () => {} }} />);
    expect(html).toContain("当前状态：正在执行");
    expect(html).toContain("等待模型返回首份结果");
    expect(html).toContain("这不代表生成任务失败");
    expect(html).toContain("旧任务状态整理未完成");
    expect(html).not.toContain("排队中 1");
    expect(html).not.toContain('role="alert"');
});

test("queued stage is labeled queued even when its assignment is running", () => {
    const stage = { key: "foundation", name: "主线、结局与世界规则", total: 1, totalKnown: true, completed: 0, percent: 0, running: 1, held: 0, repair: 0, status: "running" };
    const queued = { ...flow, stopReason: undefined, running: 0, queued: 1, held: 0, stages: [stage], units: [{ ...flow.units[0], stage: "foundation", status: "queued" }] };
    const html = renderToStaticMarkup(<CanvasProductionFlowProgress flow={queued} runStatus="running" onRefresh={() => {}} />);
    expect(html).toContain('production-flow-status">排队中');
    expect(html).not.toContain('production-flow-status">执行中');
});
