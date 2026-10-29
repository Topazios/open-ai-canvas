import { normalizeReasoningEffort, type ReasoningEffort } from "@/lib/reasoning-effort";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { resolveGenerationWorkflowExecution, type GenerationWorkflowExecution } from "@/lib/generation-workflow-execution";
import { resolveVideoOperation } from "@/lib/model-selection";
import { logicalModelIDForConfig, modelOptionName, resolveModelChannel, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { CreateTaskInput, GenerationTask } from "@/services/api/task-center";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { PreparedGenerationReferences } from "@/services/task-runtime/resource-preparer";

// 旧版提交协议适配层：把页面传入的生成选项翻译成后端 CreateTaskInput。
// 新运行时（TaskIntent -> TaskSpec）稳定前，所有旧入口仍经由这里生成载荷，
// 保证拆分前后后端收到的字段、顺序和取值完全一致。

export type BackendGenerationMode = "text" | "image" | "video" | "audio";
export type GenerationModelRouting = "logical" | "channel";

export type BackendGenerationTaskOptions = {
    workflowBatch?: import("@/lib/canvas/workflow-text-batch").WorkflowTextBatch;
    projectId?: string;
    mode: BackendGenerationMode;
    prompt: string;
    config: AiConfig;
    referenceImages?: ReferenceImage[];
    referenceVideos?: ReferenceVideo[];
    referenceAudios?: ReferenceAudio[];
    textHistory?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    mask?: ReferenceImage;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
    onTaskUpdate?: (task: GenerationTask) => void;
    onTextDelta?: (text: string) => void;
    streamText?: boolean;
    reasoningEffort?: ReasoningEffort;
    maxOutputTokens?: number;
    structuredOutput?: {
        name: string;
        schema: Record<string, unknown>;
        strict?: boolean;
    };
    clientOperationId?: string;
    retryOf?: string;
    retryContextsByBatchIndex?: Array<{ retryOf: string; attemptGroupId: string; clientOperationId: string }>;
    attemptGroupId?: string;
    // 视频任务必须使用当前选中的具体渠道，避免逻辑模型路由改派到其他渠道。
    modelRouting?: GenerationModelRouting;
};

export function defaultModelRouting(mode: BackendGenerationMode): GenerationModelRouting {
    return mode === "video" ? "channel" : "logical";
}

export function buildLegacyCreateTaskInput(options: BackendGenerationTaskOptions, prepared: PreparedGenerationReferences): CreateTaskInput {
    const { projectId, mode, prompt, config, metadata } = options;
    const videoOperation = generationOperation(options);
    const workflow = resolveGenerationWorkflowExecution(config, mode);
    const modelRouting = options.modelRouting || defaultModelRouting(mode);
    const logicalModelId = workflow || modelRouting === "channel" ? "" : logicalModelIDForConfig(config);
    return {
        ...(projectId ? { projectId } : {}),
        type: `canvas_${mode}`,
        operation: mode === "video" ? videoOperation : mode,
        prompt,
        ...(workflow ? { provider: workflow.provider } : {}),
        model: workflow?.taskModel || config.model,
        ...(logicalModelId ? { logicalModelId } : {}),
        input: {
            mode,
            prompt,
            ...(options.workflowBatch ? { workflowBatch: options.workflowBatch } : {}),
            ...(workflow ? { execution: workflowPublicExecution(workflow) } : {}),
            config: backendProviderConfig(config, mode, modelRouting),
            capabilityOptions: logicalModelId ? logicalCapabilityOptions(config, mode) : undefined,
            textHistory: options.textHistory,
            ...(mode === "text"
                ? {
                      textOptions: {
                          stream: options.streamText !== false,
                          reasoningEffort: normalizeReasoningEffort(options.reasoningEffort ?? config.textReasoningEffort),
                          ...(options.maxOutputTokens && options.maxOutputTokens > 0 ? { maxOutputTokens: options.maxOutputTokens } : {}),
                          ...(options.structuredOutput ? { structuredOutput: options.structuredOutput } : {}),
                      },
                  }
                : {}),
            referenceImages: prepared.referenceImages,
            referenceVideos: prepared.referenceVideos,
            referenceAudios: prepared.referenceAudios,
            mask: prepared.mask,
            metadata: generationMetadata(config, mode, {
                ...metadata,
                ...(options.clientOperationId ? { clientOperationId: options.clientOperationId } : {}),
                ...(options.retryOf ? { retryOf: options.retryOf } : {}),
                ...(options.attemptGroupId ? { attemptGroupId: options.attemptGroupId } : {}),
            }),
        },
    };
}

function generationOperation(options: BackendGenerationTaskOptions) {
    if (options.mode !== "video") return options.mode;
    return resolveVideoOperation({
        textCount: 0,
        imageCount: options.referenceImages?.length ?? 0,
        videoCount: options.referenceVideos?.length ?? 0,
        audioCount: options.referenceAudios?.length ?? 0,
        characterCount: 0,
    }, options.metadata?.videoEditOperation as string | undefined);
}

function generationMetadata(config: AiConfig, mode: BackendGenerationMode, metadata?: Record<string, unknown>) {
    const channel = resolveModelChannel(config, config.model);
    const model = modelOptionName(config.model);
    const modelCost = channel.modelCosts?.find((item) => item.model === model);
    const protocol = modelCost?.protocol || channel.interfaceType;
    if (!protocol) return metadata;
    const existing = metadata?.providerOptions && typeof metadata.providerOptions === "object" && !Array.isArray(metadata.providerOptions)
        ? metadata.providerOptions as Record<string, unknown>
        : {};
    const namespace = existing[protocol] && typeof existing[protocol] === "object" && !Array.isArray(existing[protocol])
        ? existing[protocol] as Record<string, unknown>
        : {};
    const defaults = modelCost?.defaultOptions && typeof modelCost.defaultOptions === "object" ? modelCost.defaultOptions : {};
    const audioOptions = mode === "audio" ? {
        emo_control_method: config.audioEmotionControlMethod || "与音色参考音频相同",
        emo_random: config.audioEmotionRandom === "true",
        emo_happy: Number(config.audioEmotionHappy || 0),
        emo_angry: Number(config.audioEmotionAngry || 0),
        emo_sad: Number(config.audioEmotionSad || 0),
        emo_afraid: Number(config.audioEmotionAfraid || 0),
        emo_disgusted: Number(config.audioEmotionDisgusted || 0),
        emo_melancholic: Number(config.audioEmotionMelancholic || 0),
        emo_surprised: Number(config.audioEmotionSurprised || 0),
        emo_calm: Number(config.audioEmotionCalm || 0),
    } : {};
    if (!Object.keys(defaults).length && !Object.keys(audioOptions).length && !Object.keys(namespace).length) return metadata;
    return { ...metadata, providerOptions: { ...existing, [protocol]: { ...defaults, ...audioOptions, ...namespace } } };
}

export function backendProviderConfig(config: AiConfig, mode: BackendGenerationMode = "image", modelRouting: GenerationModelRouting = defaultModelRouting(mode)) {
    const requestConfig = resolveModelRequestConfig(config, config.model);
    const workflow = resolveGenerationWorkflowExecution(config, mode);
    if (workflow) return workflowProviderConfig(config, requestConfig, workflow);
    const generationOptions = {
        size: config.size,
        quality: omittedImageQuality(config.quality),
        transparentBackground: config.transparentBackground,
        count: config.count,
        videoSeconds: config.videoSeconds,
        vquality: config.vquality,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
        videoArkPrivateAssetUpload: config.videoArkPrivateAssetUpload,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions,
        systemPrompt: config.systemPrompt,
    };
    if (modelRouting === "logical" && logicalModelIDForConfig(config)) return generationOptions;
    return {
        channelId: requestConfig.channelId,
        ...(requestConfig.channelId ? { channelModelKey: requestConfig.model } : {}),
        apiFormat: requestConfig.apiFormat,
        interfaceType: requestConfig.interfaceType,
        baseUrl: requestConfig.baseUrl,
        apiKey: requestConfig.apiKey,
        secretKey: requestConfig.secretKey,
        model: requestConfig.model,
        ...generationOptions,
        capabilityConfig: modelCapabilityConfigFor(config, requestConfig.model),
        systemPrompt: config.systemPrompt,
    };
}

function workflowProviderConfig(config: AiConfig, requestConfig: ReturnType<typeof resolveModelRequestConfig>, workflow: GenerationWorkflowExecution) {
    const runningHubActive = workflow.provider === "runninghub";
    return {
        channelId: "",
        apiFormat: requestConfig.apiFormat,
        interfaceType: workflow.interfaceType,
        baseUrl: config.runningHub.baseUrl,
        apiKey: runningHubActive ? config.runningHub.apiKey : "",
        // 工作流是独立 Provider，不能继承普通模型渠道的密钥和自定义头。
        secretKey: "",
        headers: [],
        model: workflow.providerModel,
        size: config.size,
        quality: config.quality,
        transparentBackground: config.transparentBackground,
        count: config.count,
        videoSeconds: config.videoSeconds,
        vquality: config.vquality,
        videoGenerateAudio: config.videoGenerateAudio,
        videoWatermark: config.videoWatermark,
        videoArkPrivateAssetUpload: config.videoArkPrivateAssetUpload,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions,
        workflowId: workflow.workflowId,
        webappId: workflow.webappId,
        workflowJson: workflow.workflowJson,
        workflowFields: workflow.workflowFields,
        runningHubUseWallet: false,
        runningHubWalletApiKey: "",
        runningHubUploadApiKey: runningHubActive ? config.runningHub.uploadApiKey || "" : "",
        capabilityConfig: modelCapabilityConfigFor(config, requestConfig.model),
        systemPrompt: config.systemPrompt,
    };
}

function workflowPublicExecution(workflow: GenerationWorkflowExecution) {
    return {
        provider: workflow.provider,
        kind: workflow.kind,
        interfaceType: workflow.interfaceType,
        name: workflow.name,
        ...(workflow.workflowId ? { workflowId: workflow.workflowId } : {}),
        ...(workflow.webappId ? { webappId: workflow.webappId } : {}),
    };
}

function logicalCapabilityOptions(config: AiConfig, mode: BackendGenerationMode) {
    const channel = resolveModelChannel(config, config.model);
    const spec = channel.modelCosts?.find((item) => item.model === modelOptionName(config.model))?.logicalCapabilitySpec;
    const candidates: Record<string, unknown> = mode === "image"
        ? { size: config.size, quality: omittedImageQuality(config.quality), transparentBackground: config.transparentBackground === "true", count: Number(config.count) }
        : mode === "video"
            ? { size: config.size, videoSeconds: Number(config.videoSeconds), vquality: config.vquality, videoGenerateAudio: config.videoGenerateAudio === "true", videoWatermark: config.videoWatermark === "true" }
            : mode === "audio"
                ? { audioVoice: config.audioVoice, audioFormat: config.audioFormat, audioSpeed: Number(config.audioSpeed) }
                : {};
    // 只把前台模型声明过的参数送进能力匹配。未声明的 quality 不能因为画布选了 4K 档位
    // 而被硬塞进去，否则会报“不支持参数 生成质量”；插件仍从 config.quality 读取档位。
    return Object.fromEntries(Object.entries(candidates).filter(([key]) => Boolean(spec?.options?.[key])));
}

export function omittedImageQuality(value: string | undefined) {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "auto" || normalized === "any" ? undefined : value;
}
