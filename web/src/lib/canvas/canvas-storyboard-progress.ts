import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type StoryboardRow, type StoryboardVideoGeneration } from "@/types/canvas";

export type StoryboardPipelineItemState = "missing" | "idle" | "loading" | "success" | "error";

export type StoryboardPipelineStage = {
    total: number;
    created: number;
    success: number;
    failed: number;
    loading: number;
    incomplete: number;
    nodeIds: string[];
};

export type StoryboardPipelineRow = {
    row: StoryboardRow;
    imageNode?: CanvasNodeData;
    imageState: StoryboardPipelineItemState;
    videoNode?: CanvasNodeData;
    videoGeneration?: StoryboardVideoGeneration;
    videoState: StoryboardPipelineItemState;
};

export type CanvasStoryboardPipelineProgress = {
    rows: StoryboardPipelineRow[];
    images: StoryboardPipelineStage;
    videos: StoryboardPipelineStage;
    final: StoryboardPipelineStage;
    successfulVideoNodeIds: string[];
    finalNodeIds: string[];
};

export function deriveStoryboardPipelineProgress(scriptNode: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasStoryboardPipelineProgress {
    const rows = scriptNode.metadata?.storyboard?.rows || [];
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const pipelineRows = rows.map((row): StoryboardPipelineRow => {
        const imageNode = row.imageNodeId ? nodeById.get(row.imageNodeId) : undefined;
        const videoNode = row.videoNodeId ? nodeById.get(row.videoNodeId) : undefined;
        const videoGeneration = row.videoGeneration;
        return {
            row,
            imageNode: imageNode?.type === CanvasNodeType.Image ? imageNode : undefined,
            imageState: nodePipelineState(imageNode, CanvasNodeType.Image),
            videoNode: videoNode?.type === CanvasNodeType.Video ? videoNode : undefined,
            videoGeneration,
            videoState: storyboardVideoState(videoGeneration, videoNode),
        };
    });
    const imageNodes = pipelineRows.flatMap((item) => item.imageNode ? [item.imageNode] : []);
    const videoNodes = pipelineRows.flatMap((item) => item.videoNode ? [item.videoNode] : []);
    const videoNodeIds = new Set(videoNodes.map((node) => node.id));
    const linkedFinalNodes = nodes.filter((node) => node.type === CanvasNodeType.Video
        && node.metadata?.workflowKind === "final"
        && connections.some((connection) => connection.toNodeId === node.id && (connection.fromNodeId === scriptNode.id || videoNodeIds.has(connection.fromNodeId))));
    const successfulVideoNodeIds = pipelineRows.flatMap((item) => item.videoState === "success" && item.videoNode ? [item.videoNode.id] : []);
    return {
        rows: pipelineRows,
        images: summarizeStage(pipelineRows.map((item) => ({ state: item.imageState, node: item.imageNode })), rows.length),
        videos: summarizeStage(pipelineRows.map((item) => ({ state: item.videoState, node: item.videoNode, created: Boolean(item.videoGeneration || item.videoNode) })), rows.length),
        final: summarizeFinalStage(linkedFinalNodes, rows.length > 0 || linkedFinalNodes.length > 0),
        successfulVideoNodeIds,
        finalNodeIds: linkedFinalNodes.map((node) => node.id),
    };
}

function nodePipelineState(node: CanvasNodeData | undefined, expectedType: CanvasNodeType): StoryboardPipelineItemState {
    if (!node || node.type !== expectedType) return "missing";
    if (node.metadata?.status === "success" && node.metadata.content) return "success";
    if (node.metadata?.status === "loading") return "loading";
    if (node.metadata?.status === "error") return "error";
    return "idle";
}

function storyboardVideoState(generation: StoryboardVideoGeneration | undefined, legacyNode: CanvasNodeData | undefined): StoryboardPipelineItemState {
    if (generation) {
        if (generation.taskStatus === "succeeded" && (generation.content || generation.storageKey)) return "success";
        if (generation.taskStatus === "failed") return "error";
        if (generation.taskStatus === "queued" || generation.taskStatus === "running") return "loading";
        if (generation.taskStatus === "cancelled") return "idle";
    }
    return nodePipelineState(legacyNode, CanvasNodeType.Video);
}

function summarizeStage(items: Array<{ state: StoryboardPipelineItemState; node?: CanvasNodeData; created?: boolean }>, total: number): CanvasStoryboardPipelineProgress["images"] {
    const success = items.filter((item) => item.state === "success").length;
    const failed = items.filter((item) => item.state === "error").length;
    const loading = items.filter((item) => item.state === "loading").length;
    const created = items.filter((item) => item.created ?? Boolean(item.node)).length;
    return {
        total,
        created,
        success,
        failed,
        loading,
        incomplete: Math.max(0, total - success),
        nodeIds: items.flatMap((item) => item.node ? [item.node.id] : []),
    };
}

function summarizeFinalStage(nodes: CanvasNodeData[], enabled: boolean): StoryboardPipelineStage {
    if (!enabled) return { total: 0, created: 0, success: 0, failed: 0, loading: 0, incomplete: 0, nodeIds: [] };
    const states = nodes.map((node) => nodePipelineState(node, CanvasNodeType.Video));
    const success = states.includes("success") ? 1 : 0;
    const loading = success ? 0 : states.includes("loading") ? 1 : 0;
    const failed = success || loading ? 0 : states.includes("error") ? 1 : 0;
    return {
        total: 1,
        created: nodes.length ? 1 : 0,
        success,
        failed,
        loading,
        incomplete: success ? 0 : 1,
        nodeIds: nodes.map((node) => node.id),
    };
}

export function pipelineStatusLabel(stage: StoryboardPipelineStage) {
    if (!stage.total) return "待开始";
    if (stage.success >= stage.total) return "已完成";
    if (stage.loading) return `${stage.success}/${stage.total} · 进行中`;
    if (stage.failed) return `${stage.success}/${stage.total} · 失败 ${stage.failed}`;
    if (stage.created) return `${stage.success}/${stage.total} · 已创建 ${stage.created}`;
    return `0/${stage.total}`;
}
