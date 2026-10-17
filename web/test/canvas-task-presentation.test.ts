import { describe, expect, test } from "bun:test";
import { canvasTaskCounts, canvasTaskPresentation, taskPresentationContext } from "../src/lib/canvas/canvas-task-presentation";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { GenerationTask } from "../src/services/api/task-center";

const root: GenerationTask = { id: "parent", projectId: "project", type: "canvas_text", operation: "short_drama_batch", prompt: "internal instructions", status: "running", attempts: 1, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:01:00Z", clientContext: { nodeId: "outline", workflowStepId: "story.episodes" } };
const node: CanvasNodeData = { id: "outline", type: CanvasNodeType.Text, title: "分集集纲 · 第 1 版", x: 0, y: 0, width: 300, height: 200, metadata: { taskId: "parent" } };
const child = (key = "merge-1-0"): GenerationTask => ({ ...root, id: key, operation: "text", stage: "调用生成模型", clientContext: { parentTaskId: root.id, batchKey: key } });

describe("canvas task identity", () => {
    test("parallel calls show their own round and batch with a shared owning node", () => {
        for (let index = 0; index < 3; index++) {
            const view = canvasTaskPresentation(child(`merge-1-${index}`), [root], [node]);
            expect(view).toMatchObject({ title: node.title, work: `跨集归并 · 第 2 轮 · 第 ${index + 1} 批`, nodeId: node.id, parentTaskId: root.id });
            expect(view.source).toBe("");
        }
        expect(canvasTaskCounts([root, child(), child("merge-1-1"), { ...child("merge-1-2"), status: "queued" }])).toEqual({ roots: 1, children: 3, running: 3, queued: 1 });
    });
    test("node renames and missing parent rows still resolve the real owner", () => {
        expect(canvasTaskPresentation(child(), [], [{ ...node, title: "新集纲" }])).toMatchObject({ title: "新集纲", nodeId: "outline" });
        expect(canvasTaskPresentation(root, [root], [node]).work).toBe("总任务 · 汇总分批结果");
    });
    test("poll details and list summaries agree without binding child output to a node", () => {
        const polled = { ...child(), clientContext: undefined, inputJson: JSON.stringify({ metadata: { source: "canvas-workflow-batch-child", parentTaskId: "parent", batchKey: "merge-1-0", nodeId: "bad" } }) };
        expect(taskPresentationContext(polled).nodeId).toBeUndefined();
        expect(canvasTaskPresentation(polled, [root], [node])).toEqual(canvasTaskPresentation(child(), [root], [node]));
    });
    test("source title is shown without dumping instructions", () => {
        const task = child("map-3"); task.clientContext!.sourceLabel = "第 4 集 · 雨夜";
        expect(canvasTaskPresentation(task, [root], [node])).toMatchObject({ work: "材料提取 · 第 4 批", source: "第 4 集 · 雨夜" });
        expect(canvasTaskPresentation(child("shared-facts-v1"), [], []).work).toBe("共享正文解析");
    });
    test("ordinary media and malformed legacy data have readable fallbacks", () => {
        const image = { ...root, id: "image", operation: "image", type: "canvas_image", prompt: "人物正面肖像", inputJson: "broken", clientContext: undefined };
        expect(canvasTaskPresentation(image)).toMatchObject({ title: "画布生图", source: "人物正面肖像" });
        expect(canvasTaskPresentation(image, [], [{ ...node, id: "portrait", title: "角色 A · 定妆照", metadata: { taskId: "image" } }])).toMatchObject({ title: "角色 A · 定妆照", nodeId: "portrait" });
        expect(canvasTaskPresentation(child("unknown"))).toMatchObject({ title: "分批制作任务", work: "分批处理", source: "" });
    });
});
