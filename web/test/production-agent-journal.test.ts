import { describe, test, expect } from "bun:test";
import { mergeProductionEvents, productionJournalRows, productionParallelSummary } from "../src/lib/canvas/production-agent-journal";
import type { AgentEvent } from "../src/services/api/agent";
const event = (seq: number, type: string, payload: Record<string, unknown> = {}): AgentEvent => ({ seq, type, payload, runId: "run", eventId: `event-${seq}`, createdAt: new Date(Date.UTC(2026, 9, 14, 0, 0, seq)).toISOString() });
describe("production execution journal", () => {
    const repair = (status: "retrying" | "recovered" | "exhausted", groupId = "plan-repair") => ({ groupId, attempt: 1, maxAttempts: 3, status });
    test("legacy storyboard validation receipts stay internal to the current item", () => {
        const failed = event(1, "tool_failed", { toolName: "production_storyboard_plan", text: "参数结构异常", result: { reason: "invalid_tool_arguments", field: "parameters.scenes[0]", errorClass: "schema_error", guidance: "请按 parameters 修正", parameters: { private: "SCHEMA" }, retry: repair("retrying") } });
        const waiting = productionJournalRows([failed]);
        expect(waiting).toEqual([]);
        const rows = productionJournalRows([failed, event(2, "tool_completed", { toolName: "production_storyboard_plan", retry: repair("recovered"), result: { saved: true } })]);
        expect(rows).toEqual([]);
        expect(JSON.stringify(rows)).not.toContain("SCHEMA");
    });
    test("legacy production repair groups do not leak correction operations", () => {
        const input = [
            event(1, "tool_failed", { toolName: "production_storyboard_plan", retry: repair("retrying") }),
            { ...event(2, "tool_failed", { toolName: "production_storyboard_plan", retry: repair("retrying") }), runId: "other" },
            event(3, "tool_completed", { toolName: "production_storyboard_plan", retry: repair("recovered") }),
        ];
        expect(productionJournalRows(input)).toEqual([]);
        const exhausted = productionJournalRows([...input, { ...event(4, "tool_failed", { toolName: "production_storyboard_plan", retry: repair("exhausted") }), runId: "other" }]);
        expect(exhausted).toEqual([]);
    });
    test("a stopped run shows only the actual terminal event", () => {
        const rows = productionJournalRows([
            event(1, "tool_failed", { toolName: "production_storyboard_plan", retry: repair("retrying") }),
            event(2, "run_failed", { text: "上游响应中断" }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ title: "任务停止", detail: "上游响应中断", pending: false, failed: true });
    });
    test("changed invalid parameters remain internal across retry groups", () => {
        const rows = productionJournalRows([
            event(1, "tool_failed", { toolName: "production_storyboard_plan", retry: repair("retrying", "old") }),
            event(2, "tool_failed", { toolName: "production_storyboard_plan", retry: repair("retrying", "new") }),
            event(3, "tool_completed", { toolName: "production_storyboard_plan", retry: repair("recovered", "new") }),
        ]);
        expect(rows).toEqual([]);
    });
    test("resume keeps only checkpoint control records after internal validation", () => {
        const rows = productionJournalRows([
            event(1, "tool_failed", { toolName: "production_storyboard_plan", retry: repair("retrying") }),
            event(2, "production_control", { action: "pause", text: "等待当前响应后暂停" }),
            event(3, "production_control", { action: "resume", text: "继续任务" }),
            event(4, "tool_completed", { toolName: "production_storyboard_plan" }),
        ]);
        expect(rows.map((row) => row.detail)).toEqual(["等待当前响应后暂停", "继续任务"]);
        expect(JSON.stringify(rows)).not.toContain("纠正");
    });
    test("parallel summary distinguishes workers from queued task receipts", () => {
        const summary = productionParallelSummary({ targetNodeId: "node", paused: false, waitingForBoundary: false, processedPages: 0, totalPages: 1, artifactCount: 0, validated: false, concurrencyLimit: 3, parallelItems: [{ key: "one", name: "镜头一", status: "running" }, { key: "two", name: "镜头二", status: "queued" }, { key: "three", name: "镜头三", status: "succeeded" }] });
        expect(summary).toContain("执行 1 · 排队 1 · 待保存 1");
        expect(summary).toContain("全局 Agent 并发上限 3");
        expect(summary).toContain("镜头二（排队）");
        expect(productionParallelSummary()).toBe("");
    });
    test("episode summary shows batch and actual worker state without child tasks", () => {
        const progress = { targetNodeId: "node", paused: false, waitingForBoundary: false, processedPages: 0, totalPages: 1, artifactCount: 0, validated: false, executionMode: "episode" as const, episodeTaskStatus: "queued", phaseLabel: "连续补全镜头", currentItem: "S1-001 ~ S1-003", concurrencyLimit: 3 };
        expect(productionParallelSummary(progress)).toBe("连续补全镜头 · S1-001 ~ S1-003 · 等待全局并发名额 · 全局 Agent 并发上限 3");
        expect(productionParallelSummary({ ...progress, episodeTaskStatus: "running" })).toContain("正在执行");
        expect(productionParallelSummary({ ...progress, paused: true })).toContain("本集已暂停");
        expect(productionParallelSummary({ ...progress, paused: true, waitingForBoundary: true })).toContain("当前响应完成后暂停");
        expect(productionParallelSummary({ ...progress, episodeTaskStatus: "missing" })).toContain("正在核对状态");
        expect(productionParallelSummary({ ...progress, validated: true })).toBe("本集完整分镜校验通过");
    });
    test("legacy production validation errors stay internal without exposing tool schemas", () => {
        const rows = productionJournalRows([event(1, "tool_failed", { toolName: "production_facts", text: "工具执行失败，请检查输入或稍后重试", result: { errorClass: "schema_error", issue: "invalid_evidence", guidance: "请从本集原文复制证据后修正", parameters: { private: "FULL_SCHEMA" } } })]);
        expect(rows).toEqual([]);
        expect(JSON.stringify(rows)).not.toContain("FULL_SCHEMA");
    });
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
    test("production details can hide model prose while keeping execution receipts", () => {
        const rows = productionJournalRows([
            event(1, "assistant_message", { messageId: "m1", text: "完整故事正文不应出现在任务详情" }),
            event(2, "production_model_started", { taskId: "task", step: 1 }),
            event(3, "production_model_completed", { taskId: "task", status: "succeeded", executionMs: 1000 }),
            event(4, "production_progress", { text: "已保存故事总纲" }),
            event(5, "tool_completed", { toolName: "production_submit", result: { nodeId: "story" } }),
        ], "run", { hideAssistantMessages: true });
        expect(rows.map((row) => row.kind)).toEqual(["model", "status", "tool"]);
        expect(JSON.stringify(rows)).not.toContain("完整故事正文");
        expect(rows[1].detail).toBe("已保存故事总纲");
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
        expect(rows.map((row) => row.id)).toEqual([5, 7]);
        expect(rows[1].title).toBe("产物覆盖检查通过");
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
        expect(rows.map((row) => row.id)).toEqual([1, 2, 4, 6, 7]);
        expect(rows[0].title).toContain("执行 3.5 秒");
        expect(rows[1]).toMatchObject({ failed: true, pending: false });
        expect(rows[1].detail).toContain("上游超时");
        expect(rows[2]).toMatchObject({ failed: false, pending: false });
        expect(rows[3]).toMatchObject({ failed: false, pending: true, detail: "pending" });
        expect(rows[3].title).toContain("等待响应");
        expect(rows[4].failed).toBe(true);
        expect(JSON.stringify(rows)).not.toContain("制作进度未变化");
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
        expect(productionJournalRows(merged)).toHaveLength(4);
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
