import { expect, test } from "bun:test";
import { productionAssetGroupState } from "@/lib/canvas/production-agent-state";
import type { AgentRun } from "@/services/api/agent";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

test("new asset groups distinguish unknown inventory counts from known content preparation", () => {
    const anchor = { id: "anchor", type: CanvasNodeType.Text, metadata: { shortDrama: { productionAgent: { runId: "run" } } } } as CanvasNodeData;
    const group = { id: "group", type: CanvasNodeType.Frame, metadata: { shortDrama: { planGroup: { rootFrameId: "root", kind: "character" } } } } as CanvasNodeData;
    const run = { id: "run", status: "running", production: { targetNodeId: "anchor", assetGroups: [{ kind: "character", total: 0, completed: 0, status: "extracting" }] } } as AgentRun;
    expect(productionAssetGroupState(group, anchor, run)).toMatchObject({ active: true, complete: false, label: "正在整理资产清单 · 数量待清单确定" });
    run.production!.assetGroups![0] = { kind: "character", total: 9, completed: 0, status: "queued" };
    expect(productionAssetGroupState(group, anchor, run)).toMatchObject({ active: true, label: "正在准备内容节点 · 已完成 0/9" });
    run.status = "waiting_user";
    expect(productionAssetGroupState(group, anchor, run)).toMatchObject({ active: false, label: "内容准备已停止，可在详情继续 · 已完成 0/9" });
    run.production!.assetGroups![0] = { kind: "character", total: 0, completed: 0, status: "extracting" };
    expect(productionAssetGroupState(group, anchor, run)).toMatchObject({ active: false, label: "清单整理已停止，可在详情继续 · 数量待清单确定" });
});
