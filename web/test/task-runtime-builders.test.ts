import { describe, expect, test } from "bun:test";

import { buildImageTaskIntent, type ImageTaskBuildInput } from "../src/lib/task-runtime/builders/image";
import { getTaskBuilder, registeredTaskKinds } from "../src/lib/task-runtime/builders/registry";
import { stableStringify, validateTaskIntent } from "../src/lib/task-runtime/validation";
import { buildCanvasImageTaskIntent, buildCanvasImageTaskOptions, compareImageTaskShadow, prepareCanvasImageTask } from "../src/pages/canvas/task-adapters/image";
import type { CanvasGenerationExecution } from "../src/pages/canvas/canvas-generation-executor-types";
import { defaultConfig } from "../src/stores/use-config-store";
import type { CanvasNodeData } from "../src/types/canvas";
import type { ReferenceImage } from "../src/types/image";

function buildInput(overrides: Partial<ImageTaskBuildInput> = {}): ImageTaskBuildInput {
    return {
        source: { surface: "canvas", entry: "canvas-image-single", projectId: "p-1", nodeId: "n-1" },
        prompt: "雨夜街头",
        modelSelection: { logicalModelId: "image-model" },
        references: [
            { id: "img-b", type: "image/png", storageKey: "resource:res-b" },
            { id: "img-a", type: "image/jpeg", url: "https://cdn.example.com/a.jpg" },
            { id: "img-c" },
        ],
        params: { size: " 1024x1024 ", quality: "auto", count: "2", transparentBackground: "true" },
        outputBinding: { targetKind: "canvas_node", targetId: "n-1" },
        ...overrides,
    };
}

describe("图片任务构造器", () => {
    test("同一输入结果确定且不修改输入", () => {
        const input = buildInput();
        const snapshot = JSON.stringify(input);
        const first = buildImageTaskIntent(input);
        const second = buildImageTaskIntent(input);
        expect(stableStringify(first)).toBe(stableStringify(second));
        expect(JSON.stringify(input)).toBe(snapshot);
        expect(Object.isFrozen(first.references[0])).toBe(true);
        expect(first.source).not.toBe(input.source);
    });

    test("引用保持原顺序并按 storageKey、url、id 解析资源", () => {
        const intent = buildImageTaskIntent(buildInput());
        expect(intent.operation).toBe("edit");
        expect(intent.references.map((ref) => [ref.resourceId, ref.order, ref.role])).toEqual([
            ["res-b", 0, "reference"],
            ["https://cdn.example.com/a.jpg", 1, "reference"],
            ["img-c", 2, "reference"],
        ]);
    });

    test("无引用时为 generation，参数规范化", () => {
        const intent = buildImageTaskIntent(buildInput({ references: [] }));
        expect(intent.operation).toBe("generation");
        expect(intent.params).toEqual({ size: "1024x1024", quality: undefined, count: 2, transparentBackground: true });
        expect(validateTaskIntent(intent)).toEqual({ ok: true });
    });

    test("非法数量回退为 1，产物通过合同校验", () => {
        const intent = buildImageTaskIntent(buildInput({ params: { count: "abc", quality: "high" } }));
        expect(intent.params.count).toBe(1);
        expect(intent.params.quality).toBe("high");
        expect(validateTaskIntent(intent)).toEqual({ ok: true });
    });

    test("注册表只登记已迁移的类型", () => {
        expect(registeredTaskKinds()).toEqual(["image"]);
        expect(getTaskBuilder("image").version).toBe(1);
        expect(getTaskBuilder("video")).toBeUndefined();
    });
});

// 执行器迁移前的手写字面量，作为适配器输出的对照基线。
function legacyLiteral(execution: CanvasGenerationExecution, targetId: string) {
    const { projectId, nodeId, sourceNode, effectivePrompt, generationConfig, generationContext, controller, styleMetadata, skillMetadata, taskContext, retryContext } = execution;
    const referenceImages = generationContext.referenceImages;
    return {
        projectId,
        nodeId: targetId,
        ...retryContext,
        mode: "image",
        prompt: effectivePrompt,
        config: { ...generationConfig, count: "1" },
        referenceImages,
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

function keyOrder(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(keyOrder);
    if (!value || typeof value !== "object" || value instanceof AbortSignal) return value;
    return Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, key === "config" ? Object.keys(child as object) : keyOrder(child)]);
}

const references: ReferenceImage[] = [
    { id: "ref-2", name: "b.png", type: "image/png", dataUrl: "", storageKey: "resource:res-2" },
    { id: "ref-1", name: "a.png", type: "image/png", dataUrl: "", url: "https://cdn.example.com/a.png" },
];

function execution(variant: "full" | "minimal"): CanvasGenerationExecution {
    const sourceNode = {
        id: "source",
        type: "image",
        title: "",
        position: { x: 0, y: 0 },
        width: 100,
        height: 100,
        metadata: variant === "full" ? { storyboardFrame: { rowId: "row-1" }, promptTemplateOperation: "remix", promptTemplateVariables: { mood: "dark" } } : {},
    } as unknown as CanvasNodeData;
    return {
        projectId: "project-1",
        nodeId: "source",
        sourceNode,
        effectivePrompt: "最终提示词",
        generationConfig: { ...defaultConfig, size: "16:9", quality: "high", count: "3" },
        generationContext: { referenceImages: variant === "full" ? references : [], resolvedCharacterVersions: [{ assetId: "a-1", versionId: "v-1" }] },
        controller: new AbortController(),
        styleMetadata: variant === "full" ? { styleProfileJson: "{}" } : {},
        skillMetadata: {},
        taskContext: variant === "full" ? { conversationId: "c-1", storyboardRowId: "row-1", batchTargetKind: "node" } : undefined,
        retryContext: variant === "full" ? { retryOf: "t-0", attemptGroupId: "g-1", clientOperationId: "op-1" } : undefined,
    } as unknown as CanvasGenerationExecution;
}

describe("画布单图任务适配器", () => {
    for (const variant of ["full", "minimal"] as const) {
        test(`输出与旧字面量深度相等且 key 顺序一致（${variant}）`, () => {
            const value = execution(variant);
            const adapted = buildCanvasImageTaskOptions(value, "target-1");
            const legacy = legacyLiteral(value, "target-1");
            expect(adapted).toEqual(legacy as typeof adapted);
            expect(keyOrder(adapted)).toEqual(keyOrder(legacy));
            expect(adapted.referenceImages).toBe(value.generationContext.referenceImages);
            expect(adapted.signal).toBe(value.controller.signal);
            expect(prepareCanvasImageTask(value, "target-1")).toEqual(adapted);
        });
    }

    test("适配器构造的意图通过影子比较且不改动提交参数", () => {
        const options = buildCanvasImageTaskOptions(execution("full"), "target-1");
        const before = JSON.stringify(options);
        const intent = buildCanvasImageTaskIntent(options);
        expect(intent.operation).toBe("edit");
        expect(intent.references.map((ref) => ref.resourceId)).toEqual(["res-2", "https://cdn.example.com/a.png"]);
        expect(intent.params.count).toBe(1);
        expect(intent.outputBinding).toEqual({ targetKind: "canvas_node", targetId: "target-1" });
        expect(compareImageTaskShadow(options, intent)).toEqual({ matched: true, differences: [], validationIssues: [] });
        expect(JSON.stringify(options)).toBe(before);
    });

    test("影子比较能发现引用顺序差异", () => {
        const options = buildCanvasImageTaskOptions(execution("full"), "target-1");
        const intent = buildCanvasImageTaskIntent({ ...options, referenceImages: [...references].reverse() });
        const result = compareImageTaskShadow(options, intent);
        expect(result.matched).toBe(false);
        expect(result.differences.map((item) => item.field)).toContain("references.order");
    });
});