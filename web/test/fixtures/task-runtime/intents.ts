import { TASK_SCHEMA_VERSION, type TaskIntent } from "../../../src/lib/task-runtime/contracts";

// 任务运行时合同夹具：只包含假数据，不含真实密钥或用户信息。
export const validImageGenerationIntent: TaskIntent<"image"> = {
    schemaVersion: TASK_SCHEMA_VERSION,
    kind: "image",
    operation: "generation",
    source: { surface: "canvas", entry: "canvas-image-single", projectId: "project-fixture", nodeId: "node-fixture" },
    prompt: "一只在雨夜街头的猫",
    modelSelection: { logicalModelId: "image-model" },
    references: [],
    params: { size: "1024x1024", quality: "high", count: 1, transparentBackground: false },
    outputBinding: { targetKind: "canvas_node", targetId: "node-fixture" },
};

export const validImageEditIntent: TaskIntent<"image"> = {
    ...validImageGenerationIntent,
    operation: "edit",
    references: [
        { resourceId: "res-a", contentIdentity: "resource:res-a", mediaType: "image/png", role: "reference", order: 0 },
        { resourceId: "res-b", contentIdentity: "resource:res-b", mediaType: "image/png", role: "reference", order: 1 },
    ],
};

export const invalidIntents: Array<{ name: string; intent: unknown; paths: string[] }> = [
    { name: "schemaVersion 错误", intent: { ...validImageGenerationIntent, schemaVersion: 99 }, paths: ["intent.schemaVersion"] },
    { name: "未知任务类型", intent: { ...validImageGenerationIntent, kind: "hologram" }, paths: ["intent.kind"] },
    { name: "image 不支持 image_to_video", intent: { ...validImageGenerationIntent, operation: "image_to_video" }, paths: ["intent.operation"] },
    { name: "图片数量为 0", intent: { ...validImageGenerationIntent, params: { ...validImageGenerationIntent.params, count: 0 } }, paths: ["intent.params.count"] },
    { name: "透明背景为字符串", intent: { ...validImageGenerationIntent, params: { ...validImageGenerationIntent.params, transparentBackground: "true" } }, paths: ["intent.params.transparentBackground"] },
    {
        name: "引用 order 与下标不一致",
        intent: { ...validImageEditIntent, references: [{ ...validImageEditIntent.references[1], order: 1 }, { ...validImageEditIntent.references[0], order: 0 }] },
        paths: ["intent.references[0].order", "intent.references[1].order"],
    },
    { name: "缺少 source.entry", intent: { ...validImageGenerationIntent, source: { surface: "canvas", entry: "" } }, paths: ["intent.source"] },
];

// 客户端不得自报的字段，嵌套在任意层级都要被拒绝。
export const forbiddenFieldRequests: Array<{ name: string; request: unknown; path: string }> = [
    { name: "顶层 userId", request: { idempotencyKey: "k-1", userId: "user-fixture", intent: validImageGenerationIntent }, path: "userId" },
    { name: "intent 内 nonBillable", request: { idempotencyKey: "k-2", intent: { ...validImageGenerationIntent, nonBillable: true } }, path: "intent.nonBillable" },
    { name: "params 内 approval", request: { idempotencyKey: "k-3", intent: { ...validImageGenerationIntent, params: { ...validImageGenerationIntent.params, approval: "auto" } } }, path: "intent.params.approval" },
    {
        name: "引用数组内 taskId",
        request: { idempotencyKey: "k-4", intent: { ...validImageEditIntent, references: [{ ...validImageEditIntent.references[0], taskId: "task-fixture" }, validImageEditIntent.references[1]] } },
        path: "intent.references[0].taskId",
    },
];