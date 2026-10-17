import { expect, test } from "bun:test";
import { taskElapsed, taskExecutionRows } from "../src/lib/task-execution-journal";
import type { TaskExecutionDetails } from "../src/services/api/task-center";

const detail: TaskExecutionDetails = {
    task: { id: "parent", type: "canvas_text", operation: "short_drama_batch", status: "running", prompt: "", attempts: 1, createdAt: "2026-10-17T00:00:00Z", startedAt: "2026-10-17T00:10:00Z", updatedAt: "2026-10-17T00:11:00Z", stage: "分批提取 2/52" },
    steps: [{ id: "child", label: "材料 1/52", status: "succeeded", createdAt: "2026-10-17T00:10:00Z", startedAt: "2026-10-17T00:10:30Z", completedAt: "2026-10-17T00:11:00Z", outputChars: 4, outputPreview: "实际结果" }],
    unitCount: 52, truncated: false, parameters: {}, events: [],
};
test("separates queue and model time and shows actual child progress", () => {
    const rows = taskExecutionRows(detail, Date.parse("2026-10-17T00:12:00Z"));
    expect(rows[0].detail).toContain("10分0秒");
    const child = rows.find((row) => row.id === "child")!;
    expect(child.detail).toContain("排队等待 30秒");
    expect(child.detail).toContain("执行耗时 30秒");
    expect(child.detail).toContain("实际结果");
    expect(rows.find((row) => row.pending)?.title).toContain("2/52");
});
test("terminal tasks stop accruing time and absent timestamps are honest", () => {
    const terminal = { ...detail, task: { ...detail.task, status: "cancelled" as const, startedAt: undefined } };
    expect(taskExecutionRows(terminal, Date.parse("2027-01-01"))[0].detail).toContain("11分0秒");
    expect(taskExecutionRows(terminal).some((row) => row.id === "parent:current")).toBe(false);
    expect(taskElapsed(undefined)).toBe("未记录");
});
test("empty or failed children do not claim successful output", () => {
    const next = structuredClone(detail); next.steps[0] = { ...next.steps[0], status: "failed", outputChars: 0, outputPreview: "", error: "上游中断" };
    const row = taskExecutionRows(next).find((row) => row.id === "child")!;
    expect(row.failed).toBe(true); expect(row.detail).toContain("上游中断"); expect(row.detail).not.toContain("已保存");
});

test("workflow retries keep initial queue separate from elapsed workflow time", () => {
    const next = { ...detail, firstStartedAt: "2026-10-17T00:00:01Z", task: { ...detail.task, startedAt: "2026-10-17T00:55:00Z" } };
    const rows = taskExecutionRows(next, Date.parse("2026-10-17T00:55:10Z"));
    expect(rows[0].detail).toBe("排队等待 1秒");
    expect(rows.find((row) => row.id === "parent:current")?.detail).toContain("流程历时（含重试间隔） 55分9秒");
});
