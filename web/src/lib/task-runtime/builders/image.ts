import { TASK_SCHEMA_VERSION, type ModelSelection, type OutputBinding, type ResourceRef, type TaskBuilder, type TaskIntent, type TaskSchedule, type TaskSource } from "../contracts";
import { deepFreeze } from "../validation";

// 图片构造器的输入快照：只包含构造需要的稳定字段，由业务适配器从节点/配置提取。
// 不接收 dataUrl、密钥等大字段或敏感字段；资源上传由 resource-preparer 单独完成。
export type ImageReferenceSnapshot = {
    id: string;
    type?: string;
    url?: string;
    storageKey?: string;
};

export type ImageTaskBuildInput = {
    source: TaskSource;
    prompt: string;
    modelSelection?: ModelSelection;
    references: readonly ImageReferenceSnapshot[];
    params: {
        size?: string;
        quality?: string;
        count?: string | number;
        transparentBackground?: string | boolean;
    };
    outputBinding?: OutputBinding;
    schedule?: TaskSchedule;
};

export const IMAGE_BUILDER_VERSION = 1;

const RESOURCE_KEY_PREFIX = "resource:";

// 与 services/api/resources 的 resourceIdFromStorageKey 规则一致；这里重新实现以保持构造器无网络/存储依赖。
function resourceIdFromStorageKey(storageKey?: string) {
    return storageKey?.startsWith(RESOURCE_KEY_PREFIX) ? storageKey.slice(RESOURCE_KEY_PREFIX.length) : "";
}

function normalizeQuality(value?: string) {
    const trimmed = String(value ?? "").trim();
    const lower = trimmed.toLowerCase();
    return !trimmed || lower === "auto" || lower === "any" ? undefined : value;
}

function normalizeCount(value?: string | number) {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
}

function normalizeBoolean(value?: string | boolean) {
    return value === true || value === "true";
}

function toResourceRef(reference: ImageReferenceSnapshot, order: number): ResourceRef {
    const resourceId = resourceIdFromStorageKey(reference.storageKey) || reference.url || reference.id;
    return {
        resourceId,
        contentIdentity: reference.storageKey || reference.url || `ref:${reference.id}`,
        mediaType: reference.type || "image",
        role: "reference",
        order,
    };
}

function optionalString(value?: string) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

export function buildImageTaskIntent(input: ImageTaskBuildInput): TaskIntent<"image"> {
    const references = input.references.map(toResourceRef);
    const intent: TaskIntent<"image"> = {
        schemaVersion: TASK_SCHEMA_VERSION,
        kind: "image",
        operation: references.length ? "edit" : "generation",
        source: { ...input.source },
        prompt: input.prompt,
        references,
        params: {
            size: optionalString(input.params.size),
            quality: normalizeQuality(input.params.quality),
            count: normalizeCount(input.params.count),
            transparentBackground: normalizeBoolean(input.params.transparentBackground),
        },
    };
    if (input.modelSelection?.logicalModelId) {
        intent.modelSelection = { logicalModelId: input.modelSelection.logicalModelId, ...(input.modelSelection.channelId ? { channelId: input.modelSelection.channelId } : {}) };
    }
    if (input.outputBinding) intent.outputBinding = { ...input.outputBinding };
    if (input.schedule) intent.schedule = { ...input.schedule };
    return deepFreeze(intent);
}

export const imageTaskBuilder: TaskBuilder<"image", ImageTaskBuildInput> = {
    kind: "image",
    version: IMAGE_BUILDER_VERSION,
    build: buildImageTaskIntent,
};
