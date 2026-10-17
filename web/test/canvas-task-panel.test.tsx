import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasActiveTaskCard, CanvasActiveTaskPanel } from "../src/components/canvas/canvas-active-task-panel";
import { canvasThemes } from "../src/lib/canvas-theme";
import { canvasTaskPresentation } from "../src/lib/canvas/canvas-task-presentation";
import type { GenerationTask } from "../src/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const task: GenerationTask = { id: "batch-call-1", projectId: "p", type: "canvas_text", operation: "text", status: "running", stage: "调用生成模型", prompt: "internal instructions", model: "text-model", attempts: 1, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:01:00Z", clientContext: { parentTaskId: "parent", batchKey: "merge-1-0" } };
const node: CanvasNodeData = { id: "outline", title: "分集集纲 · 第 1 版", type: CanvasNodeType.Text, x: 0, y: 0, width: 300, height: 200, metadata: { taskId: "parent" } };

test("real task card exposes meaningful work without expanding or dumping prompts", () => {
    const presentation = canvasTaskPresentation(task, [], [node]);
    const render = (expanded: boolean) => renderToStaticMarkup(<CanvasActiveTaskCard task={task} presentation={presentation} theme={Object.values(canvasThemes)[0]} now={Date.parse(task.updatedAt)} expanded={expanded} onToggle={() => {}} onOpenNode={() => {}} creditsEnabled reducedMotion />);
    const compact = render(false);
    for (const text of [node.title, "跨集归并 · 第 2 轮 · 第 1 批", "作品创作中"]) expect(compact).toContain(text);
    expect(compact).not.toContain("internal instructions");
    expect(compact).not.toContain("未计费");
    const expanded = render(true);
    for (const text of ["查看所属节点详情", "text-model", task.id]) expect(expanded).toContain(text);
});

test("panel counts main work separately from calls and omits itself when idle", () => {
    const parent = { ...task, id: "parent", operation: "short_drama_batch", clientContext: { nodeId: "outline" } };
    const html = renderToStaticMarkup(<CanvasActiveTaskPanel tasks={[parent, task]} nodes={[node]} />);
    expect(html).toContain("1 项制作");
    expect(html).toContain("1 个子任务");
    expect(renderToStaticMarkup(<CanvasActiveTaskPanel tasks={[]} />)).toBe("");
});
