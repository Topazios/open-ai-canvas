import { expect, test } from "bun:test";
import { taskElapsed, taskExecutionRows } from "../src/lib/task-execution-journal";
import type { TaskExecutionDetails } from "../src/services/api/task-center";
import { generationTaskStatusLabel } from "../src/lib/generation-task-display";

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

test("quality review remains visible in individual and shared group journals", () => {
    const rows = taskExecutionRows({ ...detail, qualityWarnings: ["戏剧正文展开不足", "节拍时长待核对"] });
    const quality = rows.find(row => row.id === "parent:quality")!;
    expect(quality.title).toBe("正文完成度需复核");
    expect(quality.detail).toContain("戏剧正文展开不足");
    expect(quality.detail).toContain("节拍时长待核对");
    expect(quality.failed).toBe(false);
    expect(quality.warning).toBe(true);
});

test("content diagnostics remain warnings for failed child and terminal scheduling receipts", () => {
    const next = structuredClone(detail);
    const diagnostic = { severity: "warning" as const, errorSource: "content", phase: "postprocess", outcome: "not_saved", code: "output_limit_exceeded" };
    next.task = { ...next.task, status: "failed", diagnostic };
    next.steps[0] = { ...next.steps[0], status: "failed", diagnostic, error: "内容仍待补全" };
    const rows = taskExecutionRows(next);
    expect(rows.find(row => row.id === "child")).toMatchObject({ warning: true, failed: false });
    expect(rows.find(row => row.id === "parent:terminal")).toMatchObject({ title: "任务已停止 · 内容待处理", warning: true, failed: false });
    expect(next.task.status).toBe("failed");
});

test("recovered tasks keep their current status when old postprocess warnings remain in diagnostics", () => {
    const diagnostic = { severity: "warning" as const, phase: "postprocess", errorSource: "application", outcome: "not_saved" };
    for (const status of ["queued", "running", "succeeded", "cancelled"] as const) {
        const next = structuredClone(detail);
        next.task = { ...next.task, status, diagnostic };
        next.steps[0] = { ...next.steps[0], status, diagnostic };
        const rows = taskExecutionRows(next);
        expect(rows.some(row => row.warning)).toBe(false);
        expect(generationTaskStatusLabel(next.task)).not.toBe("内容待处理");
        expect(rows.some(row => row.title.includes("任务已停止 · 内容待处理"))).toBe(false);
    }
});

test("real child failures never inherit the parent's content warning diagnosis", () => {
    const next = structuredClone(detail);
    next.task = { ...next.task, status: "failed", diagnostic: { severity: "warning", errorSource: "content" } };
    next.steps[0] = { ...next.steps[0], status: "failed", error: "上游断流" };
    const child = taskExecutionRows(next).find(row => row.id === "child")!;
    expect(child).toMatchObject({ failed: true, warning: false });
    expect(child.title).toContain("失败");
    expect(child.title).not.toContain("内容待处理");
});
