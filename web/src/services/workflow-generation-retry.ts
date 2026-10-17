import type { CanvasNodeData } from "@/types/canvas";
import type { AiConfig } from "@/stores/use-config-store";
import { createGenerationRetryContext } from "@/lib/canvas/canvas-project-generation";
import { prepareBackendGenerationTask } from "@/services/api/generation-task";
import { createGenerationTask, queryGenerationTask, retryGenerationTask, type GenerationTask } from "@/services/api/task-center";
import { workflowImageReferences } from "@/lib/canvas/canvas-workflow-images";
import { workflowGenerationSources, workflowBodyTaskInput } from "@/lib/canvas/canvas-short-drama-workflow";
import { generationPromptFingerprint, isContentModerationError } from "@/lib/generation-error";
import { rebuildWorkflowImagePrompt } from "@/lib/canvas/canvas-image-prompt-adjustment";
import { applyProductionRules } from "@/lib/production-rules";

const dependencies = { create: createGenerationTask, query: queryGenerationTask, retry: retryGenerationTask, prepare: prepareBackendGenerationTask };

function retryIdentity(task: GenerationTask) {
    // The backend exposes these identifiers in sanitized input metadata.
    let metadata: Record<string, unknown> = {};
    if (task.inputJson) {
        try { metadata = JSON.parse(task.inputJson)?.metadata || {}; }
        catch { throw new Error("无法读取原任务的重试信息，请在任务中心核对"); }
    }
    return {
        retryOf: task.retryOf || (typeof metadata.retryOf === "string" ? metadata.retryOf : undefined),
        attemptGroupId: task.attemptGroupId || (typeof metadata.attemptGroupId === "string" ? metadata.attemptGroupId : undefined),
    };
}

// Workflow prompts may contain only instructions: the durable batch owns the prose.
export async function retryWorkflowGeneration(node: CanvasNodeData, source: GenerationTask | undefined, projectId: string, config: AiConfig, api = dependencies, nodes: CanvasNodeData[] = [node], retryTask = api.retry) {
    const data = node.metadata?.shortDrama;
    if (!data) throw new Error("节点缺少流程信息");
    if (data.productionAgent) throw new Error("制作 Agent 请通过原作业继续，不能降级为普通文本重试");
    let original = source;
    let rebuiltPrompt: string | undefined;
    const visited = new Set<string>();
    while (data.textBatch && original && original.operation !== "short_drama_batch") {
        const prior = retryIdentity(original).retryOf;
        if (!prior) break;
        if (visited.has(original.id) || visited.size >= 64) throw new Error("重试链异常，请在任务中心核对原分批任务");
        visited.add(original.id);
        original = await api.query(prior);
    }
    if (original && (!data.textBatch || original.operation === "short_drama_batch")) {
        if (original.status === "queued" || original.status === "running") return original;
        if (original.status === "failed" || original.status === "cancelled") {
            const moderated = isContentModerationError(original.errorCode) || isContentModerationError(original.error);
            const revised = node.metadata?.prompt?.trim();
            if (!moderated && data.step !== "story.body") {
                if (original.canRecoverMedia || original.mediaStage) return retryTask(original.id);
                if (data.mediaKind !== "image" || !revised || !original.prompt) return retryTask(original.id);
                const normalize = (value: string) => applyProductionRules(value, data.stage, "image");
                const unchanged = generationPromptFingerprint(normalize(revised)) === generationPromptFingerprint(normalize(original.prompt));
                // Rebuild generated requests against their pinned source versions.
                // A manual prompt edit remains authoritative and uses a new attempt.
                if (unchanged && data.assetSheet) {
                    // Older snapshots have no generated baseline; do not guess
                    // whether the user edited them before their first submission.
                    if (!data.assetSheet.promptFingerprint || generationPromptFingerprint(revised) !== data.assetSheet.promptFingerprint) return retryTask(original.id);
                    rebuiltPrompt = rebuildWorkflowImagePrompt(node, nodes);
                }
                else if (unchanged) return retryTask(original.id);
                else rebuiltPrompt = revised;
                if (generationPromptFingerprint(normalize(rebuiltPrompt!)) === generationPromptFingerprint(normalize(original.prompt))) return retryTask(original.id);
            }
            if (moderated && (!revised || !original.prompt || generationPromptFingerprint(revised) === generationPromptFingerprint(original.prompt))) {
                throw new Error("内容审核未通过，请先修改生成要求，不能原样重试");
            }
            if (data.mediaKind !== "image" && data.step !== "story.body") throw new Error("请在原制作步骤修改生成要求后重新提交");
        }
    }
    const prompt = rebuiltPrompt || node.metadata?.prompt?.trim();
    if (!prompt) throw new Error("节点缺少生成要求，请从前置节点重新发起");
    if (data.step !== "story.body" && data.textBatch && !data.textBatch.units.some((unit) => unit.text.trim())) throw new Error("分批任务缺少正文，未提交生成");
    const retry = source ? await createGenerationRetryContext(source.id, retryIdentity(source).attemptGroupId) : { clientOperationId: data.operationId };
    if (!retry.clientOperationId) throw new Error("节点缺少提交标识，请从前置节点重新发起");
    const mode = data.mediaKind === "image" ? "image" : "text";
    if (mode === "image") workflowGenerationSources(data, nodes);
    const textInput = workflowBodyTaskInput(node, nodes);
    const input = await api.prepare({ projectId, mode, prompt: mode === "text" ? textInput.prompt : prompt, workflowBatch: mode === "text" ? textInput.workflowBatch : undefined,
        referenceImages: mode === "image" ? workflowImageReferences(node, nodes) : undefined,
        reasoningEffort: mode === "text" ? node.metadata?.reasoningEffort || "medium" : undefined,
        config: { ...config, model: node.metadata!.model || config[`${mode}Model`] || config.model,
            ...(mode === "image" ? { size: node.metadata?.size || config.size, quality: node.metadata?.quality || config.quality, transparentBackground: node.metadata?.transparentBackground || "false", count: "1" } : {}) }, streamText: mode === "text" && !textInput.workflowBatch, ...retry,
        metadata: { source: "canvas-short-drama-workflow", nodeId: node.id, pipelineId: data.pipelineId, workflowStage: data.stage, workflowStep: data.step, episodeNumber: data.episodeNumber } });
    return api.create(input);
}
