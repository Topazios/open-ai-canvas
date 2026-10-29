import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { isCanvasImageSourceNode } from "@/lib/canvas/canvas-image-source";

/** 重绘弹窗是否提供"提示词"页：已有图片、不是输入素材，且不是故事推演或非图片类短剧节点。 */
export function canRegenerateImagePrompt(node: CanvasNodeData | null | undefined): boolean {
    if (!node || node.type !== CanvasNodeType.Image) return false;
    return Boolean(node.metadata?.content)
        && !isCanvasImageSourceNode(node)
        && (!node.metadata?.shortDrama || node.metadata.shortDrama.mediaKind === "image")
        && !node.metadata?.storyDevelopment;
}

/** 提示词页的整体重新生成是否能直接在弹窗里完成（目前仅短剧资产节点）；否则只能转去节点输入框。 */
export function canRegenerateImageInDialog(node: CanvasNodeData | null | undefined): boolean {
    return canRegenerateImagePrompt(node) && Boolean(node?.metadata?.shortDrama);
}

/** 自动调整仅支持带设定板规则的节点。 */
export function canAutoAdjustImagePrompt(node: CanvasNodeData | null | undefined): boolean {
    return canRegenerateImageInDialog(node) && Boolean(node?.metadata?.shortDrama?.assetSheet);
}

/** 失败的短剧图片节点（无论是否已有图片或已上传）：重绘弹窗用于改提示词后重新生成。 */
export function canRedrawFailedImage(node: CanvasNodeData | null | undefined): boolean {
    if (!node || node.type !== CanvasNodeType.Image) return false;
    return node.metadata?.status === "error"
        && node.metadata?.shortDrama?.mediaKind === "image"
        && (!isCanvasImageSourceNode(node) || Boolean(node.metadata?.taskId))
        && !node.metadata?.storyDevelopment;
}

export function readImageNodePrompt(node: CanvasNodeData | null | undefined): string {
    return node?.metadata?.prompt || node?.metadata?.composerContent || "";
}
