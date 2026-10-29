import type { AgentRun, CreateAgentRunInput } from "@/services/api/agent";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canvasNodeWarning } from "../execution-warning";
import { productionRunExternalFailure } from "./production-agent-journal";

/** A task can target a root node or a node inside a workflow container. */
export function productionAgentNodePresent(nodes: CanvasNodeData[], nodeId?: string) {
    if (!nodeId) return false;
    const node = nodes.find((entry) => entry.id === nodeId);
    if (!node) return false;
    return !node.parentId || nodes.some((entry) => entry.id === node.parentId);
}

type ProductionTaskState = { active: boolean; failed: boolean; complete: boolean; warning?: boolean };

export function productionTaskState(node?: CanvasNodeData, run?: AgentRun): ProductionTaskState {
    const metadata = node?.metadata;
    const data = metadata?.shortDrama;
    const progress = run?.production;
    if (run && progress && run.id === data?.productionAgent?.runId && progress.targetNodeId === node?.id) {
        const failed = ["failed", "rejected"].includes(run.status) && productionRunExternalFailure(run.events, run.id);
        return {
            active: ["running", "queued"].includes(run.status) && !progress.paused,
            failed,
            complete: run.status === "completed",
        };
    }
    return {
        active: metadata?.status === "loading",
        failed: metadata?.status === "error" || (!canvasNodeWarning(metadata) && Boolean(metadata?.errorDetails)),
        complete: metadata?.status === "success" && Boolean(data?.materializedTaskId || data?.productionAgent?.runId),
        ...(canvasNodeWarning(metadata) ? { warning: true } : {}),
    };
}

export function productionPlanAssetAction(node: CanvasNodeData, run?: AgentRun) {
    const data = node.metadata?.shortDrama;
    if (data?.step !== "story.plan" || data.planGroup || (data.role !== "collection" && data.assetKey !== "$summary")) return undefined;
    const targetNodeId = data.role === "collection" ? data.assetGroup?.manifestId : node.id;
    const progress = targetNodeId && run?.production?.targetNodeId === targetNodeId ? run?.production : undefined;
    const ready = progress?.assetGenerationReady === true || (progress?.assetGenerationReady === undefined && progress?.planReady === true && (progress.assetsStarted || (run?.status === "completed" && progress.validated)) && (progress.assetTotal || 0) > 0);
    return { targetNodeId, ready, reason: ready ? "选择资产类别，Agent 将依据制作方案拆解并生成" : "请先保存制作方案的故事总纲" };
}

export function productionPlanNeedsContinuation(run?: AgentRun) {
    const progress = run?.production;
    return Boolean(run?.status === "completed" && progress?.workKind === "plan" && !progress.assetsStarted &&
        (progress.documentTotal || 0) > 0 && (progress.documentCount || 0) < progress.documentTotal!);
}

export function productionPlanAssetSelectorVisible(run?: AgentRun) {
    const progress = run?.production;
    return progress?.workKind === "plan" && (progress.assetGenerationReady === true || (progress.assetGenerationReady === undefined && progress.planReady === true && (progress.assetTotal || 0) > 0));
}

export function productionPlanCanvasNeedsRefresh(nodes: CanvasNodeData[], run: AgentRun) {
    const progress = run.production;
    if (progress?.workKind !== "plan" || !progress.targetNodeId || !Number.isSafeInteger(progress.documentCount) || progress.documentCount! < 1) return false;
    const target = nodes.find(node => node.id === progress.targetNodeId);
    const frame = target?.parentId ? nodes.find(node => node.id === target.parentId) : undefined;
    if (!target || !frame || frame.type !== CanvasNodeType.Frame) return false;
    const frameData = frame.metadata?.shortDrama;
    if (frameData?.role !== "collection" || frameData.step !== "story.plan") return false;
    const sourceIds = new Set(frameData.sourceNodeIds || []);
    const projectedDocuments = nodes.filter(node => {
        const data = node.metadata?.shortDrama;
        const belongsToFrame = node.parentId === frame.id || (!node.parentId && sourceIds.has(node.id));
        return belongsToFrame && node.id !== target.id && node.type !== CanvasNodeType.Frame &&
            data?.step === "story.plan" && data.role === "document" && data.assetKey !== "$summary" &&
            (typeof data.planSection === "string" || data.planVersion === undefined);
    }).length;
    return projectedDocuments < progress.documentCount!;
}

export function hasMissingCompletedProductionOutput(localNodes: CanvasNodeData[], remoteNodes: CanvasNodeData[]) {
    const localNodesById = new Map(localNodes.map((node) => [node.id, node]));
    return remoteNodes.some((node) => {
        const workflow = node.metadata?.shortDrama;
        const localNode = localNodesById.get(node.id);
        const isCompletedDocument = node.metadata?.status === "success" && Boolean(node.metadata?.content?.trim()) &&
            Boolean(workflow?.planSection || workflow?.planAsset || workflow?.assetIdentity || workflow?.bibleSection);
        return isCompletedDocument && (!localNode || localNode.metadata?.status !== "success" || localNode.metadata?.content !== node.metadata?.content);
    });
}

export function productionPlanCanvasDocumentCount(frame: CanvasNodeData, children: CanvasNodeData[]) {
    const data = frame.metadata?.shortDrama;
    if (frame.type !== CanvasNodeType.Frame || data?.role !== "collection" || data.step !== "story.plan" || data.planGroup) return 0;
    const manifestId = data.assetGroup?.manifestId;
    return children.filter(node => {
        const workflow = node.metadata?.shortDrama;
        return node.parentId === frame.id && node.id !== manifestId && node.type !== CanvasNodeType.Frame && workflow?.step === "story.plan" &&
            workflow.role === "document" && workflow.assetKey !== "$summary" &&
            (typeof workflow.planSection === "string" || workflow.planVersion === undefined);
    }).length;
}

/** Asset collections share the plan's details, but never its activity label. */
export function productionAssetGroupState(group: CanvasNodeData, anchor?: CanvasNodeData, run?: AgentRun): (ProductionTaskState & { label: string }) | undefined {
    const kind = group.metadata?.shortDrama?.planGroup?.kind;
    if (!kind) return undefined;
    const bound = run?.id === anchor?.metadata?.shortDrama?.productionAgent?.runId && run?.production?.targetNodeId === anchor?.id;
    const progress = bound ? run?.production?.assetGroups?.find((entry) => entry.kind === kind) : undefined;
    if (!progress) return { active: false, failed: false, complete: false, label: "等待任务状态" };
    const count = `已完成 ${progress.completed}/${progress.total}`;
    const task = productionTaskState(anchor, run);
    const active = progress.status === "running" && task.active;
    const failed = progress.status === "error" && task.failed;
    const label = progress.status === "waiting_standards" ? "等待前置规范完成"
        : progress.status === "waiting_manual" ? "等待手动生成资产"
        : progress.status === "complete" ? "制作完成"
        : failed ? "此类资产失败，可在详情重试"
        : progress.status === "error" ? "当前项未完成"
        : task.failed ? "任务已停止，尚未完成"
        : run?.production?.paused ? "已暂停"
        : active ? "资产制作中" : "等待依赖或调度";
    return { active, failed, complete: progress.status === "complete", label: `${label} · ${count}` };
}

export function bindProductionAgentRun(node: CanvasNodeData, run: AgentRun, request?: CreateAgentRunInput): CanvasNodeData {
    const data = node.metadata?.shortDrama;
    if (!data) return node;
    return {
        ...node,
        metadata: {
            ...node.metadata,
            status: "loading",
            errorDetails: undefined,
            generationWarning: undefined,
            taskStage: run.status === "queued" ? "已排队等待制作 Agent" : "制作 Agent 执行中",
            shortDrama: {
                ...data,
                submission: "submitted",
                productionAgent: { ...data.productionAgent, ...(request ? { request } : {}), runId: run.id },
            },
        },
    };
}
