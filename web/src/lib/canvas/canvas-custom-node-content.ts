import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function hasCanvasCustomNodeContent(node: CanvasNodeData, isEditingContent = false) {
    return node.type === CanvasNodeType.Config || node.type === CanvasNodeType.Script || node.type === CanvasNodeType.BatchTable ||
        (!isEditingContent && node.type === CanvasNodeType.Text && ["story.body", "story.audit"].includes(node.metadata?.shortDrama?.step || "") && Boolean(node.metadata?.content?.trim()) && node.metadata?.status !== "loading") ||
        Boolean(node.metadata?.directorSceneId) ||
        (node.metadata?.workflowKind === "character" && Boolean(node.metadata.characterAssetId)) ||
        (node.metadata?.workflowKind === "story_input" && !isEditingContent) ||
        (node.metadata?.workflowKind === "styleboard" && !node.metadata.content);
}
