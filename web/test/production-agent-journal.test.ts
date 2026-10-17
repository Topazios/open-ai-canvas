import { describe, test, expect } from "bun:test";
import { mergeProductionEvents, productionJournalRows } from "../src/lib/canvas/production-agent-journal";
import type { AgentEvent } from "../src/services/api/agent";
const event = (seq: number, type: string, payload: Record<string, unknown> = {}): AgentEvent => ({ seq, type, payload, runId: "run", eventId: `event-${seq}`, createdAt: new Date(Date.UTC(2026, 9, 14, 0, 0, seq)).toISOString() });
describe("production execution journal", () => {
    test("concurrent completions update only their own model row", () => {
        const rows = productionJournalRows([
            event(1, "production_model_started", { taskId: "character", step: 1, itemName: "人物" }),
            event(2, "production_model_started", { taskId: "environment", step: 2, itemName: "场景" }),
            event(3, "production_model_started", { taskId: "prop", step: 3, itemName: "道具" }),
            event(4, "production_model_completed", { taskId: "environment", step: 2, itemName: "场景", status: "succeeded" }),
            event(5, "production_model_completed", { taskId: "character", step: 1, itemName: "人物", status: "failed", text: "字段待补充" }),
        ]);
        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatchObject({ failed: true, pending: false });
        expect(rows[0].title).toContain("人物");
        expect(rows[1]).toMatchObject({ failed: false, pending: false });
        expect(rows[1].title).toContain("场景");
        expect(rows[2].pending).toBe(true);
    });
    test("overlapping pages and polls preserve ordered unique records", () => {
        expect(mergeProductionEvents([event(3, "tool_completed"), event(4, "run_failed")], [event(1, "production_progress"), event(3, "tool_completed")]).map((e) => e.seq)).toEqual([1, 3, 4]);
    });
    test("one model call retains completion timing alongside failures and continuation", () => {
        const rows = productionJournalRows([event(1, "context_pressure", { requestId: "task" }), event(2, "production_model_started", { taskId: "task", step: 120 }), event(5, "production_model_completed", { taskId: "task", status: "succeeded" }), event(6, "tool_failed", { toolName: "production_facts", text: "第 2 项证据无效" }), event(7, "production_control", { text: "继续任务", maxSteps: 180 })]);
        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatchObject({ kind: "model", pending: false, failed: false });
        expect(rows[0].title).toBe("模型调用 · 第 120 次 · 完成 · 总等待 3.0 秒");
        expect(rows[1].failed).toBe(true);
        expect(rows[2].detail).toContain("继续任务");
    });
    test("historical dispatches remain visible without exposing prompts or reasoning", () => {
        const rows = productionJournalRows([event(1, "context_pressure", { requestId: "old-task" }), event(2, "reasoning_message", { text: "hidden" }), event(3, "canvas_updated", { nodes: ["private"] }), event(4, "tool_completed", { toolName: "production_read", arguments: "source text", result: { text: "source text", pageId: "page1" } }), event(5, "run_failed", { error: "调用次数用尽" })]);
        expect(rows).toHaveLength(2);
        expect(JSON.stringify(rows)).not.toContain("source text");
        expect(rows[0]).toMatchObject({ kind: "model", pending: true, detail: "old-task" });
        expect(rows[1].detail).toBe("调用次数用尽");
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

    test("forty successful calls with no artifacts retain every call and distinct commentary", () => {
        const events = Array.from({ length: 40 }, (_, index) => {
            const seq = index * 5 + 1;
            const taskId = `task-${index}`;
            return [
                event(seq, "production_model_started", { taskId, step: index + 1 }),
                event(seq + 1, "production_model_completed", { taskId, status: "succeeded", queueMs: 1200, executionMs: 2300 }),
                event(seq + 2, "assistant_message", { messageId: taskId, text: index % 2 ? "我会先读取已采用选题，再核对制作进度。" : "我会先读取已采用选题，再整理故事总纲。" }),
                event(seq + 3, "tool_completed", { toolName: "production_read", result: { pageId: "topic" } }),
                event(seq + 4, "tool_completed", { toolName: "production_status", result: { artifactCount: 0 } }),
            ];
        }).flat();
        const rows = productionJournalRows([...events, event(201, "production_control", { text: "暂停任务" })]);
        expect(rows.filter((row) => row.kind === "model")).toHaveLength(40);
        expect(rows.filter((row) => row.kind === "message")).toHaveLength(40);
        expect(rows[0].title).toBe("模型调用 · 第 1 次 · 完成 · 执行 2.3 秒");
        expect(rows[0].detail).toContain("排队 1.2 秒 · 执行 2.3 秒 · task-0");
        expect(rows.at(-1)?.detail).toBe("暂停任务");
        expect(rows.some((row) => row.title.includes("已保存"))).toBe(false);
    });

    test("stable event and task receipts remove bridge replays without inventing model calls", () => {
        const delta = event(3, "assistant_delta", { messageId: "task", text: "正在读取" });
        const rows = productionJournalRows([
            event(1, "context_pressure", { requestId: "task" }),
            event(2, "production_model_started", { taskId: "task", step: 1 }),
            delta,
            { ...delta, seq: 4 },
            event(5, "production_model_started", { taskId: "task", step: 1 }),
            event(6, "production_model_completed", { taskId: "task", status: "succeeded", executionMs: 2000 }),
            event(7, "assistant_message", { messageId: "task", text: "已读取来源，缺少人物年龄。" }),
            event(8, "production_model_completed", { taskId: "task", status: "succeeded", executionMs: 2000 }),
            event(9, "assistant_message", { taskId: "task", text: "已读取来源，缺少人物年龄。" }),
        ]);
        expect(rows.map((row) => row.kind)).toEqual(["model", "message"]);
        expect(rows.map((row) => row.id)).toEqual([2, 7]);
        expect(rows[0].pending).toBe(false);
        expect(rows[1].detail).toBe("已读取来源，缺少人物年龄。");
    });

    test("stream replay uses event identity, while identical chunks at different offsets survive", () => {
        const first = event(1, "assistant_delta", { messageId: "task", text: "哈" });
        const second = event(2, "assistant_delta", { messageId: "task", text: "哈" });
        expect(productionJournalRows([second, first, first, { ...second, seq: 3 }]).map((row) => row.detail)).toEqual(["哈哈"]);
    });

    test("snapshots replace drafts and final receipts replace all partial text across pages", () => {
        const partial = [
            event(1, "assistant_delta", { messageId: "task", text: "旧草稿" }),
            event(2, "assistant_snapshot", { messageId: "task", text: "已核对", replace: true }),
            event(3, "assistant_delta", { messageId: "task", text: "来源" }),
        ];
        expect(productionJournalRows(partial).map((row) => row.detail)).toEqual(["已核对来源"]);
        const final = event(4, "assistant_message", { messageId: "task", text: "已核对来源，缺少时间线。" });
        const combined = mergeProductionEvents([final], partial);
        expect(productionJournalRows(combined)).toEqual(productionJournalRows([final]));
        expect(productionJournalRows([...partial, event(4, "assistant_message", { messageId: "task", text: "" })])[0].detail).toBe("已核对来源");
        expect(productionJournalRows([...partial, event(4, "assistant_snapshot", { messageId: "task", text: "" })])).toEqual([]);
    });

    test("different substantive finals and distinct message IDs in the same task are preserved", () => {
        const rows = productionJournalRows([
            event(1, "assistant_message", { messageId: "task", text: "缺少人物年龄。" }),
            event(2, "assistant_message", { messageId: "task", text: "缺少人物年龄及时间线。" }),
            event(3, "assistant_message", { messageId: "task", text: "缺少人物年龄。" }),
            event(4, "assistant_message", { taskId: "task", messageId: "other-message", text: "缺少人物年龄。" }),
            event(5, "assistant_message", { text: "缺少人物年龄。" }),
            event(6, "assistant_message", { text: "缺少人物年龄。" }),
        ]);
        expect(rows.map((row) => row.id)).toEqual([1, 2, 4, 5, 6]);
        expect(rows[1].detail).toBe("缺少人物年龄及时间线。");
    });

    test("failed retries, orphan successes and pending calls remain distinct", () => {
        const rows = productionJournalRows([
            event(1, "production_model_completed", { taskId: "older", status: "succeeded", executionMs: 3500 }),
            event(2, "production_model_started", { taskId: "failed", step: 2 }),
            event(3, "production_model_completed", { taskId: "failed", status: "failed", text: "上游超时", executionMs: 10000 }),
            event(4, "production_model_started", { taskId: "retry", step: 3 }),
            event(5, "production_model_completed", { taskId: "retry", status: "succeeded", executionMs: 1000 }),
            event(6, "production_model_started", { taskId: "pending", step: 4 }),
            event(7, "tool_failed", { toolName: "production_read" }),
            event(8, "run_failed", { reason: "production_no_progress", text: "制作进度未变化" }),
        ]);
        expect(rows.map((row) => row.id)).toEqual([1, 2, 4, 6, 7, 8]);
        expect(rows[0].title).toContain("执行 3.5 秒");
        expect(rows[1]).toMatchObject({ failed: true, pending: false });
        expect(rows[1].detail).toContain("上游超时");
        expect(rows[2]).toMatchObject({ failed: false, pending: false });
        expect(rows[3]).toMatchObject({ failed: false, pending: true, detail: "pending" });
        expect(rows[3].title).toContain("等待响应");
        expect(rows[4].failed).toBe(true);
        expect(rows[5]).toMatchObject({ failed: true, detail: "制作进度未变化" });
    });

    test("conflicting terminal receipts never overwrite a recorded failure", () => {
        const rows = productionJournalRows([
            event(1, "production_model_started", { taskId: "task" }),
            event(2, "production_model_completed", { taskId: "task", status: "failed", error: "response interrupted" }),
            event(3, "production_model_completed", { taskId: "task", status: "succeeded" }),
        ]);
        expect(rows).toHaveLength(2);
        expect(rows[0].failed).toBe(true);
        expect(rows[0].detail).toContain("response interrupted");
        expect(rows[1].failed).toBe(false);
    });

    test("run scope separates overlapping sequences and identical provenance", () => {
        const events = [
            event(1, "production_model_started", { taskId: "task", step: 1 }),
            event(2, "assistant_message", { messageId: "task", text: "正在核对" }),
            event(3, "tool_completed", { toolName: "production_check", result: { valid: false, issues: ["缺少人物"] } }),
        ];
        const other = events.map((entry) => ({ ...entry, runId: "other" }));
        const merged = mergeProductionEvents(events, other);
        expect(merged).toHaveLength(6);
        expect(productionJournalRows(merged)).toHaveLength(6);
        expect(productionJournalRows(merged, "run")).toEqual(productionJournalRows(events));
    });

    test("a progress receipt without a node cannot hide an unmatched submit result", () => {
        const rows = productionJournalRows([
            event(1, "production_progress", { text: "已读取来源" }),
            event(2, "tool_completed", { toolName: "production_submit", text: "已保存总纲", result: { artifactCount: 1 } }),
        ]);
        expect(rows.map((row) => row.id)).toEqual([1, 2]);
    });
});
