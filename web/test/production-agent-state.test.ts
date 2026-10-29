import { expect, test } from "bun:test";
import { bindProductionAgentRun, productionAgentNodePresent, productionTaskState, productionAssetGroupState, productionPlanAssetAction, productionPlanCanvasNeedsRefresh, productionPlanCanvasDocumentCount, hasMissingCompletedProductionOutput } from "@/lib/canvas/production-agent-state";
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
            productionAgent: {},
            submission: "submitting",
        },
    },
};

const run: AgentRun = {
    id: "run-1",
    canvasId: "canvas",
    status: "queued",
    permissionMode: "auto",
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:01Z",
};

test("submit receipt binds its run ID to the original node immediately", () => {
    const result = bindProductionAgentRun(node, run);
    expect(result.metadata).toMatchObject({ status: "loading", taskStage: "已排队等待制作 Agent" });
    expect(result.metadata?.shortDrama?.productionAgent?.runId).toBe("run-1");
    expect(result.metadata?.shortDrama?.submission).toBe("submitted");
});

test("root production nodes remain pollable without a parent container", () => {
    expect(productionAgentNodePresent([node], node.id)).toBe(true);
    expect(productionAgentNodePresent([{ ...node, parentId: "frame-1" }], node.id)).toBe(false);
    expect(productionAgentNodePresent([{ ...node, parentId: "frame-1" }, { ...node, id: "frame-1" }], node.id)).toBe(true);
    expect(productionAgentNodePresent([node], "missing-node")).toBe(false);
});

test("a retained Agent run ID is not evidence that a group is still running", () => {
    const bound = bindProductionAgentRun(node, run);
    expect(productionTaskState(bound)).toEqual({ active: true, failed: false, complete: false });
    expect(productionTaskState({ ...bound, metadata: { ...bound.metadata, status: "success" } })).toEqual({ active: false, failed: false, complete: true });
    expect(productionTaskState({ ...bound, metadata: { ...bound.metadata, status: "error" } })).toEqual({ active: false, failed: true, complete: false });
    expect(productionTaskState({ ...bound, metadata: { ...bound.metadata, status: "idle" } })).toEqual({ active: false, failed: false, complete: false });
    expect(productionTaskState()).toEqual({ active: false, failed: false, complete: false });
});

test("run receipts override stale canvas status without applying an unrelated run", () => {
    const bound = bindProductionAgentRun(node, run);
    const receipt = { ...run, production: { targetNodeId: node.id, paused: false } } as AgentRun;
    expect(productionTaskState(bound, { ...receipt, status: "failed" })).toEqual({ active: false, failed: true, complete: false });
    expect(productionTaskState(bound, { ...receipt, status: "completed" })).toEqual({ active: false, failed: false, complete: true });
    expect(productionTaskState(bound, { ...receipt, status: "cancelled" })).toEqual({ active: false, failed: false, complete: false });
    expect(productionTaskState(bound, { ...receipt, production: { ...receipt.production!, paused: true } }).active).toBe(false);
    expect(productionTaskState(bound, { ...receipt, id: "unrelated", status: "failed" }).active).toBe(true);
});

test("asset groups wait for standards and show only their own running work", () => {
    const anchor = bindProductionAgentRun(node, run);
    const group: CanvasNodeData = { ...node, id: "characters", metadata: { shortDrama: { ...node.metadata!.shortDrama!, planGroup: { rootFrameId: "plan", kind: "character" } } } };
    const receipt: AgentRun = { ...run, production: { targetNodeId: node.id, paused: false, waitingForBoundary: false, processedPages: 3, totalPages: 10, artifactCount: 3, validated: false,
        assetGroups: [{ kind: "character", total: 4, completed: 0, status: "waiting_standards" }] } };
    expect(productionAssetGroupState(group, anchor, receipt)).toEqual({ active: false, failed: false, complete: false, label: "等待前置规范完成 · 已完成 0/4" });
    expect(productionAssetGroupState(group, { ...anchor, metadata: { ...anchor.metadata, status: "error" } }, receipt)?.label).toContain("等待前置规范完成");
    receipt.production!.assetGroups![0].status = "waiting";
    expect(productionAssetGroupState(group, anchor, receipt)?.active).toBe(false);
    receipt.production!.assetGroups![0].status = "running";
    expect(productionAssetGroupState(group, anchor, receipt)?.active).toBe(true);
    receipt.production!.paused = true;
    expect(productionAssetGroupState(group, anchor, receipt)).toMatchObject({ active: false, label: "已暂停 · 已完成 0/4" });
    receipt.production!.paused = false;
    receipt.production!.assetGroups![0].status = "error";
    expect(productionAssetGroupState(group, anchor, receipt)?.label).toContain("部分失败，查看详情");
    expect(productionAssetGroupState(group, anchor, { ...receipt, status: "failed" })).toMatchObject({ failed: true, label: expect.stringContaining("此类资产失败") });
    const waitingGroup = { ...receipt, production: { ...receipt.production!, assetGroups: [{ kind: "character", total: 4, completed: 0, status: "waiting" as const }] } };
    expect(productionAssetGroupState(group, anchor, { ...waitingGroup, status: "failed" })).toMatchObject({ failed: false, label: expect.stringContaining("任务已停止，尚未完成") });
    receipt.production!.assetGroups![0] = { kind: "character", total: 4, completed: 4, status: "complete" };
    expect(productionAssetGroupState(group, anchor, receipt)).toMatchObject({ active: false, complete: true });
    expect(productionAssetGroupState(group, anchor, { ...receipt, id: "old-run" })).toMatchObject({ active: false, complete: false, label: "等待任务状态" });
    expect(productionAssetGroupState(node, anchor, receipt)).toBeUndefined();
});

test("a coordinator warning does not erase an independent asset-group error", () => {
    const anchor = bindProductionAgentRun(node, run);
    const group: CanvasNodeData = { ...node, id: "characters", metadata: { shortDrama: { ...node.metadata!.shortDrama!, planGroup: { rootFrameId: "plan", kind: "character" } } } };
    const receipt = { ...run, status: "failed", events: [{ runId: run.id, seq: 1, type: "run_failed", payload: { severity: "warning", errorSource: "content" } }], production: { targetNodeId: node.id, assetGroups: [{ kind: "character", total: 2, completed: 0, status: "error" }] } } as unknown as AgentRun;
    expect(productionTaskState(anchor, receipt)).toMatchObject({ failed: false, warning: true, complete: false });
    expect(productionAssetGroupState(group, anchor, receipt)).toMatchObject({ failed: true, complete: false });
    expect(productionAssetGroupState(group, anchor, receipt)?.warning).toBeUndefined();
});

test("plan assets are an explicit action only after the entire plan completes", () => {
    const root: CanvasNodeData = { ...node, type: CanvasNodeType.Frame, metadata: { shortDrama: { ...node.metadata!.shortDrama!, role: "collection", assetGroup: { manifestId: node.id } } } };
    const anchor: CanvasNodeData = { ...node, metadata: { shortDrama: { ...node.metadata!.shortDrama!, assetKey: "$summary" } } };
    const receipt: AgentRun = { ...run, status: "completed", production: { targetNodeId: node.id, paused: false, waitingForBoundary: false, processedPages: 5, totalPages: 5, artifactCount: 5, validated: true, planReady: true, assetsStarted: false, assetTotal: 4 } };
    for (const target of [root, anchor]) {
        expect(productionPlanAssetAction(target)?.ready).toBe(false);
        expect(productionPlanAssetAction(target, receipt)).toMatchObject({ ready: true, targetNodeId: node.id });
        expect(productionPlanAssetAction(target, { ...receipt, status: "running" })?.ready).toBe(false);
        expect(productionPlanAssetAction(target, { ...receipt, production: { ...receipt.production!, validated: false } })?.ready).toBe(false);
        expect(productionPlanAssetAction(target, { ...receipt, production: { ...receipt.production!, planReady: false } })?.ready).toBe(false);
        expect(productionPlanAssetAction(target, { ...receipt, production: { ...receipt.production!, targetNodeId: "different-plan" } })?.ready).toBe(false);
        expect(productionPlanAssetAction(target, { ...receipt, status: "failed", production: { ...receipt.production!, assetsStarted: true, validated: false } })?.ready).toBe(true);
        expect(productionPlanAssetAction(target, { ...receipt, production: { ...receipt.production!, assetTotal: 0 } })?.reason).toBe("请先保存制作方案的故事总纲");
    }
    expect(productionPlanAssetAction(node, receipt)).toBeUndefined();
    const assetGroup: CanvasNodeData = { ...root, metadata: { shortDrama: { ...root.metadata!.shortDrama!, planGroup: { rootFrameId: "root", kind: "character" } } } };
    expect(productionPlanAssetAction(assetGroup, receipt)).toBeUndefined();
});

test("plan progress detects documents saved remotely but missing from the canvas projection", () => {
    const root: CanvasNodeData = {
        ...node,
        id: "plan-frame",
        type: CanvasNodeType.Frame,
        metadata: { shortDrama: { ...node.metadata!.shortDrama!, role: "collection", assetGroup: { manifestId: node.id }, sourceNodeIds: [node.id] } },
    };
    const manifest = { ...node, parentId: root.id, metadata: { ...node.metadata, shortDrama: { ...node.metadata!.shortDrama!, role: "document" as const, assetKey: "$summary" } } };
    const receipt: AgentRun = { ...run, production: { targetNodeId: manifest.id, workKind: "plan", documentCount: 2 } as AgentRun["production"] };
    expect(productionPlanCanvasNeedsRefresh([root, manifest], receipt)).toBe(true);

    const first = { ...node, id: "plan-story", parentId: root.id, metadata: { ...node.metadata, content: "故事总纲", shortDrama: { ...node.metadata!.shortDrama!, role: "document" as const, planSection: "story" } } };
    const second = { ...node, id: "plan-visual", parentId: root.id, metadata: { ...node.metadata, content: "视觉规范", shortDrama: { ...node.metadata!.shortDrama!, role: "document" as const, planSection: "visual" } } };
    expect(productionPlanCanvasNeedsRefresh([root, manifest, first, second], receipt)).toBe(false);
    expect(productionPlanCanvasNeedsRefresh([root, manifest, first], receipt)).toBe(true);
    expect(productionPlanCanvasNeedsRefresh([root, manifest, first, { ...second, parentId: "another-frame" }], receipt)).toBe(true);
    expect(productionPlanCanvasNeedsRefresh([node], receipt)).toBe(false);
});

test("same-revision local cache cannot hide completed production documents from the remote canvas", () => {
    const saved: CanvasNodeData = {
        ...node,
        id: "saved-plan-document",
        metadata: { ...node.metadata, status: "success", content: "已保存正文", shortDrama: { ...node.metadata!.shortDrama!, planSection: "story" } },
    };
    expect(hasMissingCompletedProductionOutput([], [saved])).toBe(true);
    expect(hasMissingCompletedProductionOutput([{ ...saved, metadata: { ...saved.metadata, content: "旧正文" } }], [saved])).toBe(true);
    expect(hasMissingCompletedProductionOutput([saved], [saved])).toBe(false);
});

test("plan frame counts saved standard documents rather than relying on its membership index", () => {
    const root: CanvasNodeData = {
        ...node,
        id: "plan-frame",
        type: CanvasNodeType.Frame,
        metadata: { shortDrama: { ...node.metadata!.shortDrama!, role: "collection", assetGroup: { manifestId: node.id }, sourceNodeIds: [node.id] } },
    };
    const manifest = { ...node, parentId: root.id, metadata: { ...node.metadata, shortDrama: { ...node.metadata!.shortDrama!, role: "document" as const, assetKey: "$summary" } } };
    const documents = ["story", "visual"].map((planSection, index): CanvasNodeData => ({
        ...node,
        id: `plan-${index}`,
        parentId: root.id,
        metadata: { ...node.metadata, shortDrama: { ...node.metadata!.shortDrama!, role: "document", planSection } },
    }));
    expect(productionPlanCanvasDocumentCount(root, [manifest, ...documents])).toBe(2);
    expect(productionPlanCanvasDocumentCount(root, [manifest])).toBe(0);
    expect(productionPlanCanvasDocumentCount({ ...root, metadata: { shortDrama: { ...root.metadata!.shortDrama!, planGroup: { rootFrameId: root.id, kind: "character" } } } }, documents)).toBe(0);
});

test("legacy plan documents without planSection still appear in the canvas", () => {
    const root: CanvasNodeData = {
        ...node,
        id: "legacy-plan-frame",
        type: CanvasNodeType.Frame,
        metadata: { shortDrama: { ...node.metadata!.shortDrama!, role: "collection", assetGroup: { manifestId: node.id } } },
    };
    const manifest = { ...node, parentId: root.id, metadata: { ...node.metadata, shortDrama: { ...node.metadata!.shortDrama!, role: "document" as const, assetKey: "$summary" } } };
    const legacy = ["story", "inventory", "visual"].map((assetKey, index): CanvasNodeData => ({
        ...node,
        id: `legacy-plan-${index}`,
        parentId: root.id,
        metadata: { ...node.metadata, shortDrama: { ...node.metadata!.shortDrama!, role: "document" as const, assetKey } },
    }));
    expect(productionPlanCanvasDocumentCount(root, [manifest, ...legacy])).toBe(3);
    const receipt: AgentRun = { ...run, production: { targetNodeId: manifest.id, workKind: "plan", documentCount: 4 } as AgentRun["production"] };
    expect(productionPlanCanvasNeedsRefresh([root, manifest, ...legacy], receipt)).toBe(true);
});
