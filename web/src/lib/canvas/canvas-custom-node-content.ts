import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function hasCanvasCustomNodeContent(node: CanvasNodeData, isEditingContent = false) {
    return node.type === CanvasNodeType.Config || node.type === CanvasNodeType.Script || node.type === CanvasNodeType.BatchTable ||
        Boolean(node.metadata?.directorSceneId) ||
        (node.metadata?.workflowKind === "character" && Boolean(node.metadata.characterAssetId)) ||
        (node.metadata?.workflowKind === "story_input" && !isEditingContent) ||
        (node.metadata?.workflowKind === "styleboard" && !node.metadata.content);
}
