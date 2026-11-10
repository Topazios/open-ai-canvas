import { expect, test } from "bun:test";
import { productionJournalRows } from "@/lib/canvas/production-agent-journal";
import type { AgentEvent } from "@/services/api/agent";

test("storyboard rejected shots and stopped coordinator never look completed", () => {
    const events = [
        { type: "production_scene_attempt_failed", payload: { text: "镜头 S03-002 缺少 camera", assignment: { sceneId: "S03", generation: 7, saved: 0, total: 1 } } },
        { type: "production_coordinator_stopped", payload: { reason: "分镜校验未通过", text: "等待手动重试" } },
        { type: "production_coordinator_recovered", payload: { generation: 8, text: "保留已保存镜头" } },
    ].map((event, index) => ({ ...event, eventId: `r:${index}`, runId: "r", seq: index + 1, createdAt: "2026-11-06T09:26:00Z" })) as AgentEvent[];
    const rows = productionJournalRows(events);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ warning: true });
    expect(rows[0].detail).toContain("S03-002 缺少 camera");
    expect(rows[1]).toMatchObject({ warning: true, title: "整集任务已停止" });
    expect(rows[2]).toMatchObject({ warning: false, title: "主任务已恢复" });
});
