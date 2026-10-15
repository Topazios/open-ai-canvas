import type { CanvasNodeShotLink, CanvasNodeShotView } from "@/services/api/projects";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasShotBinding = { link: CanvasNodeShotLink; view?: CanvasNodeShotView; unavailable: boolean };

export const canvasShotStateLabels: Record<CanvasNodeShotView["state"], string> = {
    current: "已关联", node_missing: "节点已删除或无效", unit_missing: "章节关系已失效",
    shot_missing: "镜头已删除", revision_missing: "关联修订已失效", shot_revised: "镜头已修订，需复核",
    artifact_changed: "产物已换版，需复核", node_type_changed: "节点类型已变化，需复核", resource_unavailable: "产物资源不可用",
};

export function canvasShotBindingLabel(binding: CanvasShotBinding) {
    return binding.unavailable || !binding.view ? "项目内容暂不可用" : canvasShotStateLabels[binding.view.state];
}

// Projection data is supplied only to renderers. Never pass it to canvas saving or commands.
export function canvasShotMediaNode(node: CanvasNodeData, binding: CanvasShotBinding): CanvasNodeData | null {
    const view = binding.view;
    const artifact = view?.artifact;
    if (binding.unavailable || view?.state !== "current" || !view.resourceAvailable || !artifact?.resourceId
        || view.linkId !== binding.link.id || artifact.id !== binding.link.artifactId || artifact.shotId !== binding.link.shotId
        || artifact.revisionId !== binding.link.shotRevisionId || !artifact.selected || artifact.status !== "ready") return null;
    const type = artifact.type === "audio" ? "audio" : ["video", "delivery"].includes(artifact.type) ? "video"
        : ["storyboard", "action_board", "start_frame", "end_frame"].includes(artifact.type) ? "image" : null;
    if (!type || type !== node.type) return null;
    return { ...node, title: view.shotTitle || node.title, metadata: { storageKey: `resource:${artifact.resourceId}`, status: "success" } };
}
