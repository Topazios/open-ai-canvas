import { CanvasNodeType, StoryboardFrameKind, type CanvasNodeData } from "@/types/canvas";
import { storyboardFrameHash, storyboardFrameIsCurrent, storyboardReferenceSignature } from "./workflow-episode-storyboard";

const FRAME_WAIT_REASONS = new Set([
    "等待当前镜头首帧，先生成或恢复首尾帧",
    "首帧不存在，请先恢复当前镜头首帧",
    "首帧生成失败，请先重试首帧",
    "首帧已暂停，请先继续首帧",
    "等待首帧完成后保持画面一致性",
]);

/** Resolve from the current shot, never from a similarly named image in another version. */
export function storyboardFramePrerequisite(node: CanvasNodeData, nodes: CanvasNodeData[]): { ready: boolean; reason: string; waiting?: boolean; reference?: CanvasNodeData } {
    const binding = node.metadata?.storyboardFrame;
    if (!binding) return { ready: true, reason: "" };
    const script = nodes.find(item => item.id === binding.scriptId);
    const row = script?.metadata?.storyboard?.rows.find(item => item.id === binding.rowId);
    if (!row || storyboardFrameHash(row) !== binding.sourcePromptHash) return { ready: false, reason: "分镜已修改，请生成当前版本的画面" };
    const frame = row.frames?.find(item => item.id === binding.frameId && item.imageNodeId === node.id);
    if (!frame) return { ready: false, reason: "画面已不属于当前分镜版本，请从分镜列表重新生成" };
    if (frame.kind === StoryboardFrameKind.Start) return { ready: true, reason: "" };
    const start = row.frames?.find(item => item.kind === StoryboardFrameKind.Start);
    if (!start || !storyboardFrameIsCurrent(row, start, nodes)) return { ready: false, waiting: true, reason: "等待当前镜头首帧，先生成或恢复首尾帧" };
    const reference = nodes.find(item => item.id === start.imageNodeId && item.type === CanvasNodeType.Image);
    if (!reference || reference.id === node.id) return { ready: false, waiting: true, reason: "首帧不存在，请先恢复当前镜头首帧" };
    if (reference.metadata?.taskStatus === "cancelled") return { ready: false, waiting: true, reason: "首帧已暂停，请先继续首帧" };
    if (reference.metadata?.status === "error" || reference.metadata?.taskStatus === "failed") return { ready: false, waiting: true, reason: "首帧生成失败，请先重试首帧" };
    if (!(reference.metadata?.content || reference.metadata?.storageKey) || reference.metadata.status === "loading") return { ready: false, waiting: true, reason: "等待首帧完成后保持画面一致性" };
    return { ready: true, reason: "", reference };
}

/** Recover continuity placeholders; receipts and live/cancelled tasks stay bound. */
export function storyboardFrameWaitingReason(node: CanvasNodeData, nodes: CanvasNodeData[]): string | undefined {
    const metadata = node.metadata;
    if (!metadata?.storyboardFrame || metadata.taskReceiptRecorded || metadata.content || metadata.storageKey) return undefined;
    const binding = metadata.storyboardFrame;
    const row = nodes.find(item => item.id === binding.scriptId)?.metadata?.storyboard?.rows.find(item => item.id === binding.rowId);
    if (row?.frames?.find(frame => frame.id === binding.frameId)?.kind === StoryboardFrameKind.Start) return undefined;
    const dependencyError = FRAME_WAIT_REASONS.has(metadata.errorDetails || "");
    if (metadata.taskStatus && metadata.taskStatus !== "failed") return undefined;
    if ((metadata.taskId || metadata.taskStatus) && !dependencyError) return undefined;
    if (metadata.status === "error" && !dependencyError) return undefined;
    const dependency = storyboardFramePrerequisite(node, nodes);
    return dependency.waiting ? dependency.reason : dependency.ready && dependencyError ? "" : undefined;
}

export function storyboardContinuityReference(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const dependency = storyboardFramePrerequisite(node, nodes);
    if (!dependency.ready) throw new Error(dependency.reason);
    return dependency.reference;
}

export function storyboardContinuitySnapshot(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const reference = storyboardContinuityReference(node, nodes);
    return reference ? { nodeId: reference.id, signature: storyboardReferenceSignature(reference) } : undefined;
}

export function storyboardContinuityPrompt(reference: CanvasNodeData) {
    return `【当前镜头连续性参考】@[node:${reference.id}] 是本镜头首帧，作为人物、服装、道具、环境与画风的连续性基准。保持同一人物的面部骨相、年龄感、体型、发色发型；保持当场衣服的款式、颜色、材质与配饰，沿用同一物件的形状、尺度和细节，以及同一空间的固定陈设、材质、光线方向和色调。资产设定板用于补足不可见细节，不重新从多套造型中选择服装，不把设定板构图复制进剧情画面。只改变当前时间点明确发生的动作、表情、持物状态、站位和机位；明确写出的换装、时间或场景变化只解除对应项，人物身份及其他未变化项继续保持。不要照抄首帧动作，严格呈现目标时刻。`;
}
