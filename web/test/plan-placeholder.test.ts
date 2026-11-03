import { expect, test } from "bun:test";
import { applyAgentCanvasPatch, recoverCompletedProductionDocuments, type AgentCanvasPatch } from "@/lib/canvas/agent-canvas-patch";
import { workflowAncestors } from "@/lib/canvas/canvas-short-drama-workflow";
import { groupMemberState } from "@/lib/canvas/canvas-group-session";
import { isPlanPlaceholder, isPlanPlaceholderContent } from "@/lib/canvas/plan-placeholder";
import { productionPlanCanvasDocumentCount, productionPlanCanvasNeedsRefresh } from "@/lib/canvas/production-agent-state";
import type { AgentRun } from "@/services/api/agent";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const frame: CanvasNodeData = {
    id: "plan-frame", type: CanvasNodeType.Frame, title: "项目制作方案", position: { x: 0, y: 0 }, width: 800, height: 600,
    metadata: { shortDrama: { stage: "story", step: "story.plan", pipelineId: "pipeline", role: "collection", sourceNodeIds: ["pap-story"], sourceSignatures: {} } },
};

const placeholder: CanvasNodeData = {
    id: "pap-story", type: CanvasNodeType.Text, title: "故事总纲与世界规则", parentId: "plan-frame", position: { x: 40, y: 80 }, width: 320, height: 240,
    metadata: {
        status: "loading", content: "等待生成",
        shortDrama: { stage: "story", step: "story.plan", pipelineId: "pipeline", role: "document", sourceNodeIds: [], sourceSignatures: {},
            assetKey: "story", planSection: "story" as never, planGeneration: { runId: "run-1", status: "queued" } },
    },
};

const filled: CanvasNodeData = {
    ...placeholder,
    metadata: {
        status: "success", content: "故事总纲正文",
        shortDrama: { stage: "story", step: "story.plan", pipelineId: "pipeline", role: "document", sourceNodeIds: [], sourceSignatures: {}, sourceSteps: [],
            assetKey: "story", planSection: "story" as never },
    },
};

const project: CanvasProject = { id: "canvas", title: "画布", nodes: [frame, placeholder], connections: [], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 }, createdAt: "2026-10-30", updatedAt: "2026-10-30" };

test("placeholder is recognised and reported as queued", () => {
    expect(isPlanPlaceholder(placeholder)).toBe(true);
    expect(isPlanPlaceholder(filled)).toBe(false);
    expect(groupMemberState(placeholder)).toBe("排队中");
    expect(groupMemberState(filled)).toBe("已完成");
});

test("placeholders never count as generated plan documents", () => {
    expect(productionPlanCanvasDocumentCount(frame, [placeholder])).toBe(0);
    expect(productionPlanCanvasDocumentCount(frame, [filled])).toBe(1);
});

test("canvas refresh still waits for documents that are only placeholders", () => {
    const target: CanvasNodeData = { ...placeholder, id: "target", metadata: { status: "success", shortDrama: { ...filled.metadata!.shortDrama!, assetKey: "$summary" } } };
    const run = { id: "run-1", canvasId: "canvas", status: "running", production: { workKind: "plan", targetNodeId: "target", documentCount: 1 } } as unknown as AgentRun;
    expect(productionPlanCanvasNeedsRefresh([frame, target, placeholder], run)).toBe(true);
    expect(productionPlanCanvasNeedsRefresh([frame, target, filled], run)).toBe(false);
});

test("a delivered document fills its placeholder in place", () => {
    const patch: AgentCanvasPatch = { canvasId: "canvas", updatedAt: "2026-10-30T01:00:00Z", nodes: [{ before: placeholder, after: filled }], connections: [] };
    const merged = applyAgentCanvasPatch(project, patch);
    const node = merged.nodes.find((entry) => entry.id === "pap-story")!;
    expect(merged.nodes).toHaveLength(2);
    expect(node.metadata).toMatchObject({ status: "success", content: "故事总纲正文" });
    expect(isPlanPlaceholder(node)).toBe(false);
    expect(node.metadata?.shortDrama && "planGeneration" in node.metadata.shortDrama).toBe(false);
});

test("journal recovery replaces a local placeholder and ignores placeholder candidates", () => {
    const moved = { ...filled, position: { x: 500, y: 500 } };
    const patch: AgentCanvasPatch = { canvasId: "canvas", updatedAt: "2026-10-30T01:00:00Z", nodes: [{ before: null, after: moved }], connections: [] };
    const recovered = recoverCompletedProductionDocuments(project, [patch]);
    const node = recovered.nodes.find((entry) => entry.id === "pap-story")!;
    expect(recovered.nodes).toHaveLength(2);
    expect(node.metadata).toMatchObject({ status: "success", content: "故事总纲正文" });
    expect(node.position).toEqual(placeholder.position);

    const onlyPlaceholder: AgentCanvasPatch = { ...patch, nodes: [{ before: null, after: { ...placeholder, metadata: { ...placeholder.metadata, status: "success" } } }] };
    expect(recoverCompletedProductionDocuments(project, [onlyPlaceholder])).toBe(project);
});

test("a placeholder cannot be used as a source for downstream steps", () => {
    expect(() => workflowAncestors(["pap-story"], [frame, placeholder], "pipeline")).toThrow("请先完成");
    expect(() => workflowAncestors(["pap-story"], [frame, filled], "pipeline")).not.toThrow();
});

test("placeholder becomes not started once the coordinating run stops", () => {
    const snap = (status: string) => ({ kind: "agent", run: { status, events: [] } }) as never;
    expect(groupMemberState(placeholder, undefined, snap("failed"))).toBe("未启动");
    expect(groupMemberState(placeholder, undefined, snap("rejected"))).toBe("未启动");
    expect(groupMemberState(placeholder, undefined, snap("running"))).toBe("排队中");
});

test("placeholder shows the parallel status of its own document", () => {
    const snap = (status: string) => ({ kind: "agent", run: { status, events: [] } }) as never;
    expect(groupMemberState(placeholder, undefined, snap("running"), "running")).toBe("执行中");
    expect(groupMemberState(placeholder, undefined, snap("running"), "queued")).toBe("排队中");
    expect(groupMemberState(placeholder, undefined, snap("running"), "retrying")).toBe("重试中");
    expect(groupMemberState(placeholder, undefined, snap("running"), "error")).toBe("执行失败");
    // 协调任务已停止时仍以未启动为准
    expect(groupMemberState(placeholder, undefined, snap("failed"), "running")).toBe("未启动");
});

test("body still reading the placeholder text counts as a placeholder even without planGeneration", () => {
    const lost: CanvasNodeData = { ...placeholder, metadata: { ...placeholder.metadata, status: "success", shortDrama: { ...filled.metadata!.shortDrama! } } };
    expect(isPlanPlaceholderContent(lost)).toBe(false);
    const stripped: CanvasNodeData = { ...placeholder, metadata: { ...placeholder.metadata, status: "loading", shortDrama: { ...filled.metadata!.shortDrama! } } };
    expect(isPlanPlaceholderContent(stripped)).toBe(true);
    expect(isPlanPlaceholder(stripped)).toBe(true);
    expect(groupMemberState(stripped)).toBe("排队中");
    expect(groupMemberState({ ...stripped, metadata: { ...stripped.metadata, content: "故事总纲正文" } })).not.toBe("排队中");
});