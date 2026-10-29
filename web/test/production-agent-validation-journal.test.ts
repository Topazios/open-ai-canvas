import { expect, test } from "bun:test";
import { productionJournalRows, productionRunWarningDiagnostic } from "../src/lib/canvas/production-agent-journal";
import type { AgentEvent } from "../src/services/api/agent";

const event = (seq: number, type: string, payload: Record<string, unknown>): AgentEvent => ({
    seq, type, payload, runId: "run", eventId: `event-${seq}`, createdAt: new Date(Date.UTC(2026, 9, 25, 0, 0, seq)).toISOString(),
});

function validation(seq: number, key: string, status: "retrying" | "recovered" | "exhausted") {
    return event(seq, "production_validation", {
        toolName: "production_submit", taskId: `${key}-${seq}`, callId: `parallel-${key}-${seq}`,
        assetKey: key, itemName: key === "visual" ? "视觉与美术规范" : "导演与视听规范",
        phase: "validation", errorSource: "application", errorClass: "schema_error",
        text: status === "recovered" ? "本地文稿校验已通过，内容已保存" : "document 含未声明字段",
        retry: { groupId: `run:parallel-validation:${key}`, attempt: 1, maxAttempts: 7, status, severity: status === "exhausted" ? "error" : "warning", terminal: status === "exhausted" },
        result: { reason: "invalid_tool_arguments", field: "document", issue: "unknown_fields", parameters: { private: "FULL_SCHEMA" } },
    });
}

test("successful execution and local correction remain distinct until the document recovers", () => {
    const input = [
        event(1, "production_model_started", { taskId: "visual-1", step: 7, itemName: "视觉与美术规范" }),
        event(2, "production_model_completed", { taskId: "visual-1", step: 7, itemName: "视觉与美术规范", status: "succeeded", text: "模型响应已收到，正在进行本地文稿校验" }),
        validation(3, "visual", "retrying"),
    ];
    const pending = productionJournalRows(input);
    expect(pending[0]).toMatchObject({ kind: "model", failed: false, pending: false });
    expect(pending[0].title).toContain("完成");
    expect(pending).toHaveLength(1);
    const recovered = productionJournalRows([...input, validation(4, "visual", "recovered")]);
    expect(recovered).toHaveLength(1);
    expect(JSON.stringify(recovered)).not.toContain("FULL_SCHEMA");
    expect(JSON.stringify(recovered)).not.toContain("未成功");
});

test("parallel document repairs cannot close or recover each other", () => {
    const rows = productionJournalRows([
        validation(1, "visual", "retrying"),
        validation(2, "direction", "retrying"),
        validation(3, "direction", "recovered"),
    ]);
    expect(rows).toHaveLength(0);
});

test("current-step gates stay internal while genuine upstream execution failures remain red", () => {
    const rows = productionJournalRows([
        event(1, "production_model_completed", { taskId: "local", status: "succeeded" }),
        validation(2, "visual", "retrying"),
        validation(3, "visual", "exhausted"),
        event(4, "production_control", { action: "needs_revision", severity: "warning", errorSource: "application", phase: "validation", outcome: "needs_revision", text: "当前制作项需要复核" }),
        event(5, "production_model_completed", { taskId: "network", status: "failed", errorSource: "upstream", severity: "error", text: "上游连接中断" }),
    ]);
    expect(rows[0].failed).toBe(false);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "model", failed: false });
    expect(rows[1]).toMatchObject({ kind: "model", failed: true });
    expect(rows[1].title).toContain("未成功");
    expect(rows[1].detail).toContain("上游连接中断");
});

test("structured content diagnostics warn without claiming model completion or hiding stopped work", () => {
    const rows = productionJournalRows([
        event(1, "production_model_started", { taskId: "limit" }),
        event(2, "production_model_completed", { taskId: "limit", status: "failed", severity: "warning", errorSource: "content", phase: "content", outcome: "incomplete", code: "output_limit_exceeded", text: "输出未完整返回" }),
        event(3, "model_failure_recovered", { taskId: "limit", severity: "warning", text: "转为分章继续" }),
        event(4, "run_failed", { severity: "warning", errorSource: "content", outcome: "not_saved", text: "当前文稿仍待补全" }),
        event(5, "production_model_completed", { taskId: "real", status: "failed", severity: "error", errorSource: "application", phase: "validation", text: "真实执行错误" }),
    ]);
    expect(rows[0]).toMatchObject({ failed: false, warning: true, pending: false });
    expect(rows[0].title).toContain("内容待处理");
    expect(rows[1]).toMatchObject({ warning: true, title: "已调整后续执行方式" });
    expect(rows[2]).toMatchObject({ failed: false, warning: true, title: "任务已停止 · 内容待处理" });
    expect(rows[3]).toMatchObject({ failed: true, warning: false });
});

test("overlapping event replay preserves one correction history and recovery", () => {
    const failed = validation(1, "visual", "retrying");
    const recovered = validation(2, "visual", "recovered");
    expect(productionJournalRows([recovered, failed, recovered, failed])).toEqual([]);
});

test("legacy schema receipts and their final current-step gate remain internal", () => {
    const events = [
        event(1, "tool_failed", { toolName: "production_submit", result: { errorClass: "schema_error", requiredAction: "fix_arguments", retry: { groupId: "legacy", attempt: 1, maxAttempts: 3, status: "retrying" } } }),
        event(2, "tool_completed", { toolName: "production_submit", result: { errorClass: "schema_error", requiredAction: "fix_arguments", retry: { groupId: "legacy", attempt: 1, maxAttempts: 3, status: "recovered" } } }),
        event(3, "production_control", { action: "needs_revision", severity: "warning", errorSource: "application", phase: "validation", outcome: "needs_revision", text: "当前制作项需要复核" }),
    ];
    expect(productionJournalRows(events)).toEqual([]);
    expect(productionRunWarningDiagnostic(events, "run")).toBeUndefined();
    expect(productionRunWarningDiagnostic([...events, event(4, "production_control", { action: "resume" })], "run")).toBeUndefined();
});

test("local validation classification does not depend on requiredAction or visible wording", () => {
    const events = [
        event(1, "tool_failed", { toolName: "facts", result: { errorClass: "schema_error", reason: "invalid_tool_arguments", validationIssues: [{ field: "facts[0].quote", issue: "invalid_source_quote" }] } }),
        event(2, "run_failed", { reason: "production_no_progress", severity: "warning", errorSource: "application", phase: "validation", outcome: "needs_revision", text: "legacy local stop" }),
    ];
    expect(productionJournalRows(events)).toEqual([]);
    expect(productionRunWarningDiagnostic(events, "run")).toBeUndefined();
});

test("current-step schema repairs stay out of the visible journal while upstream failures remain visible", () => {
    const local = (seq: number, status: "retrying" | "recovered" | "exhausted") => event(seq, "tool_failed", {
        taskId: "repair-1", toolName: "production_submit", errorSource: "application", phase: "validation",
        errorClass: "schema_error", requiredAction: "fix_arguments", severity: "warning",
        retry: { groupId: "run:repair", attempt: seq, maxAttempts: 3, status, severity: "warning", terminal: status === "exhausted" },
        result: { reason: "invalid_tool_arguments", validationIssues: [{ field: "document", issue: "missing", message: "缺少字段" }] },
    });
    const rows = productionJournalRows([
        event(1, "production_model_started", { taskId: "repair-1", step: 1 }),
        local(2, "retrying"),
        event(3, "assistant_message", { taskId: "repair-1", messageId: "repair-1", text: "我来修正文稿参数" }),
        local(4, "recovered"),
        event(5, "production_model_completed", { taskId: "repair-1", status: "succeeded" }),
        event(6, "tool_failed", { taskId: "network-1", toolName: "production_submit", errorSource: "network", errorClass: "network_error", text: "连接超时" }),
    ]);
    expect(rows.some(row => row.title.includes("自动纠正"))).toBe(false);
    expect(rows.some(row => row.detail.includes("我来修正文稿参数"))).toBe(false);
    expect(rows.some(row => row.detail.includes("连接超时"))).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/纠正|待处理|needs_revision/);
});
