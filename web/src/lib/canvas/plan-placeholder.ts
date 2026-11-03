import type { CanvasNodeData } from "@/types/canvas";

// 后端预建文档占位时写入的正文，与 production_plan_groups.go 保持一致。
export const PLAN_PLACEHOLDER_TEXT = "等待生成";

// 正文仍是占位文本的节点：即使 planGeneration 在合并或规范化中丢失，也不能当作已完成文档。
export function isPlanPlaceholderContent(node: Pick<CanvasNodeData, "metadata"> | null | undefined) {
    return node?.metadata?.status !== "success" && node?.metadata?.content?.trim() === PLAN_PLACEHOLDER_TEXT;
}

// 制作方案容器创建时由后端预建的文档占位，文稿保存前一直带有 planGeneration。
export function isPlanPlaceholder(node: Pick<CanvasNodeData, "metadata"> | null | undefined) {
    return !!node?.metadata?.shortDrama?.planGeneration || isPlanPlaceholderContent(node);
}