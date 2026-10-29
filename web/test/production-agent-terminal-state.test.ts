import { expect, test } from "bun:test";
import { applyProductionAgentTerminalState } from "@/pages/canvas/use-production-agent-runs";
import type { AgentRun } from "@/services/api/agent";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node: CanvasNodeData = {
    id: "plan-node",
    type: CanvasNodeType.Text,
    title: "项目制作方案",
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
    metadata: {
        status: "loading",
        taskStage: "正在提交制作 Agent",
        shortDrama: {
            stage: "story",
            step: "story.plan",
            pipelineId: "pipeline",
            sourceNodeIds: [],
            sourceSignatures: {},
            role: "document",
            productionAgent: { runId: "run-1" },
            submission: "submitting",
        },
    },
};

const run = (status: AgentRun["status"], extra: Partial<AgentRun> = {}): AgentRun => ({
    id: "run-1",
    canvasId: "canvas",
    status,
    permissionMode: "auto",
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:01Z",
    ...extra,
});

test("failed run immediately projects a retryable error onto the original node", () => {
    const result = applyProductionAgentTerminalState(node, run("failed", { failureMessage: "HTTP 503" }));
    expect(result.metadata).toMatchObject({ status: "error", taskStage: "制作 Agent 已停止", errorDetails: "HTTP 503" });
    expect(result.metadata?.shortDrama?.submission).toBe("rejected");
    expect(result.metadata?.shortDrama?.productionAgent?.runId).toBe("run-1");
});

test("completed run clears the submitting state without changing the Agent identity", () => {
    const result = applyProductionAgentTerminalState(node, run("completed"));
    expect(result.metadata).toMatchObject({ status: "success", taskStage: "制作 Agent 已完成" });
    expect(result.metadata?.errorDetails).toBeUndefined();
    expect(result.metadata?.shortDrama?.submission).toBe("submitted");
});

test("asset-stage failure preserves the completed plan and records only execution failure", () => {
    const planNode: CanvasNodeData = { ...node, metadata: { ...node.metadata, status: "success", shortDrama: { ...node.metadata!.shortDrama!, submission: "submitted" } } };
    const result = applyProductionAgentTerminalState(planNode, run("failed", {
        failureMessage: "资产任务请求失败",
        production: { targetNodeId: planNode.id, workKind: "plan", planReady: true, assetsStarted: true, paused: false, waitingForBoundary: false, processedPages: 5, totalPages: 7, artifactCount: 5, validated: false },
    }));
    expect(result.metadata).toMatchObject({ status: "success", taskStage: "制作方案已完成 · 资产执行未完成" });
    expect(result.metadata?.errorDetails).toBeUndefined();
    expect(result.metadata?.shortDrama).toMatchObject({ submission: "submitted", assetExecutionStatus: "failed", assetExecutionError: "资产任务请求失败" });
});

test("non-terminal receipts do not change the node", () => {
    expect(applyProductionAgentTerminalState(node, run("running"))).toBe(node);
});

const warning = { severity: "warning" as const, errorSource: "content", phase: "validation", outcome: "not_saved", code: "content_incomplete", message: "资产覆盖尚不完整" };
const warningEvent = { runId: "run-1", seq: 4, type: "run_failed", payload: warning, createdAt: "2026-10-25" };

test("content warnings stop as idle and rejected while retaining authored content", () => {
    const authored = { ...node, metadata: { ...node.metadata, content: "保留的原稿" } };
    const result = applyProductionAgentTerminalState(authored, run("failed", { events: [warningEvent] }));
    expect(result.metadata).toMatchObject({ status: "idle", taskStage: "制作 Agent 待处理", generationWarning: warning, content: "保留的原稿" });
    expect(result.metadata?.errorDetails).toBeUndefined();
    expect(result.metadata?.shortDrama?.submission).toBe("rejected");
});

test("partial receipts preserve server warning but an explicit real failure takes priority", () => {
    const server = { ...node, metadata: { ...node.metadata, status: "idle" as const, generationWarning: warning } };
    expect(applyProductionAgentTerminalState(server, run("failed")).metadata?.generationWarning).toEqual(warning);
    const failed = applyProductionAgentTerminalState(server, run("failed", { failureMessage: "HTTP 503", events: [{ ...warningEvent, payload: { severity: "error", errorSource: "upstream" } }] }));
    expect(failed.metadata).toMatchObject({ status: "error", errorDetails: "HTTP 503" });
    expect(failed.metadata?.generationWarning).toBeUndefined();
});

test("running, completed and cancelled receipts clear old node warnings", () => {
    const stopped = { ...node, metadata: { ...node.metadata, status: "idle" as const, generationWarning: warning } };
    for (const status of ["running", "queued", "completed", "cancelled"] as const) {
        const result = applyProductionAgentTerminalState(stopped, run(status, { events: [warningEvent] }));
        expect(result.metadata?.generationWarning).toBeUndefined();
        expect(result.metadata?.status).toBe(status === "completed" ? "success" : status === "cancelled" ? "idle" : "loading");
    }
    expect(applyProductionAgentTerminalState(stopped, run("failed", { id: "other" }))).toBe(stopped);
});

test("legacy local waiting_user receipts do not project a visible warning", () => {
    const receipt = run("waiting_user", { events: [{ ...warningEvent, type: "production_control", payload: { severity: "warning", errorSource: "application", phase: "validation", action: "needs_revision", outcome: "needs_revision", text: "当前制作项需补全来源" } }] });
    const result = applyProductionAgentTerminalState(node, receipt);
    expect(result.metadata).toMatchObject({ status: "idle", taskStage: "制作 Agent 待处理" });
    expect(result.metadata?.generationWarning).toBeUndefined();
    expect(result.metadata?.errorDetails).toBeUndefined();
    expect(result.metadata?.shortDrama?.submission).toBe("submitted");
});
