import { describe, expect, test } from "bun:test";

import { bindGenerationTaskToNode, generationTaskMetadata, isTaskHeartbeatOnly } from "@/lib/canvas/canvas-project-generation";
import type { GenerationTask } from "@/services/api/task-center";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function task(overrides: Partial<GenerationTask> = {}): GenerationTask {
    return {
        id: "task-1",
        type: "canvas_image",
        status: "running",
        prompt: "提示词",
        attempts: 1,
        progress: 40,
        stage: "generating",
        createdAt: "2026-10-31T00:00:00Z",
        updatedAt: "2026-10-31T00:00:15Z",
        ...overrides,
    } as GenerationTask;
}

function baseNode(): CanvasNodeData {
    return { id: "n1", type: CanvasNodeType.Image, title: "节点", position: { x: 0, y: 0 }, width: 320, height: 180, metadata: { prompt: "提示词" } };
}

describe("bindGenerationTaskToNode", () => {
    test("first bind writes task metadata and loading status", () => {
        const original = baseNode();
        const next = bindGenerationTaskToNode(original, task());
        expect(next).not.toBe(original);
        expect(next.metadata?.taskId).toBe("task-1");
        expect(next.metadata?.status).toBe("loading");
        expect(next.metadata?.taskUpdatedAt).toBe("2026-10-31T00:00:15Z");
    });

    test("heartbeat that only changes updatedAt keeps the node reference", () => {
        const bound = bindGenerationTaskToNode(baseNode(), task());
        const next = bindGenerationTaskToNode(bound, task({ updatedAt: "2026-10-31T00:00:30Z" }));
        expect(next).toBe(bound);
    });

    test("progress or stage change updates the node", () => {
        const bound = bindGenerationTaskToNode(baseNode(), task());
        expect(bindGenerationTaskToNode(bound, task({ progress: 60 }))).not.toBe(bound);
        expect(bindGenerationTaskToNode(bound, task({ stage: "saving" })).metadata?.taskStage).toBe("saving");
    });

    test("failure writes error status and failure fields", () => {
        const bound = bindGenerationTaskToNode(baseNode(), task());
        const next = bindGenerationTaskToNode(bound, task({ status: "failed", error: "上游失败" }));
        expect(next).not.toBe(bound);
        expect(next.metadata?.status).toBe("error");
        expect(next.metadata?.errorDetails).toBeTruthy();
    });

    test("a different task id rebinds", () => {
        const bound = bindGenerationTaskToNode(baseNode(), task());
        const next = bindGenerationTaskToNode(bound, task({ id: "task-2" }));
        expect(next.metadata?.taskId).toBe("task-2");
    });

    test("terminal state always writes", () => {
        const bound = bindGenerationTaskToNode(baseNode(), task());
        const next = bindGenerationTaskToNode(bound, task({ status: "succeeded", progress: 100, completedAt: "2026-10-31T00:01:00Z" }));
        expect(next).not.toBe(bound);
        expect(next.metadata?.taskStatus).toBe("succeeded");
    });

    test("short drama materialized task short-circuits", () => {
        const node = baseNode();
        node.metadata = { ...node.metadata, shortDrama: { materializedTaskId: "task-1" } } as CanvasNodeData["metadata"];
        expect(bindGenerationTaskToNode(node, task())).toBe(node);
    });
});

describe("isTaskHeartbeatOnly", () => {
    const row = () => generationTaskMetadata(task()) as Record<string, unknown>;

    test("same task with only a newer updatedAt is a heartbeat", () => {
        expect(isTaskHeartbeatOnly(row(), task({ updatedAt: "2026-10-31T00:00:45Z" }))).toBe(true);
    });

    test("progress change is not a heartbeat", () => {
        expect(isTaskHeartbeatOnly(row(), task({ progress: 55 }))).toBe(false);
    });

    test("different task id or missing metadata is not a heartbeat", () => {
        expect(isTaskHeartbeatOnly(row(), task({ id: "task-2" }))).toBe(false);
        expect(isTaskHeartbeatOnly(undefined, task())).toBe(false);
    });

    test("terminal states always count as changes", () => {
        expect(isTaskHeartbeatOnly(row(), task({ status: "succeeded" }))).toBe(false);
        expect(isTaskHeartbeatOnly(row(), task({ status: "failed" }))).toBe(false);
    });
});
