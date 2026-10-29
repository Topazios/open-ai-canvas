import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasActiveAgentCard, CanvasActiveTaskPanel } from "@/components/canvas/canvas-active-task-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import type { AgentRun } from "@/services/api/agent";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const node = { id: "plan", type: CanvasNodeType.Text, title: "项目制作方案", metadata: { shortDrama: { productionAgent: { runId: "run" } } } } as CanvasNodeData;
const run: AgentRun = { id: "run", canvasId: "canvas", status: "running", permissionMode: "auto", createdAt: "2026-10-24T00:00:00Z", updatedAt: "2026-10-24T00:00:01Z", production: {
    targetNodeId: node.id, workKind: "plan", paused: false, waitingForBoundary: false, processedPages: 1, totalPages: 1, artifactCount: 2, validated: false,
    documentCount: 2, documentTotal: 5, concurrentItems: ["视觉与美术规范", "导演与视听规范"], parallelItems: [{ key: "visual", name: "视觉与美术规范", status: "running" }, { key: "direction", name: "导演与视听规范", status: "retrying" }],
} };

test("Agent planning appears in the task panel without an ordinary generation task", () => {
    const markup = renderToStaticMarkup(<CanvasActiveTaskPanel tasks={[]} nodes={[node]} agentRuns={[run]} />);
    expect(markup).toContain("生成任务");
    expect(markup).toContain("1 项制作");
    for (const status of ["completed", "failed", "cancelled", "rejected"] as const) {
        expect(renderToStaticMarkup(<CanvasActiveTaskPanel tasks={[]} nodes={[node]} agentRuns={[{ ...run, status }]} />)).toBe("");
    }
    expect(renderToStaticMarkup(<CanvasActiveTaskPanel tasks={[]} nodes={[]} agentRuns={[run]} />)).toBe("");
});

test("Agent task details expose real work, parallel states and saved document counts", () => {
    const markup = renderToStaticMarkup(<CanvasActiveAgentCard run={run} nodes={[node]} theme={canvasThemes.dark} onOpenNode={() => {}} />);
    for (const text of ["项目制作方案", "视觉与美术规范", "导演与视听规范", "文稿 2/5", "生成中", "查看执行详情"]) expect(markup).toContain(text);
    expect(markup).not.toContain("纠正");
    const paused = renderToStaticMarkup(<CanvasActiveAgentCard run={{ ...run, production: { ...run.production!, paused: true } }} nodes={[node]} theme={canvasThemes.dark} />);
    expect(paused).toContain("已暂停");
});

test("active agent cards distinguish content warnings from genuine item failures", () => {
    const html = renderToStaticMarkup(<CanvasActiveAgentCard run={{ ...run, production: { ...run.production!, parallelItems: [{ key: "content", name: "待补文稿", status: "failed", severity: "warning" }, { key: "upstream", name: "上游故障", status: "failed", severity: "error" }] } }} nodes={[node]} theme={canvasThemes.dark} />);
    expect(html).toContain("待处理");
    expect(html).toContain("调用失败");
    expect(html).toContain("var(--status-warning)");
    expect(html).toContain("var(--status-error)");
});
