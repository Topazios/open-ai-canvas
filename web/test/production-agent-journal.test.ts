import { describe, test, expect } from "bun:test";
import { mergeProductionEvents, productionJournalRows } from "../src/lib/canvas/production-agent-journal";
import type { AgentEvent } from "../src/services/api/agent";
const event = (seq: number, type: string, payload: Record<string, unknown> = {}): AgentEvent => ({ seq, type, payload, runId: "run", eventId: `event-${seq}`, createdAt: `2026-10-14T00:00:${String(seq).padStart(2, "0")}Z` });
describe("production execution journal", () => {
    test("overlapping pages and polls preserve ordered unique records", () => {
        expect(mergeProductionEvents([event(3, "tool_completed"), event(4, "run_failed")], [event(1, "production_progress"), event(3, "tool_completed")]).map((e) => e.seq)).toEqual([1, 3, 4]);
    });
    test("routine dispatches are hidden but failures and continuation remain", () => {
        const rows = productionJournalRows([event(1, "context_pressure", { requestId: "task" }), event(2, "production_model_started", { taskId: "task", step: 120 }), event(5, "production_model_completed", { taskId: "task", status: "succeeded" }), event(6, "tool_failed", { toolName: "production_facts", text: "第 2 项证据无效" }), event(7, "production_control", { text: "继续任务", maxSteps: 180 })]);
        expect(rows).toHaveLength(2);
        expect(rows[0].failed).toBe(true);
        expect(rows[1].detail).toContain("继续任务");
    });
    test("historical dispatches remain visible without exposing prompts or reasoning", () => {
        const rows = productionJournalRows([event(1, "context_pressure", { requestId: "old-task" }), event(2, "reasoning_message", { text: "hidden" }), event(3, "canvas_updated", { nodes: ["private"] }), event(4, "tool_completed", { toolName: "production_read", arguments: "source text", result: { text: "source text", pageId: "page1" } }), event(5, "run_failed", { error: "调用次数用尽" })]);
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows)).not.toContain("source text");
        expect(rows[0].detail).toBe("调用次数用尽");
    });
    test("commentary and tool receipts stay chronological; finalized text replaces streamed fragments", () => {
        const events = [event(1, "assistant_delta", { messageId: "m1", text: "正在" }), event(2, "assistant_delta", { messageId: "m1", text: "核对人物" })];
        expect(productionJournalRows(events).map((row) => row.detail)).toEqual(["正在核对人物"]);
        const rows = productionJournalRows([...events, event(3, "assistant_message", { messageId: "m1", text: "正在核对人物关系。" }), event(4, "production_progress", { text: "已保存正文事实 · 第3集" }), event(5, "assistant_message", { messageId: "m2", text: "已保存前三页事实，继续读取第四页。" }), event(6, "reasoning_delta", { text: "hidden" })]);
        expect(rows.map((row) => row.kind)).toEqual(["message", "status", "message"]);
        expect(rows.map((row) => row.id)).toEqual([3, 4, 5]);
        expect(rows[0].detail).toBe("正在核对人物关系。");
        expect(rows[1].detail).toContain("第3集");
        expect(JSON.stringify(rows)).not.toContain("hidden");
    });
    test("orphan completions and messages without identifiers survive history boundaries", () => {
        const rows = productionJournalRows([event(1, "production_model_completed", { taskId: "older", status: "failed", text: "上游响应中断" }), event(2, "assistant_message", { text: "第一段" }), event(3, "assistant_message", { text: "第二段" }), event(4, "context_pressure", { text: "context diagnostic only" })]);
        expect(rows).toHaveLength(3);
        expect(rows[0].failed).toBe(true);
        expect(rows.slice(1).map((row) => row.detail)).toEqual(["第一段", "第二段"]);
    });
    test("only the bound run is shown; repetitive read/check receipts are suppressed", () => {
        const rows = productionJournalRows([
            { ...event(1, "assistant_message", { text: "another task" }), runId: "other" },
            event(2, "tool_completed", { toolName: "production_query", result: { nextOffset: 12 } }),
            event(3, "tool_completed", { toolName: "production_check", result: { valid: false, issues: ["缺少人物"], missingCount: 1 } }),
            event(4, "tool_completed", { toolName: "production_check", result: { valid: false, issues: ["缺少人物"], missingCount: 1 } }),
            event(5, "production_progress", { nodeId: "asset", text: "已保存资产 · 林岚" }),
            event(6, "tool_completed", { toolName: "production_submit", result: { nodeId: "asset" } }),
            event(7, "tool_completed", { toolName: "production_check", result: { valid: true, artifactCount: 1 } }),
        ], "run");
        expect(rows.map((row) => row.id)).toEqual([3, 5, 7]);
        expect(rows[2].title).toBe("产物覆盖检查通过");
        expect(JSON.stringify(rows)).not.toContain("another task");
    });
});
