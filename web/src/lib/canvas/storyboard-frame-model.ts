import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { buildGenerationConfig } from "./canvas-project-generation";
import { synchronizeGenerationSpec } from "./generation-contract";
import { isCanvasNodeGenerating } from "./canvas-node-task-state";

export function storyboardFrameGenerationConfig(config: AiConfig, script: CanvasNodeData | undefined, kind: "text" | "image") {
    const model = script?.metadata?.storyboard?.frameModels?.[kind];
    return buildGenerationConfig(config, model && script ? { ...script, type: kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Text, metadata: { model } } : undefined, kind);
}

export function storyboardFrameNodeSelection(config: AiConfig, node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const frame = node.metadata?.storyboardFrame;
    if (!frame) return node;
    const script = nodes.find(item => item.id === frame.scriptId);
    if (!script?.metadata?.storyboard) throw new Error("分镜列表已删除，不能提交孤立画面任务");
    return synchronizeGenerationSpec(node, { model: storyboardFrameGenerationConfig(config, script, "image").model });
}

export function selectStoryboardFrameModel(nodes: CanvasNodeData[], scriptId: string, kind: "text" | "image", model: string) {
    const submitting = new Set(nodes.flatMap(node => (node.metadata?.generationBatches || []).flatMap(batch =>
        batch.items.filter(item => ["submitting", "queued", "running"].includes(item.status)).map(item => item.nodeId))));
    return nodes.map(node => {
        if (node.id === scriptId && node.metadata?.storyboard) return { ...node, metadata: { ...node.metadata,
            storyboard: { ...node.metadata.storyboard, frameModels: { ...node.metadata.storyboard.frameModels, [kind]: model } } } };
        const owner = kind === "image" ? node.metadata?.storyboardFrame : node.metadata?.storyboardFramePlan;
        if (owner?.scriptId !== scriptId || node.type !== (kind === "image" ? CanvasNodeType.Image : CanvasNodeType.Text)
            || node.metadata?.content || node.metadata?.storageKey || node.metadata?.taskStatus === "succeeded"
            || node.metadata?.taskMediaStage || node.metadata?.taskCanRecoverMedia || submitting.has(node.id) || isCanvasNodeGenerating(node)) return node;
        return synchronizeGenerationSpec(node, { model });
    });
}
