import { expect, test } from "bun:test";
import { mergeProductionEvents, productionJournalRows, productionParallelSummary } from "../src/lib/canvas/production-agent-journal";
import type { AgentEvent, AgentRun } from "../src/services/api/agent";

test("scene progress separates saved scenes from provider receipts and dependencies", () => {
    const progress: NonNullable<AgentRun["production"]> = { targetNodeId: "board", executionMode: "scene", paused: false, waitingForBoundary: false, processedPages: 1, totalPages: 3, artifactCount: 4, shotTotal: 12, validated: false, concurrencyLimit: 3, parallelItems: [
        { key: "S1", name: "S1", status: "succeeded", savedShots: 4, totalShots: 4 },
        { key: "S2", name: "S2", status: "running", savedShots: 0, totalShots: 4 },
        { key: "S3", name: "S3", status: "blocked", savedShots: 0, totalShots: 4 },
    ] };
    const text = productionParallelSummary(progress);
    expect(text).toContain("已完成 1/3 场");
    expect(text).toContain("执行 1");
    expect(text).toContain("等待前置 1");
    expect(text).toContain("已保存 4/12 镜");
    expect(text).not.toContain("待保存 1");
});

test("replayed scene ownership events retain task identity without duplicating history", () => {
    const event: AgentEvent = { runId: "run", seq: 1, eventId: "run:1", type: "production_scene_checkpoint", createdAt: "2026-11-06T00:00:00Z", payload: { taskId: "worker-2", itemName: "场次 S2", assignment: { sceneId: "S2", generation: 3, saved: 4, total: 8, shotIds: ["S2-003", "S2-004"] } } };
    const rows = productionJournalRows(mergeProductionEvents([event], [event]), "run");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("镜头组内容已保存");
    expect(rows[0].detail).toContain("worker-2");
    expect(rows[0].detail).toContain("执行代次 3");
    expect(rows[0].detail).toContain("S2-003");
});

test("scene failure details remain available for human review", () => {
    const event: AgentEvent = { runId: "run", seq: 2, eventId: "run:2", type: "production_scene_attempt_failed", createdAt: "2026-11-06T00:00:00Z", payload: { taskId: "worker-3", text: "镜头 S2-003 缺少道具交接状态", severity: "warning", assignment: { sceneId: "S2", generation: 4, saved: 2, total: 8 } } };
    const rows = productionJournalRows([event], "run");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("本次镜头工作组生成未通过");
    expect(rows[0].detail).toContain("缺少道具交接状态");
    expect(rows[0].detail).toContain("worker-3");
});
