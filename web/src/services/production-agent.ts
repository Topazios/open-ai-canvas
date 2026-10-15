import { createAgentRun, getAgentProfile, type CreateAgentRunInput } from "./api/agent";
import { logicalModelIDForConfig, modelOptionName, resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";
import { normalizeReasoningEffort } from "@/lib/reasoning-effort";

export async function prepareProductionAgent(canvasId: string, node: CanvasNodeData, config: AiConfig): Promise<CreateAgentRunInput> {
    const data = node.metadata?.shortDrama;
    if (!data?.productionAgent || !data.operationId) throw new Error("制作 Agent 缺少任务参数");
    if (data.productionAgent.request) return data.productionAgent.request;
    const selectedModel = node.metadata?.model || "";
    const selectedConfig = { ...config, model: selectedModel };
    const resolved = resolveModelRequestConfig(selectedConfig, selectedModel);
    const logicalModelId = logicalModelIDForConfig(selectedConfig);
    if (!logicalModelId && !resolved.channelId) throw new Error("制作 Agent 需要支持工具调用的后端受管文本模型");
    const profile = await getAgentProfile({ canvasId });
    return { canvasId, prompt: node.metadata?.prompt || "执行资产提取并检查覆盖", production: { targetNodeId: node.id },
        model: modelOptionName(selectedModel), reasoningEffort: normalizeReasoningEffort(node.metadata?.reasoningEffort ?? config.textReasoningEffort), profileRevision: profile.revision, permissionMode: "auto", contextScope: [],
        ...(logicalModelId ? { logicalModelId } : { channelId: resolved.channelId, channelModelKey: modelOptionName(selectedModel) }),
        budget: { maxGenerationTasks: 0 },
        idempotencyKey: data.operationId };
}

export const submitProductionAgent = createAgentRun;
