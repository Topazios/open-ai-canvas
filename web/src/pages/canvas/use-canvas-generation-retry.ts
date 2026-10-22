import { createElement, useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { App, Button, Input } from "antd";
import { WandSparkles } from "lucide-react";
import { useConfirmedTaskRetry } from "@/components/use-confirmed-task-retry";

import { buildNodeGenerationContext, hydrateNodeGenerationContext } from "@/components/canvas/canvas-node-generation";
import { isEpisodeStoryboardVideo } from "@/lib/canvas/workflow-episode-storyboard";
import { storyboardFrameHash } from "@/lib/canvas/episode-storyboard-frames";
import { storyboardFrameNodeSelection } from "@/lib/canvas/storyboard-frame-model";
import { synchronizeGenerationSpec } from "@/lib/canvas/generation-contract";
import { producedModelCandidateForGeneration } from "@/lib/canvas/produced-model";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { buildEmotionImageArtifacts, emotionGenerationSize, emotionProviderMask, normalizeEmotionPromptForProvider, resolveEmotionEditPlan } from "@/lib/canvas/canvas-emotion";
import {
    buildAudioGenerationMetadata,
    buildGenerationConfig,
    buildImageGenerationMetadata,
    buildVideoGenerationMetadata,
    createGenerationRetryContext,
    findRetrySourceNode,
    generationReferenceUrls,
    generationWorkflowMetadata,
    isGenerationCanceled,
    canvasImageReferenceLimitError,
    resolveMetadataReferences,
    resolveStoredReferenceImages,
    runBackendCanvasGenerationTask,
    runCanvasGenerationTaskToConsumer,
    sourceNodeReferenceImages,
    supportsVideoReferenceAudio,
} from "@/lib/canvas/canvas-project-generation";
import { isCanvasWorkflowProvider } from "@/lib/canvas/canvas-workflow";
import { buildPortraitTexturePrompt } from "@/lib/canvas/canvas-portrait-texture";
import { resolveCanvasStyleExecution } from "@/lib/canvas/canvas-style-execution";
import { generationFailureMetadata, generationPromptFingerprint, isContentModerationError, unchangedModeratedPrompt } from "@/lib/generation-error";
import { modelCapabilityConfigFor } from "@/lib/model-capabilities";
import { navigateToSettings } from "@/lib/settings-navigation";
import type { Skill } from "@/services/api/skills";
import { skillRuntime, type SkillRuntimeMetadata } from "@/services/skill-runtime";
import { queryGenerationTask, recoverGenerationTaskMedia, waitForGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { resolveImageUrl } from "@/services/image-storage";
import { retryWorkflowGeneration } from "@/services/workflow-generation-retry";
import { adjustWorkflowImagePrompt } from "@/lib/canvas/canvas-image-prompt-adjustment";
import { controlProductionAgent } from "@/services/api/agent";
import { submitProductionAgent } from "@/services/production-agent";
import { refreshCanvasAfterAgent } from "@/services/user-data-sync";
import { restoreEmptyWorkflowAssetGroup } from "@/lib/canvas/canvas-workflow-assets";
import { resolveModelRequestConfig, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeTypeId, type CanvasNodeRetryOptions } from "@/types/canvas";

type UseCanvasGenerationRetryOptions = {
    projectId: string;
    domainProjectId?: string;
    addedSkills: Skill[];
    assets: Asset[];
    nodesRef: { current: CanvasNodeData[] };
    connectionsRef: { current: CanvasConnection[] };
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setRunningNodeId: Dispatch<SetStateAction<string | null>>;
    startGenerationRequest: (targetNodeId: string, originNodeId: string, runningId?: string, controller?: AbortController) => AbortController;
    finishGenerationRequest: (targetNodeId: string, controller: AbortController) => void;
    bindGenerationTask: (targetNodeId: string, task: GenerationTask) => void;
    applyGenerationTaskResult: (targetNodeId: string, task: GenerationTask) => Promise<void>;
};

const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

export function useCanvasGenerationRetry({
    projectId,
    domainProjectId,
    addedSkills,
    assets,
    nodesRef,
    connectionsRef,
    setNodes,
    setRunningNodeId,
    startGenerationRequest,
    finishGenerationRequest,
    bindGenerationTask,
    applyGenerationTaskResult,
}: UseCanvasGenerationRetryOptions) {
    const { message, modal } = App.useApp();
    const retryTask = useConfirmedTaskRetry();
    const pendingRetries = useRef(new Set<string>());
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);

    const runRetry = useCallback(
        async (node: CanvasNodeData, options?: CanvasNodeRetryOptions) => {
            const frame = node.metadata?.storyboardFrame;
            const frameIsCurrent = () => {
                if (!frame) return true;
                const current = nodesRef.current.find(item => item.id === node.id);
                const row = nodesRef.current.find(item => item.id === frame.scriptId)?.metadata?.storyboard?.rows.find(item => item.id === frame.rowId);
                return Boolean(current && row && current.metadata?.storyboardFrame?.sourcePromptHash === frame.sourcePromptHash && storyboardFrameHash(row) === frame.sourcePromptHash);
            };
            if (!frameIsCurrent()) { message.warning("分镜已修改，请生成当前版本画面"); return; }
            if (node.metadata?.shortDrama?.step === "assets.reconcile") { message.info("正文资产校核步骤已停用，请在正文节点或流程面板中发起正文质量审核"); return; }
            const production = node.metadata?.shortDrama?.productionAgent;
            if (production) {
                try {
                    if (production.runId) await controlProductionAgent(production.runId, "resume");
                    else if (production.request) await submitProductionAgent(production.request);
                    else throw new Error("制作任务尚未提交，请使用继续提交入口");
                    await refreshCanvasAfterAgent(projectId);
                } catch (cause) { message.error(cause instanceof Error ? cause.message : "恢复制作任务失败"); }
                return;
            }
            // Canvas caches may predate the failure. Consult the original task
            // before deciding to submit another paid generation.
            let sourceTask: GenerationTask | undefined;
            if (node.metadata?.taskId) {
                try {
                    sourceTask = await queryGenerationTask(node.metadata.taskId);
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "无法核对原任务，请稍后重试");
                    return;
                }
            }
            if (options?.adjustPrompt && !(sourceTask?.status === "failed" && (isContentModerationError(sourceTask.errorCode) || isContentModerationError(sourceTask.error)))) {
                message.info("任务状态已变化，请刷新后查看；未重复提交");
                return;
            }
            if (!frame && node.metadata?.shortDrama && (node.type === CanvasNodeType.Text || (node.metadata.shortDrama.mediaKind === "image" && !sourceTask?.mediaStage))) {
                if (node.metadata.shortDrama.mediaKind === "image" && sourceTask?.status === "failed" && (isContentModerationError(sourceTask.errorCode) || isContentModerationError(sourceTask.error))) {
                    const previousPrompt = sourceTask.prompt;
                    const adjust = () => adjustWorkflowImagePrompt(node, nodesRef.current, previousPrompt || "");
                    let revised: string | null;
                    if (options?.adjustPrompt) {
                        try { revised = adjust(); }
                        catch (error) { message.error(error instanceof Error ? error.message : "自动调整失败，未提交生成"); return; }
                    } else revised = await new Promise<string | null>((resolve) => {
                        let draft = node.metadata?.prompt || previousPrompt || "";
                        const dialog = modal.confirm({
                            title: "修改生成要求", width: 720,
                            content: createElement(Input.TextArea, { "aria-label": "图片生成要求", defaultValue: draft, autoSize: { minRows: 8, maxRows: 14 }, onChange: (event) => { draft = event.target.value; } }),
                            okText: "保存并生成", cancelText: "取消", maskClosable: false,
                            footer: (_, { OkBtn, CancelBtn }) => createElement("div", { className: "flex flex-wrap justify-end gap-2" },
                                createElement(CancelBtn),
                                node.metadata?.shortDrama?.assetSheet ? createElement(Button, { icon: createElement(WandSparkles, { size: 14 }), onClick: () => {
                                    try { const prompt = adjust(); resolve(prompt); dialog.destroy(); }
                                    catch (error) { message.error(error instanceof Error ? error.message : "自动调整失败，未提交生成"); }
                                } }, "自动调整并重试") : null,
                                createElement(OkBtn)),
                            onOk: (close: () => void) => {
                                if (!draft.trim() || generationPromptFingerprint(draft) === generationPromptFingerprint(previousPrompt || "")) {
                                    message.warning("请先修改生成要求，不能原样重试审核未通过的内容");
                                    return;
                                }
                                resolve(draft.trim());
                                close();
                            },
                            onCancel: () => { resolve(null); }, afterClose: () => { resolve(null); },
                        });
                    });
                    if (!revised) return;
                    const latest = nodesRef.current.find((item) => item.id === node.id);
                    if (!latest || latest.metadata?.taskId !== sourceTask.id) return;
                    node = { ...latest, metadata: { ...latest.metadata, prompt: revised, composerContent: revised } };
                    setNodes((current) => current.map((item) => item.id === node.id ? { ...item, metadata: { ...item.metadata, prompt: revised, composerContent: revised } } : item));
                }
                const controller = startGenerationRequest(node.id, node.id, node.id);
                try {
                    const initialTask = await retryWorkflowGeneration(node, sourceTask, projectId, effectiveConfig, undefined, nodesRef.current, retryTask);
                    if (controller.signal.aborted) return;
                    bindGenerationTask(node.id, initialTask);
                    setNodes((current) => restoreEmptyWorkflowAssetGroup(current.map((item) => {
                        if (item.id !== node.id || !item.metadata?.shortDrama?.assetSheet || !initialTask.prompt ||
                            item.metadata.taskId !== initialTask.id || item.metadata.prompt !== node.metadata?.prompt) return item;
                        const sheet = item.metadata.shortDrama.assetSheet;
                        const generated = sheet.promptFingerprint === generationPromptFingerprint(node.metadata?.prompt || "");
                        return { ...item, metadata: { ...item.metadata, prompt: initialTask.prompt, composerContent: initialTask.prompt,
                            ...(generated ? { shortDrama: { ...item.metadata.shortDrama, assetSheet: { ...sheet, promptFingerprint: generationPromptFingerprint(initialTask.prompt) } } } : {}) } };
                    }), node.id));
                    const completed = await waitForGenerationTask(initialTask.id, {
                        initialTask, signal: controller.signal, timeoutMs: 25 * 60_000,
                        onTaskUpdate: (task) => bindGenerationTask(node.id, task),
                    });
                    if (!controller.signal.aborted) await applyGenerationTaskResult(node.id, completed);
                } catch (error) {
                    if (!controller.signal.aborted && !isGenerationCanceled(error)) message.error(error instanceof Error ? error.message : "恢复流程任务失败");
                } finally {
                    finishGenerationRequest(node.id, controller);
                }
                return;
            }
            if (sourceTask && ((sourceTask.mediaStage && sourceTask.status !== "cancelled") || (frame && ["queued", "running", "succeeded"].includes(sourceTask.status)))) {
                const controller = startGenerationRequest(node.id, node.id, node.id);
                try {
                    const initialTask = sourceTask.status === "failed" ? await recoverGenerationTaskMedia(sourceTask.id) : sourceTask;
                    if (controller.signal.aborted) return;
                    bindGenerationTask(node.id, initialTask);
                    const completed = await waitForGenerationTask(initialTask.id, {
                        initialTask, signal: controller.signal, timeoutMs: 25 * 60_000,
                        onTaskUpdate: (task) => bindGenerationTask(node.id, task),
                    });
                    await applyGenerationTaskResult(node.id, completed);
                } catch (error) {
                    if (!controller.signal.aborted) message.error(error instanceof Error ? error.message : "恢复作品保存失败");
                } finally {
                    finishGenerationRequest(node.id, controller);
                }
                return;
            }
            const retryMode = retryModeForNode(node.type);
            if (!retryMode) {
                message.warning("当前节点不能使用通用生成重试");
                return;
            }
            if (!frameIsCurrent()) { message.warning("分镜已修改，请生成当前版本画面"); return; }
            if (frame) {
                node = storyboardFrameNodeSelection(effectiveConfig, node, nodesRef.current);
                const selected = node.metadata?.model;
                setNodes(current => current.map(item => item.id === node.id ? synchronizeGenerationSpec(item, { model: selected }) : item));
            }
            const sourceNode = frame ? node : findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const batchRoot = node.metadata?.batchRootId ? nodesRef.current.find((item) => item.id === node.metadata?.batchRootId) : null;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...batchRoot?.metadata, ...node.metadata } : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationSourceNode = node.type === CanvasNodeType.Config && isCanvasWorkflowProvider(node.metadata) || node.metadata?.workflowProvider === "model" ? node : sourceNode;
            const sourceGenerationConfig = buildGenerationConfig(effectiveConfig, generationSourceNode, retryMode);
            let generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...sourceGenerationConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model || sourceGenerationConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality || sourceGenerationConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size || sourceGenerationConfig.size,
                          transparentBackground: (savedImageMetadata.transparentBackground || effectiveConfig.transparentBackground || sourceGenerationConfig.transparentBackground) === "true" ? "true" : "false",
                          count: "1",
                      }
                    : { ...sourceGenerationConfig, count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                navigateToSettings({ continueCreation: true });
                return;
            }

            const retryPromptSource = sourceNode.metadata?.composerContent || sourceNode.metadata?.prompt || node.metadata?.prompt || "";
            const retryContextPrompt = retryMode === "image" && sourceNode.metadata?.portraitTexture ? buildPortraitTexturePrompt(retryPromptSource, sourceNode.metadata.portraitTexture) : retryPromptSource;
            if (unchangedModeratedPrompt(node.metadata, retryPromptSource)) {
                message.warning("该提示词未通过内容审核，请先修改提示词再重新生成");
                return;
            }
            let rawContext: Awaited<ReturnType<typeof hydrateNodeGenerationContext>> | null;
            try {
                const promptOnly = retryMode === "video" && !isEpisodeStoryboardVideo(sourceNode.id, nodesRef.current, connectionsRef.current);
                const baseContext = buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, retryContextPrompt, assets, promptOnly);
                rawContext =
                    hasSavedImageMetadata && !frame && !baseContext.characterReferences.length
                        ? null
                        : await hydrateNodeGenerationContext(baseContext, projectId, domainProjectId, retryMode, retryMode === "video" && supportsVideoReferenceAudio(generationConfig), !promptOnly);
            } catch (error) {
                const failure = generationFailureMetadata(error, retryPromptSource);
                message.error(failure.errorDetails);
                setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, ...failure } } : item)));
                return;
            }
            let skillMetadata: SkillRuntimeMetadata = {
                skillIds: node.metadata?.skillIds || [],
                skillVersions: node.metadata?.skillVersions || [],
                skillFiles: node.metadata?.skillFiles || [],
            };
            let context = rawContext;
            if (rawContext) {
                try {
                    const skillExecution = await skillRuntime.prepare({
                        profile: "canvas",
                        prompt: rawContext.prompt,
                        skills: addedSkills,
                        selectedSkillIds: isEpisodeStoryboardVideo(sourceNode.id, nodesRef.current, connectionsRef.current) ? undefined : node.metadata?.skillIds,
                    });
                    context = { ...rawContext, prompt: skillExecution.prompt };
                    skillMetadata = skillExecution.metadata;
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "技能上下文加载失败");
                    return;
                }
            }
            const prompt = (frame || context?.characterReferences.length ? context?.prompt || "" : savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!prompt) {
                message.warning("找不到提示词，无法重试");
                return;
            }
            let mediaPrompt = prompt;
            let styleMetadata = {};
            if (node.type === CanvasNodeType.Image) {
                try {
                    const runtime = resolveCanvasStyleExecution(nodesRef.current, sourceNode, prompt, generationConfig, "image");
                    if (runtime) {
                        mediaPrompt = runtime.prompt;
                        styleMetadata = { styleProfileJson: runtime.profileJson, styleExecutionPlan: runtime.plan };
                    }
                } catch (error) {
                    message.error(error instanceof Error ? error.message : "项目画风与当前模型不兼容");
                    return;
                }
            }
            if (retryMode === "audio" && context?.characterReferences.length) {
                if (context.characterReferences.length !== 1) {
                    message.error("角色配音一次只能引用一个角色卡");
                    return;
                }
                const voice = context.resolvedCharacterVoices[0];
                if (!voice) {
                    message.error("角色尚未绑定可用声音，无法重试角色配音任务");
                    return;
                }
                generationConfig = { ...generationConfig, audioVoice: voice.voiceKey, audioInstructions: [voice.instructions, generationConfig.audioInstructions].filter(Boolean).join("；") };
            }
            const generationType = savedImageMetadata?.generationType;
            const isEmotionRetry = Boolean(node.metadata?.emotionEdit);
            if (isEmotionRetry && resolveModelRequestConfig(generationConfig, generationConfig.model).interfaceType !== "openai-image") {
                message.error("表情编辑需要支持蒙版的 OpenAI Images 渠道，当前渠道已拒绝整图重绘");
                return;
            }
            const useReferenceImages = isEmotionRetry ? false : frame ? Boolean(context?.referenceImages.length) : context?.characterReferences.length ? true : generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages = isEmotionRetry
                ? []
                : hasSavedImageMetadata && savedImageMetadata && !frame && !context?.characterReferences.length
                  ? await resolveMetadataReferences(savedImageMetadata)
                  : useReferenceImages
                    ? context?.referenceImages.length
                        ? context.referenceImages
                        : sourceNodeReferenceImages(batchRoot || sourceNode)
                    : [];
            if (useReferenceImages && !retryReferenceImages) {
                markMissingReferences(node.id, setNodes);
                message.error("参考图片已丢失，无法继续重试");
                return;
            }
            const retryImages = retryReferenceImages || [];
            if (retryMode === "image") {
                const referenceLimitError = canvasImageReferenceLimitError(generationConfig, retryImages);
                if (referenceLimitError) {
                    message.error(referenceLimitError);
                    return;
                }
            }
            const storedVideoImages = node.type === CanvasNodeType.Video && !context?.referenceImages.length ? await resolveStoredReferenceImages(node.metadata?.references) : [];
            if (storedVideoImages === null) {
                markMissingReferences(node.id, setNodes);
                message.error("参考图片已丢失，无法继续重试");
                return;
            }
            const videoReferenceImages = context?.referenceImages.length ? context.referenceImages : storedVideoImages;
            const videoContext =
                node.type === CanvasNodeType.Video
                    ? {
                          prompt,
                          referenceImages: videoReferenceImages,
                          referenceVideos: context?.referenceVideos || [],
                          referenceAudios: context?.referenceAudios || [],
                          textCount: context?.textCount || 0,
                          imageCount: videoReferenceImages.length,
                          videoCount: context?.referenceVideos.length || 0,
                          audioCount: context?.referenceAudios.length || 0,
                      }
                    : undefined;

            setRunningNodeId(node.id);
            setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined, generationErrorCode: undefined, resourceReloadAvailable: undefined, failedPromptFingerprint: undefined } } : item)));
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id);
            const retryContext = node.metadata?.taskId ? await createGenerationRetryContext(node.metadata.taskId, node.metadata.attemptGroupId) : {};
            const runAndConsumeRetry = async (input: Parameters<typeof runBackendCanvasGenerationTask>[0]) => {
                if (!frameIsCurrent()) throw new Error("分镜已修改，未提交旧版本画面，请重新生成");
                await runCanvasGenerationTaskToConsumer(
                    { ...input, ...retryContext },
                    {
                        bindTask: (task) => bindGenerationTask(node.id, task),
                        consumeTask: (task) => applyGenerationTaskResult(node.id, task),
                    },
                );
            };

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: node.id,
                        mode: "text",
                        prompt,
                        config: generationConfig,
                        referenceImages: context.referenceImages,
                        referenceVideos: context.referenceVideos,
                        signal: controller.signal,
                        metadata: { retry: true, sourceNodeId: sourceNode.id, resolvedCharacterVersions: context.resolvedCharacterVersions },
                    });
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    const videoGenerationMetadata = buildVideoGenerationMetadata(node, videoContext, generationConfig);
                    setNodes((current) =>
                        current.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      metadata: {
                                          ...item.metadata,
                                          prompt: mediaPrompt,
                                          model: generationConfig.model,
                                          producedModelCandidate: producedModelCandidateForGeneration(generationConfig),
                                          size: generationConfig.size,
                                          seconds: generationConfig.videoSeconds,
                                          vquality: generationConfig.vquality,
                                          generateAudio: generationConfig.videoGenerateAudio,
                                          watermark: generationConfig.videoWatermark,
                                          ...videoGenerationMetadata,
                                          ...styleMetadata,
                                          ...skillMetadata,
                                          references: videoContext ? generationReferenceUrls(videoContext) : item.metadata?.references,
                                      },
                                  }
                                : item,
                        ),
                    );
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: node.id,
                        mode: "video",
                        prompt: mediaPrompt,
                        config: generationConfig,
                        referenceImages: videoContext?.referenceImages || [],
                        referenceVideos: videoContext?.referenceVideos || [],
                        referenceAudios: videoContext?.referenceAudios || [],
                        signal: controller.signal,
                        metadata: {
                            retry: true,
                            sourceNodeId: sourceNode.id,
                            resolvedCharacterVersions: context?.resolvedCharacterVersions || [],
                            resolvedCharacterVoices: context?.resolvedCharacterVoices || [],
                            promptTemplateOperation: node.metadata?.promptTemplateOperation,
                            promptTemplateVariables: node.metadata?.promptTemplateVariables,
                            ...videoGenerationMetadata,
                            ...styleMetadata,
                            ...skillMetadata,
                        },
                    });
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, prompt, ...buildAudioGenerationMetadata(generationConfig) } } : item)));
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: node.id,
                        mode: "audio",
                        prompt,
                        config: generationConfig,
                        signal: controller.signal,
                        metadata: { retry: true, sourceNodeId: sourceNode.id, resolvedCharacterVersions: context?.resolvedCharacterVersions || [], resolvedCharacterVoiceKey: context?.resolvedCharacterVoices[0]?.voiceKey },
                    });
                    return;
                }

                const emotionEdit = node.metadata?.emotionEdit;
                if (emotionEdit) {
                    const emotionSource = nodesRef.current.find((item) => item.id === emotionEdit.sourceNodeId);
                    if (!emotionSource?.metadata?.content) throw new Error("情绪编辑源图片已删除，无法重试");
                    const sourceDataUrl = await resolveImageUrl(emotionSource.metadata.storageKey, emotionSource.metadata.content, { cacheMiss: true });
                    if (!sourceDataUrl) throw new Error("无法读取情绪编辑源图片");
                    const artifacts = await buildEmotionImageArtifacts(sourceDataUrl, emotionEdit.faceBox, emotionSource.metadata.naturalWidth || 0, emotionSource.metadata.naturalHeight || 0);
                    const emotionConfig = { ...generationConfig, size: emotionGenerationSize(artifacts.editRegion), quality: !generationConfig.quality || generationConfig.quality === "auto" ? "high" : generationConfig.quality };
                    const imageProfile = modelCapabilityConfigFor(emotionConfig, emotionConfig.model).image!;
                    const editPlan = resolveEmotionEditPlan(imageProfile.references.maskSupported);
                    const sourceReference = sourceNodeReferenceImages(emotionSource)[0];
                    if (!sourceReference) throw new Error("情绪编辑源图片不可用");
                    const editReference = { id: `${emotionSource.id}-${emotionEdit.presetId}-edit-region`, name: "emotion-edit-region.png", type: "image/png", dataUrl: artifacts.sourceDataUrl };
                    const characterReference = { id: `${emotionSource.id}-${emotionEdit.presetId}-character`, name: `${emotionEdit.characterName}-face.jpg`, type: "image/jpeg", dataUrl: artifacts.characterDataUrl };
                    const nextEmotionEdit = { ...emotionEdit, editRegion: artifacts.editRegion, sourceWidth: artifacts.imageWidth, sourceHeight: artifacts.imageHeight, providerSize: emotionConfig.size, editMode: editPlan.mode };
                    const providerPrompt = normalizeEmotionPromptForProvider(mediaPrompt);
                    const mask = emotionProviderMask(editPlan, { id: `${emotionSource.id}-emotion-mask`, name: "emotion-mask.png", type: "image/png", dataUrl: artifacts.maskDataUrl });
                    if (editPlan.notice) message.info(editPlan.notice);
                    const generationMetadata = { ...buildImageGenerationMetadata("edit", emotionConfig, 1, [sourceReference]), size: `${artifacts.imageWidth}x${artifacts.imageHeight}` };
                    setNodes((current) =>
                        current.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      metadata: { ...item.metadata, prompt: providerPrompt, ...generationMetadata, ...styleMetadata, ...skillMetadata, emotionEdit: nextEmotionEdit },
                                  }
                                : item,
                        ),
                    );
                    await runAndConsumeRetry({
                        projectId,
                        nodeId: node.id,
                        mode: "image",
                        prompt: providerPrompt,
                        config: emotionConfig,
                        referenceImages: [editReference, characterReference],
                        mask,
                        signal: controller.signal,
                        metadata: { retry: true, sourceNodeId: emotionSource.id, edit: "emotion", emotionEditMode: editPlan.mode, emotion: nextEmotionEdit, resolvedCharacterVersions: context?.resolvedCharacterVersions || [], ...styleMetadata, ...skillMetadata },
                    });
                    return;
                }

                const generationMetadata = savedImageMetadata?.generationType && !frame
                    ? {
                          generationType: savedImageMetadata.generationType,
                          model: generationConfig.model,
                          producedModelCandidate: producedModelCandidateForGeneration(generationConfig),
                          size: generationConfig.size,
                          quality: generationConfig.quality,
                          transparentBackground: generationConfig.transparentBackground,
                          count: savedImageMetadata.count || 1,
                          references: savedImageMetadata.references,
                          ...generationWorkflowMetadata(generationConfig),
                      }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((current) =>
                    current.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: { ...item.metadata, prompt: mediaPrompt, ...generationMetadata, ...styleMetadata, ...skillMetadata },
                              }
                            : item,
                    ),
                );
                await runAndConsumeRetry({
                    projectId,
                    nodeId: node.id,
                    mode: "image",
                    prompt: mediaPrompt,
                    config: generationConfig,
                    referenceImages: useReferenceImages ? retryImages : [],
                    signal: controller.signal,
                    metadata: {
                        retry: true,
                        sourceNodeId: sourceNode.id,
                        resolvedCharacterVersions: context?.resolvedCharacterVersions || [],
                        promptTemplateOperation: node.metadata?.promptTemplateOperation,
                        promptTemplateVariables: node.metadata?.promptTemplateVariables,
                        ...styleMetadata,
                        ...skillMetadata,
                    },
                });
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const failure = generationFailureMetadata(error, retryPromptSource);
                message.error(failure.errorDetails);
                setNodes((current) => current.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, ...failure } } : item)));
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        },
        [addedSkills, applyGenerationTaskResult, assets, bindGenerationTask, connectionsRef, domainProjectId, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, modal, nodesRef, projectId, retryTask, setNodes, setRunningNodeId, startGenerationRequest],
    );
    return useCallback(async (node: CanvasNodeData, options?: CanvasNodeRetryOptions) => {
        if (pendingRetries.current.has(node.id)) return;
        pendingRetries.current.add(node.id);
        try {
            await runRetry(node, options);
        } finally {
            pendingRetries.current.delete(node.id);
        }
    }, [runRetry]);
}

// 生成类型必须由明确的节点契约决定，未知节点不能降级成图片任务。
function retryModeForNode(type: CanvasNodeTypeId): CanvasNodeGenerationMode | null {
    if (type === CanvasNodeType.Text) return "text";
    if (type === CanvasNodeType.Image) return "image";
    if (type === CanvasNodeType.Video) return "video";
    if (type === CanvasNodeType.Audio) return "audio";
    return null;
}

function markMissingReferences(nodeId: string, setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>) {
    setNodes((current) => current.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: "参考图片已丢失，无法继续重试" } } : item)));
}
