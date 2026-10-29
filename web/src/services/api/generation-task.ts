import { createClientId } from "@/lib/client-id";
import { normalizeReasoningEffort } from "@/lib/reasoning-effort";
import { resourceIdFromStorageKey } from "@/services/api/resources";
import { createGenerationTask, waitForGenerationTask, type GenerationTask, type CreateTaskInput } from "@/services/api/task-center";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { grokImagePromptLimitError } from "@/lib/grok-image-prompt-limit";
import { resolveGenerationWorkflowExecution } from "@/lib/generation-workflow-execution";
import { modelPromptLengthError } from "@/lib/model-selection";
import { logicalModelIDForConfig, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import { buildBackendToolRequests, type ResponseFunctionTool, type ResponseInputMessage, type ToolChoice, type ToolResponseResult } from "@/services/api/image";
import { assertAgentExchangeBudget } from "@/lib/canvas/agent-context-budget";
import {
    backendProviderConfig,
    buildLegacyCreateTaskInput,
    type BackendGenerationMode,
    type BackendGenerationTaskOptions,
} from "@/services/task-runtime/legacy-adapter";
import { prepareGenerationReferences, type PreparedGenerationReferences } from "@/services/task-runtime/resource-preparer";

export { logicalModelIDForConfig };
export { backendProviderConfig };
export type { BackendGenerationMode, BackendGenerationTaskOptions, GenerationModelRouting } from "@/services/task-runtime/legacy-adapter";

export type BackendGenerationResult = {
    mode?: BackendGenerationMode;
    images?: Array<{ dataUrl: string; storageKey?: string; width?: number; height?: number; bytes?: number; mimeType?: string }>;
    video?: { dataUrl: string; storageKey?: string; width?: number; height?: number; durationMs?: number; bytes?: number; mimeType?: string };
    audio?: { dataUrl: string; storageKey?: string; durationMs?: number; bytes?: number; mimeType?: string; format?: string };
    audios?: Array<{ dataUrl: string; storageKey?: string; durationMs?: number; bytes?: number; mimeType?: string; format?: string }>;
    text?: string;
    toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string }; thoughtSignature?: string }>;
    reasoning?: string;
};

export type GenerationTaskDependencies = {
    createTask: typeof createGenerationTask;
    waitTask: typeof waitForGenerationTask;
    createId: () => string;
};

const defaultDependencies: GenerationTaskDependencies = {
    createTask: createGenerationTask,
    waitTask: waitForGenerationTask,
    createId: () => createClientId(),
};

// 生成、计费、取消和任务记录必须共用后端任务生命周期，页面层不能再直连供应商。
export async function runBackendGenerationTask(
    {
        projectId,
        mode,
        prompt,
        config,
        referenceImages = [],
        referenceVideos = [],
        referenceAudios = [],
        textHistory = [],
        mask,
        signal,
        metadata,
        onTaskUpdate,
        onTextDelta,
        streamText,
        reasoningEffort,
        maxOutputTokens,
        structuredOutput,
        clientOperationId,
        retryOf,
        attemptGroupId,
        workflowBatch,
        modelRouting,
    }: BackendGenerationTaskOptions,
    dependencies: GenerationTaskDependencies = defaultDependencies,
) {
    throwIfAborted(signal);
    assertClientPromptLimit(mode, prompt, config, metadata);
    assertBackendRuntimeConfigured(config, mode);
    const prepared = await prepareGenerationReferences({ config, mode, referenceImages, referenceVideos, referenceAudios, mask });
    throwIfAborted(signal);
    return createAndWaitGenerationTask({ projectId, mode, prompt, config, referenceImages, referenceVideos, referenceAudios, textHistory, signal, metadata, onTaskUpdate, onTextDelta, streamText, reasoningEffort, maxOutputTokens, structuredOutput, clientOperationId, retryOf, attemptGroupId, workflowBatch, modelRouting }, prepared, dependencies);
}

// 分镜等后台生产流程只需要可靠提交任务；任务状态与产物由项目工作区轮询和
// 后端自动回填负责，不能让页面 mutation 一直等待供应商完成。
export async function submitBackendGenerationTask(
    options: BackendGenerationTaskOptions,
    dependencies: GenerationTaskDependencies = defaultDependencies,
): Promise<GenerationTask> {
    throwIfAborted(options.signal);
    assertClientPromptLimit(options.mode, options.prompt, options.config, options.metadata);
    assertBackendRuntimeConfigured(options.config, options.mode);
    const prepared = await prepareGenerationReferences(options);
    throwIfAborted(options.signal);
    return createBackendGenerationTask(options, prepared, dependencies);
}

type BackendToolGenerationOptions = {
    prompt: string;
    config: AiConfig;
    messages: ResponseInputMessage[];
    tools: ResponseFunctionTool[];
    toolChoice: ToolChoice;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
    onTaskCreated?: (task: GenerationTask) => void;
    metadata?: { source: string; nodeId?: string; runId?: string; stage?: string };
};

// 报价和执行复用完全相同的任务协议，准备阶段不提交模型任务。
export function prepareBackendToolGenerationTask(options: BackendToolGenerationOptions): CreateTaskInput {
    throwIfAborted(options.signal);
    const logicalModelId = logicalModelIDForConfig(options.config);
    const requestConfig = resolveModelRequestConfig(options.config, options.config.model);
    const capability = modelCapabilityConfigFor(options.config, requestConfig.model).text;
    assertAgentExchangeBudget(options.messages, options.tools, options.config.systemPrompt || "", capability);
    const imageKeys = new Set<string>();
    for (const message of options.messages) {
        if ("type" in message || message.role === "tool" || !Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (part.type !== "image_url") continue;
            const key = part.image_url.url;
            if (!resourceIdFromStorageKey(key)) throw new Error("看图素材尚未保存为资源，请让助手重新读取图片后继续。");
            imageKeys.add(key);
        }
    }
    if (!logicalModelId && !requestConfig.channelId && !requestConfig.interfaceType) throw new Error("当前模型未选择可用请求协议");
    const task: CreateTaskInput = {
        type: "canvas_text",
        operation: "text",
        prompt: options.prompt,
        model: options.config.model,
        ...(logicalModelId ? { logicalModelId } : {}),
        input: {
            mode: "text",
            prompt: options.prompt,
            config: backendProviderConfig(options.config, "text"),
            agentRequests: buildBackendToolRequests(options.messages, options.tools, options.toolChoice, options.config),
            textOptions: { stream: modelCapabilityConfigFor(options.config, requestConfig.model).text?.streaming !== false, reasoningEffort: normalizeReasoningEffort(options.config.textReasoningEffort) },
            referenceImages: [...imageKeys].map((storageKey) => ({ storageKey })),
            metadata: options.metadata || { source: "canvas-online-agent" },
        },
    };
    if (new Blob([JSON.stringify(task)]).size > 15 * 1024 * 1024) {
        throw new Error("本次图片或对话内容过多，请减少参考图片，或新建会话后继续。已有作品会保留。");
    }
    return task;
}

export async function runBackendToolGenerationTask(options: BackendToolGenerationOptions): Promise<ToolResponseResult> {
    const task = await createGenerationTask(prepareBackendToolGenerationTask(options));
    options.onTaskCreated?.(task);
    const completed = await waitForGenerationTask(task.id, { signal: options.signal, initialTask: task, onTextDelta: options.onDelta });
    const result = parseBackendGenerationResult(completed);
    return {
        content: result.text || "",
        toolCalls: result.toolCalls || [],
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    };
}

export async function runBackendGenerationTaskBatch(options: BackendGenerationTaskOptions & { count: number }, dependencies: GenerationTaskDependencies = defaultDependencies) {
    const count = Math.max(1, Math.min(15, Math.floor(Number(options.count)) || 1));
    throwIfAborted(options.signal);
    assertClientPromptLimit(options.mode, options.prompt, options.config, options.metadata);
    if (options.retryContextsByBatchIndex && options.retryContextsByBatchIndex.length !== count) throw new Error("生成重试批次任务数量不匹配");
    const prepared = await prepareGenerationReferences(options);
    throwIfAborted(options.signal);
    return Promise.allSettled(
        Array.from({ length: count }, (_, batchIndex) =>
            createAndWaitGenerationTask(
                {
                    ...options,
                    metadata: { ...options.metadata, batchIndex, batchCount: count },
                },
                prepared,
                dependencies,
            ),
        ),
    );
}

export function isGenerationTaskCancelled(error: unknown, signal?: AbortSignal) {
    return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function assertBackendRuntimeConfigured(config: AiConfig, mode: BackendGenerationMode) {
    if (resolveGenerationWorkflowExecution(config, mode)) return;
    if (logicalModelIDForConfig(config)) return;
    const requestConfig = resolveModelRequestConfig(config, config.model);
    if (!requestConfig.channelId && !requestConfig.interfaceType) throw new Error("当前模型未选择可用请求协议，请先在模型设置中选择协议插件");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function assertClientPromptLimit(mode: BackendGenerationMode, prompt: string, config: AiConfig, metadata?: Record<string, unknown>) {
    if (mode !== "image" || metadata?.promptTemplateOperation || (config.taskWorkflowProvider || "model") !== "model") return;
    const requestConfig = resolveModelRequestConfig(config, config.model);
    const fullPrompt = config.systemPrompt?.trim() ? `${config.systemPrompt.trim()}\n\n${prompt}` : prompt;
    const promptLimitError = grokImagePromptLimitError(fullPrompt, requestConfig.interfaceType, requestConfig.model)
        || modelPromptLengthError(config, config.model, "image", fullPrompt);
    if (promptLimitError) throw new Error(promptLimitError);
}

async function createAndWaitGenerationTask(options: BackendGenerationTaskOptions, prepared: PreparedGenerationReferences, dependencies: GenerationTaskDependencies) {
    const task = await createBackendGenerationTask(options, prepared, dependencies);
    const { signal, onTaskUpdate, onTextDelta } = options;
    const completed = await dependencies.waitTask(task.id, { signal, initialTask: task, onTaskUpdate, onTextDelta });
    return parseBackendGenerationResult(completed);
}

async function createBackendGenerationTask(options: BackendGenerationTaskOptions, prepared: PreparedGenerationReferences, dependencies: GenerationTaskDependencies) {
    const task = await dependencies.createTask(buildLegacyCreateTaskInput(options, prepared));
    options.onTaskUpdate?.(task);
    return task;
}

export async function prepareBackendGenerationTask(options: BackendGenerationTaskOptions): Promise<CreateTaskInput> {
    throwIfAborted(options.signal);
    assertClientPromptLimit(options.mode, options.prompt, options.config, options.metadata);
    assertBackendRuntimeConfigured(options.config, options.mode);
    const prepared = await prepareGenerationReferences(options);
    throwIfAborted(options.signal);
    return buildLegacyCreateTaskInput(options, prepared);
}

export function parseBackendGenerationResult(task: GenerationTask): BackendGenerationResult {
    if (!task.resultJson) throw new Error("后端任务没有返回结果");
    const result = JSON.parse(task.resultJson) as BackendGenerationResult & { text?: unknown };
    if (!result || typeof result !== "object") throw new Error("后端任务结果格式错误");
    return { ...result, text: normalizeBackendText(result.text) };
}

function normalizeBackendText(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
        const text = value.map((item) => normalizeBackendText(item)).filter((item): item is string => Boolean(item)).join("");
        return text || undefined;
    }
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        for (const key of ["text", "content", "output_text", "value"]) {
            if (!(key in record)) continue;
            const nested = normalizeBackendText(record[key]);
            if (nested !== undefined) return nested;
        }
        // 某些结构化文本任务直接把 JSON 载荷放进 text 对象，保留 JSON 供上层契约解析。
        return JSON.stringify(value);
    }
    return String(value);
}
