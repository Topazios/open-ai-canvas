import { expect, test } from "bun:test";
import { productionFlowDisplay, productionFlowStageStatus } from "../src/lib/canvas/production-flow-display";
import { latestGroupAgentRun, groupMemberState } from "../src/lib/canvas/canvas-group-session";
import type { AgentRun } from "../src/services/api/agent";
import type { CanvasNodeData } from "../src/types/canvas";

const flow: NonNullable<NonNullable<AgentRun["production"]>["flow"]> = {
    root: "story", stage: "主线", total: 1, saved: 0, accepted: 0, running: 1, queued: 0, repair: 0, held: 0, lastProgressAt: "2026-11-09", units: [],
    scheduler: { window: 8, submitted: 1, received: 0, retryBudget: 6 },
};

test("display distinguishes generating, queueing, repairing, and scheduling", () => {
    expect(productionFlowDisplay(flow).label).toBe("正在执行");
    expect(productionFlowDisplay(flow).detail).toContain("首份结果");
    expect(productionFlowDisplay({ ...flow, running: 0, queued: 1 }).label).toBe("排队中");
    expect(productionFlowDisplay({ ...flow, running: 0, repair: 1 }).label).toBe("自动修复中");
    expect(productionFlowDisplay({ ...flow, running: 0 }).label).toBe("正在安排下一步");
});

test("stopped run state takes precedence over retained in-flight counters", () => {
    for (const [status, label] of [["waiting_user", "已暂停"], ["failed", "已停止"], ["cancelled", "已取消"], ["completed", "已完成"]] as const) {
        expect(productionFlowDisplay(flow, { status }).label).toBe(label);
    }
    expect(productionFlowDisplay(flow, { status: "running", production: { paused: true, waitingForBoundary: true } }).label).toBe("正在暂停");
});

test("automatic recovery is distinct from a paused run and never masks an active call", () => {
    const recovering = { ...flow, running: 0, scheduler: { ...flow.scheduler!, cooldownUntil: Date.now()+60000 } };
    expect(productionFlowDisplay(recovering, { status: "running" }).label).toBe("等待自动恢复");
    expect(productionFlowDisplay(recovering, { status: "waiting_user" }).label).toBe("已暂停");
    expect(productionFlowDisplay({ ...recovering, running: 1 }).label).toBe("正在执行");
});

test("newer server snapshot wins without mixing different run identities", () => {
    const older = { id: "run", updatedAt: "2026-11-09T00:00:00+08:00", status: "running" } as AgentRun;
    const newer = { ...older, updatedAt: "2026-11-09T00:00:05+08:00", status: "waiting_user" } as AgentRun;
    expect(latestGroupAgentRun(older, newer)).toBe(newer);
    expect(latestGroupAgentRun(newer, older)).toBe(newer);
    expect(latestGroupAgentRun(older, { ...newer, id: "other" })).toBe(older);
    expect(latestGroupAgentRun(undefined, newer)).toBe(newer);
});

test("a placeholder with its own live receipt is executing, while a document without a call awaits writeback", () => {
    const placeholder = { metadata: { content: "等待生成", shortDrama: { planSection: "story", assetKey: "story" } } } as unknown as CanvasNodeData;
    const run = { id: "run", status: "running", production: { flow } } as AgentRun;
    const snapshot = { kind: "agent" as const, run };
    expect(groupMemberState(placeholder, snapshot)).toBe("执行中");
    expect(groupMemberState(placeholder, undefined, snapshot)).toBe("待写入");
    expect(groupMemberState(placeholder, undefined, { ...snapshot, run: { ...run, status: "cancelled" } })).toBe("已取消");
});

test("paused stage does not keep presenting its retained calls as active", () => {
    const stage = { key: "foundation", name: "主线", total: 1, totalKnown: true, completed: 0, percent: 0, running: 1, repair: 0, held: 0, status: "running" };
    expect(productionFlowStageStatus(stage, [], true)).toBe("paused");
    expect(productionFlowStageStatus({ ...stage, status: "completed" }, [], true)).toBe("completed");
});
