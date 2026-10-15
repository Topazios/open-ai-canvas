import { expect, test } from "bun:test";
import { resetInterruptedGeneration } from "../src/lib/canvas/canvas-project-generation";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

test("restoring a production node preserves its admission failure and request", () => {
    const node: CanvasNodeData = { id: "production", type: CanvasNodeType.Text, title: "制作任务", position: { x: 0, y: 0 }, width: 400, height: 280, createdAt: "2026-10-14", updatedAt: "2026-10-14", metadata: { status: "loading", errorDetails: "提交结果待确认", shortDrama: { version: 1, pipelineId: "pipeline", stage: "assets", step: "assets.characters", role: "document", sourceNodeIds: [], sourceSignatures: {}, productionAgent: { maxCredits: 200, maxSteps: 120 } } } };
    const ordinary = { ...node, id: "ordinary", metadata: { status: "loading" as const } };
    const restored = resetInterruptedGeneration([node, ordinary]);
    expect(restored[0]).toBe(node);
    expect(restored[0].metadata?.errorDetails).toBe("提交结果待确认");
    expect(restored[1].metadata?.errorDetails).toBe("正在从任务中心恢复生成状态...");
});
