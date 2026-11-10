import type { AgentRun, CreateAgentRunInput } from "@/services/api/agent";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canvasNodeWarning } from "../execution-warning";
import { productionRunExternalFailure } from "./production-agent-journal";
import { isPlanPlaceholder } from "./plan-placeholder";

/** A task can target a root node or a node inside a workflow container. */
export function productionAgentNodePresent(nodes: CanvasNodeData[], nodeId?: string) {
    if (!nodeId) return false;
    const node = nodes.find((entry) => entry.id === nodeId);
    if (!node) return false;
    return !node.parentId || nodes.some((entry) => entry.id === node.parentId);
}

type ProductionTaskState = { active: boolean; failed: boolean; complete: boolean; warning?: boolean };

export function productionParallelWarningText(item: NonNullable<NonNullable<AgentRun["production"]>["parallelItems"]>[number]) {
    const reason = item.message?.trim() || item.validationIssues?.join("；") || "任务未完成，请查看执行记录";
    const action = item.status === "retrying" ? "正在自动重试。" : item.abandoned ? "已跳过此项，可重试。" : ["warning", "error", "failed"].includes(item.status) ? "可在对应任务中重试。" : "";
    return `${item.name}：${reason}${action ? ` ${action}` : ""}`;
}

export function canRetryStoryboardCoordinator(run?: AgentRun) {
    return run?.production?.workKind === "storyboard" && run.production.executionMode === "scene" &&
        ["running", "queued", "failed", "rejected", "waiting_user", "cancelled"].includes(run.status);
}

export function canCancelProductionAgent(run?: AgentRun) {
    return Boolean(run && run.status !== "completed" && (run.status !== "cancelled" || run.cleanupPending));
}

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

/** Names the plan document that failed validation, so a 4/5 count is explained rather than left as a bare number. */
export function productionPlanMissingDocumentNote(run?: AgentRun) {
    const progress = run?.production;
    if (!progress || !productionPlanNeedsContinuation(run)) return "";
    const missing = progress.documentTotal! - (progress.documentCount || 0);
    const detail = progress.inventoryComplete === false ? "资产总表与编码未通过校验" : `有 ${missing} 份文档未通过校验`;
    return `方案文档 ${progress.documentCount || 0}/${progress.documentTotal}：${detail}，点击“继续生成”补齐。`;
}
export function productionPlanAssetSelectorVisible(run?: AgentRun) {
    const progress = run?.production;
    return progress?.workKind === "plan" && (progress.assetGenerationReady === true || (progress.assetGenerationReady === undefined && progress.planReady === true && (progress.assetTotal || 0) > 0));
}

/** Presentation checkpoint only: do not alter signed asset documents when hydrating older nodes. */
export function projectProductionAssetOrder(nodes: CanvasNodeData[], run: AgentRun) {
    const progress = run.production;
    if (progress?.workKind !== "plan" || !progress.targetNodeId || !progress.assets?.length) return nodes;
    const byKind = new Map<string, string[]>();
    const assets = [...progress.assets].sort((a, b) =>
        (a.priority && a.priority > 0 ? a.priority : Infinity) - (b.priority && b.priority > 0 ? b.priority : Infinity));
    for (const asset of assets) {
        const keys = byKind.get(asset.kind) || [];
        keys.push(asset.key);
        byKind.set(asset.kind, keys);
    }
    let changed = false;
    const result = nodes.map(node => {
        const data = node.metadata?.shortDrama;
        const keys = data?.planGroup && data.assetGroup?.manifestId === progress.targetNodeId ? byKind.get(data.planGroup.kind) : undefined;
        const previous = node.metadata?.frame?.assetOrder;
        if (!keys || (previous?.length === keys.length && keys.every((key, index) => previous[index] === key))) return node;
        changed = true;
        return { ...node, metadata: { ...node.metadata, frame: {
            collapsed: false, expandedWidth: node.width, expandedHeight: node.height,
            ...node.metadata?.frame, assetOrder: keys,
        } } };
    });
    return changed ? result : nodes;
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
	if ((progress.inventoryReviewedSections || 0) > 0 || (progress.assetTotal || 0) > 0) {
		const inventory = nodes.find(node => (node.parentId === frame.id || sourceIds.has(node.id)) && node.metadata?.shortDrama?.planSection === "inventory");
		if (!inventory || (inventory.metadata?.shortDrama?.inventoryReviewedSections || 0) < (progress.inventoryReviewedSections || 0) || (progress.inventoryComplete === true && inventory.metadata?.shortDrama?.inventoryComplete === false)) return true;
	}
    const projectedDocuments = nodes.filter(node => {
        const data = node.metadata?.shortDrama;
        const belongsToFrame = node.parentId === frame.id || (!node.parentId && sourceIds.has(node.id));
        return belongsToFrame && node.id !== target.id && node.type !== CanvasNodeType.Frame &&
            !isPlanPlaceholder(node) &&
            data?.inventoryComplete !== false &&
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

/** Plan documents that live outside the container (the standalone outline) but are still its members. */
export function productionPlanDetachedMembers(frame: CanvasNodeData, nodeById: ReadonlyMap<string, CanvasNodeData>): CanvasNodeData[] {
    const data = frame.metadata?.shortDrama;
    if (data?.role !== "collection" || data.step !== "story.plan" || data.planGroup) return [];
    return data.sourceNodeIds.map(id => nodeById.get(id)).filter((node): node is CanvasNodeData => Boolean(node && !node.parentId && node.type !== CanvasNodeType.Frame));
}

export function productionPlanCanvasDocumentCount(frame: CanvasNodeData, children: CanvasNodeData[], detached: CanvasNodeData[] = []) {
    const data = frame.metadata?.shortDrama;
    if (frame.type !== CanvasNodeType.Frame || data?.role !== "collection" || data.step !== "story.plan" || data.planGroup) return 0;
    const manifestId = data.assetGroup?.manifestId;
    const sourceIds = new Set(data.sourceNodeIds || []);
    return [...children, ...detached].filter(node => {
        const workflow = node.metadata?.shortDrama;
        return (node.parentId === frame.id || (!node.parentId && sourceIds.has(node.id))) && node.id !== manifestId && node.type !== CanvasNodeType.Frame && workflow?.step === "story.plan" &&
            !isPlanPlaceholder(node) &&
            workflow.inventoryComplete !== false &&
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
    const count = progress.status === "extracting" || progress.total === 0 ? "数量待清单确定" : `已完成 ${progress.completed}/${progress.total}`;
    const task = productionTaskState(anchor, run);
    const active = ["running", "extracting", "queued"].includes(progress.status) && task.active;
    const failed = progress.status === "error" && task.failed;
    const label = progress.status === "waiting_standards" ? "等待前置规范完成"
        : progress.status === "waiting_manual" ? "等待资产生成"
        : progress.status === "complete" ? "制作完成"
        : run?.status === "cancelled" ? "已取消，可继续制作"
        : failed ? "此类资产失败，可在详情重试"
        : progress.status === "error" ? "当前项未完成"
        : task.failed ? "任务已停止，尚未完成"
        : run?.production?.paused ? "已暂停"
        : progress.status === "extracting" ? task.active ? "正在整理资产清单" : "清单整理已停止，可在详情继续"
        : progress.status === "queued" ? task.active ? "正在准备内容节点" : "内容准备已停止，可在详情继续"
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
