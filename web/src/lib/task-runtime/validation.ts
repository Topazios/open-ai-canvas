import { FORBIDDEN_CLIENT_FIELDS, TASK_SCHEMA_VERSION, type TaskKind } from "./contracts";

export type ValidationIssue = { path: string; message: string };

export type ValidationResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

const TASK_KINDS: readonly TaskKind[] = ["image", "video", "audio", "text"];

const OPERATIONS_BY_KIND: Record<TaskKind, readonly string[]> = {
    image: ["generation", "edit"],
    video: ["generation", "image_to_video", "first_last_frame"],
    audio: ["text_to_speech", "generation"],
    text: ["chat", "structured", "generation"],
};

const RESOURCE_ROLES = ["reference", "first_frame", "last_frame", "mask", "audio", "video"];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 递归查找客户端不允许自报的字段，任何层级出现都拒绝。
function collectForbiddenFields(value: unknown, path: string, issues: ValidationIssue[]) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectForbiddenFields(item, `${path}[${index}]`, issues));
        return;
    }
    if (!isRecord(value)) return;
    for (const key of Object.keys(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if ((FORBIDDEN_CLIENT_FIELDS as readonly string[]).includes(key)) {
            issues.push({ path: childPath, message: "该字段只能由服务端认定，客户端不得提交" });
            continue;
        }
        collectForbiddenFields(value[key], childPath, issues);
    }
}

function validateParams(kind: TaskKind, params: unknown, issues: ValidationIssue[]) {
    if (!isRecord(params)) {
        issues.push({ path: "intent.params", message: "params 必须是对象" });
        return;
    }
    if (kind === "image") {
        if (!Number.isInteger(params.count) || (params.count as number) < 1) issues.push({ path: "intent.params.count", message: "图片数量必须是正整数" });
        if (typeof params.transparentBackground !== "boolean") issues.push({ path: "intent.params.transparentBackground", message: "transparentBackground 必须是布尔值" });
        for (const key of ["size", "quality"]) {
            if (params[key] !== undefined && typeof params[key] !== "string") issues.push({ path: `intent.params.${key}`, message: `${key} 必须是字符串` });
        }
        return;
    }
    if (kind === "video") {
        if (!Number.isInteger(params.count) || (params.count as number) < 1) issues.push({ path: "intent.params.count", message: "视频数量必须是正整数" });
        if (params.durationSeconds !== undefined && !(typeof params.durationSeconds === "number" && params.durationSeconds > 0)) {
            issues.push({ path: "intent.params.durationSeconds", message: "时长必须是正数" });
        }
        return;
    }
    if (kind === "text" && params.responseFormat !== undefined && params.responseFormat !== "text" && params.responseFormat !== "json") {
        issues.push({ path: "intent.params.responseFormat", message: "responseFormat 只能是 text 或 json" });
    }
}

function validateReferences(references: unknown, issues: ValidationIssue[]) {
    if (!Array.isArray(references)) {
        issues.push({ path: "intent.references", message: "references 必须是数组" });
        return;
    }
    references.forEach((ref, index) => {
        const path = `intent.references[${index}]`;
        if (!isRecord(ref)) {
            issues.push({ path, message: "引用必须是对象" });
            return;
        }
        if (typeof ref.resourceId !== "string" || !ref.resourceId) issues.push({ path: `${path}.resourceId`, message: "resourceId 不能为空" });
        if (typeof ref.contentIdentity !== "string") issues.push({ path: `${path}.contentIdentity`, message: "contentIdentity 必须是字符串" });
        if (typeof ref.mediaType !== "string") issues.push({ path: `${path}.mediaType`, message: "mediaType 必须是字符串" });
        if (!RESOURCE_ROLES.includes(ref.role as string)) issues.push({ path: `${path}.role`, message: "未知的引用角色" });
        if (ref.order !== index) issues.push({ path: `${path}.order`, message: "order 必须与数组下标一致" });
    });
}

export function validateTaskIntent(intent: unknown, issues: ValidationIssue[] = [], forbiddenRoot = "intent"): ValidationResult {
    if (!isRecord(intent)) {
        issues.push({ path: "intent", message: "intent 必须是对象" });
        return { ok: false, issues };
    }
    if (forbiddenRoot) collectForbiddenFields(intent, forbiddenRoot, issues);
    if (intent.schemaVersion !== TASK_SCHEMA_VERSION) issues.push({ path: "intent.schemaVersion", message: `schemaVersion 必须为 ${TASK_SCHEMA_VERSION}` });
    const kind = intent.kind as TaskKind;
    if (!TASK_KINDS.includes(kind)) {
        issues.push({ path: "intent.kind", message: "未知的任务类型" });
    } else {
        if (!OPERATIONS_BY_KIND[kind].includes(intent.operation as string)) issues.push({ path: "intent.operation", message: `${kind} 不支持该 operation` });
        validateParams(kind, intent.params, issues);
    }
    if (!isRecord(intent.source) || typeof intent.source.surface !== "string" || typeof intent.source.entry !== "string" || !intent.source.entry) {
        issues.push({ path: "intent.source", message: "source 需要 surface 和 entry" });
    }
    if (intent.prompt !== undefined && typeof intent.prompt !== "string") issues.push({ path: "intent.prompt", message: "prompt 必须是字符串" });
    if (intent.modelSelection !== undefined && !(isRecord(intent.modelSelection) && typeof intent.modelSelection.logicalModelId === "string" && intent.modelSelection.logicalModelId)) {
        issues.push({ path: "intent.modelSelection.logicalModelId", message: "logicalModelId 不能为空" });
    }
    validateReferences(intent.references, issues);
    return issues.length ? { ok: false, issues } : { ok: true };
}

export function validateSubmitTaskRequest(request: unknown): ValidationResult {
    const issues: ValidationIssue[] = [];
    if (!isRecord(request)) return { ok: false, issues: [{ path: "", message: "请求必须是对象" }] };
    collectForbiddenFields(request, "", issues);
    if (typeof request.idempotencyKey !== "string" || !request.idempotencyKey.trim()) issues.push({ path: "idempotencyKey", message: "idempotencyKey 不能为空" });
    // 顶层已递归检查过禁用字段，这里不再重复检查 intent 内部。
    return validateTaskIntent(request.intent, issues, "");
}

export class TaskIntentValidationError extends Error {
    readonly issues: ValidationIssue[];

    constructor(issues: ValidationIssue[]) {
        super(`任务意图校验失败：${issues.map((issue) => `${issue.path || "<root>"} ${issue.message}`).join("；")}`);
        this.name = "TaskIntentValidationError";
        this.issues = issues;
    }
}

export function assertValidTaskIntent(intent: unknown) {
    const result = validateTaskIntent(intent);
    if (!result.ok) throw new TaskIntentValidationError(result.issues);
}

export function deepFreeze<T>(value: T): T {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
    return value;
}

// 稳定序列化：对象 key 排序、丢弃 undefined，用于请求哈希和影子比较。
export function stableStringify(value: unknown): string {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(",")}}`;
}
