import type { CanvasNodeData } from "@/types/canvas";

const LEGACY_FRAME_STEPS = new Set(["direction.start_frame", "direction.end_frame", "direction.keyframes"]);

export function isLegacyStoryboardFrameMedia(node: CanvasNodeData) {
    const workflow = node.metadata?.shortDrama;
    if (!workflow) return false;
    return node.type === "image" && workflow.stage === "storyboard" && workflow.mediaKind === "image" && LEGACY_FRAME_STEPS.has(workflow.step) && Boolean(workflow.mediaShotId);
}

export function isLegacyStoryboardFrameContainer(node: CanvasNodeData) {
    const workflow = node.metadata?.shortDrama;
    if (!workflow) return false;
    return node.type === "frame" && Boolean(workflow.mediaGroup) && workflow.stage === "storyboard" && LEGACY_FRAME_STEPS.has(workflow.step);
}

/** Frame task records belong to storyboard rows, never to the canvas surface. */
export function isStoryboardFrameRecord(node: CanvasNodeData) {
    return Boolean(node.metadata?.storyboardFrame || node.metadata?.storyboardFramePlan || node.metadata?.storyboardFramesGroup || isLegacyStoryboardFrameMedia(node) || isLegacyStoryboardFrameContainer(node));
}
