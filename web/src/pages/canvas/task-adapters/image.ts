import { resolveGenerationWorkflowExecution } from "@/lib/generation-workflow-execution";
import type { runCanvasGenerationTaskToConsumer } from "@/lib/canvas/canvas-project-generation";
import { buildImageTaskIntent, type ImageTaskBuildInput } from "@/lib/task-runtime/builders/image";
import type { TaskIntent } from "@/lib/task-runtime/contracts";
import { stableStringify, validateTaskIntent } from "@/lib/task-runtime/validation";
import { logicalModelIDForConfig, resolveModelRequestConfig } from "@/stores/use-config-store";

import type { CanvasGenerationExecution } from "../canvas-generation-executor-types";

// 画布普通图片单任务的业务适配器（迁移清单 canvas-image-single，当前阶段 shadow）。
// 负责从执行上下文提取提交参数；节点创建、布局、选择和结果展示仍留在执行器。

export type CanvasImageTaskOptions = Parameters<typeof runCanvasGenerationTaskToConsumer>[0];

type CanvasImageTaskExecution = Pick<
    CanvasGenerationExecution,
    "projectId" | "nodeId" | "sourceNode" | "effectivePrompt" | "generationConfig" | "generationContext" | "controller" | "styleMetadata" | "skillMetadata" | "taskContext" | "retryContext"
>;

// 输出与执行器原手写字面量逐字段、逐 key 顺序一致，旧 API 收到的载荷不变。
export function buildCanvasImageTaskOptions(execution: CanvasImageTaskExecution, targetId: string): CanvasImageTaskOptions {
    const { projectId, nodeId, sourceNode, effectivePrompt, generationConfig, generationContext, controller, styleMetadata, skillMetadata, taskContext, retryContext } = execution;
    return {
        projectId,
        nodeId: targetId,
        ...retryContext,
        mode: "image",
        prompt: effectivePrompt,
        config: { ...generationConfig, count: "1" },
        referenceImages: generationContext.referenceImages,
        signal: controller.signal,
        metadata: {
            sourceNodeId: nodeId,
            ...(sourceNode?.metadata?.storyboardFrame ? { storyboardFrame: sourceNode.metadata.storyboardFrame } : {}),
            ...taskContext,
            resolvedCharacterVersions: generationContext.resolvedCharacterVersions,
            promptTemplateOperation: sourceNode?.metadata?.promptTemplateOperation,
            promptTemplateVariables: sourceNode?.metadata?.promptTemplateVariables,
            ...styleMetadata,
            ...skillMetadata,
        },
    };
}

// 从旧提交参数提取构造器输入快照；只读，不修改 options。
export function canvasImageBuildInput(options: CanvasImageTaskOptions): ImageTaskBuildInput {
    const config = options.config;
    const workflow = resolveGenerationWorkflowExecution(config, "image");
    const logicalModelId = workflow ? "" : logicalModelIDForConfig(config);
    const channelId = resolveModelRequestConfig(config, config.model).channelId;
    return {
        source: { surface: "canvas", entry: "canvas-image-single", projectId: options.projectId, nodeId: String(options.metadata?.sourceNodeId ?? "") || undefined },
        prompt: options.prompt,
        modelSelection: logicalModelId ? { logicalModelId, ...(channelId ? { channelId } : {}) } : undefined,
        references: (options.referenceImages ?? []).map((image) => ({ id: image.id, type: image.type, url: image.url, storageKey: image.storageKey })),
        params: {
            size: config.size,
            quality: config.quality,
            count: config.count,
            transparentBackground: config.transparentBackground,
        },
        outputBinding: options.nodeId ? { targetKind: "canvas_node", targetId: options.nodeId } : undefined,
    };
}

export function buildCanvasImageTaskIntent(options: CanvasImageTaskOptions): TaskIntent<"image"> {
    return buildImageTaskIntent(canvasImageBuildInput(options));
}

export type ShadowDifference = { field: string; legacy: string; builder: string };

export type ImageTaskShadowResult = { matched: boolean; differences: ShadowDifference[]; validationIssues: string[] };

// 影子比较：只比较对象，不发送请求。比较引用顺序、operation、模型选择和有效参数。
export function compareImageTaskShadow(options: CanvasImageTaskOptions, intent: TaskIntent<"image">): ImageTaskShadowResult {
    const differences: ShadowDifference[] = [];
    const check = (field: string, legacy: unknown, builder: unknown) => {
        const left = stableStringify(legacy);
        const right = stableStringify(builder);
        if (left !== right) differences.push({ field, legacy: left, builder: right });
    };
    const references = options.referenceImages ?? [];
    check("operation", references.length ? "edit" : "generation", intent.operation);
    check("prompt", options.prompt, intent.prompt);
    // 期望值由旧参数独立推导（storageKey 资源 ID → url → id），与构造器产物逐位比较，顺序错位即可发现。
    const expectedResourceIds = references.map((image) => (image.storageKey?.startsWith("resource:") ? image.storageKey.slice("resource:".length) : "") || image.url || image.id);
    check("references.order", expectedResourceIds, intent.references.map((ref, index) => (ref.order === index ? ref.resourceId : `order:${ref.order}`)));
    check("params.count", Number.parseInt(String(options.config.count), 10) || 1, intent.params.count);
    check("params.size", options.config.size?.trim() || undefined, intent.params.size);
    check("params.transparentBackground", options.config.transparentBackground === "true", intent.params.transparentBackground);
    const workflow = resolveGenerationWorkflowExecution(options.config, "image");
    check("modelSelection.logicalModelId", workflow ? undefined : logicalModelIDForConfig(options.config) || undefined, intent.modelSelection?.logicalModelId);
    const validation = validateTaskIntent(intent);
    const validationIssues = validation.ok ? [] : validation.issues.map((issue) => `${issue.path} ${issue.message}`);
    return { matched: !differences.length && !validationIssues.length, differences, validationIssues };
}

// 执行器接线入口：返回旧提交参数，并在开发环境执行影子比较。影子比较失败只记录日志，不影响提交。
export function prepareCanvasImageTask(execution: CanvasImageTaskExecution, targetId: string): CanvasImageTaskOptions {
    const options = buildCanvasImageTaskOptions(execution, targetId);
    if (import.meta.env?.DEV) {
        try {
            const shadow = compareImageTaskShadow(options, buildCanvasImageTaskIntent(options));
            if (!shadow.matched) console.warn("[task-runtime] canvas image shadow mismatch", shadow);
        } catch (error) {
            console.warn("[task-runtime] canvas image shadow failed", error);
        }
    }
    return options;
}
