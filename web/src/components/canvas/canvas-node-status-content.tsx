// 画布节点的运行状态内容：生成中（含已耗时）、失败（重试/重新加载资源）与未知节点兜底。

import { type GenerationTask } from "@/services/api/task-center";
import { generationTaskShowsProgress, generationTaskStageLabel, generationTaskStatusLabel, isGenerationTaskSubmissionUncertain } from "@/lib/generation-task-display";
import { AlertCircle, Clock3, Download, Info, Pencil, RefreshCw, Square, WandSparkles } from "lucide-react";
import { useSyncExternalStore } from "react";
import { idleTaskTickerSubscribe, subscribeTaskTicker, taskTickerSnapshot } from "@/lib/canvas/task-ticker";
import { CONTENT_MODERATION_ERROR_CODE, generationErrorMessage, isContentModerationError } from "@/lib/generation-error";
import type { CanvasNodeContentProps } from "./canvas-node-content";
import { CanvasNodeActionButton } from "./canvas-node-action-bar";

export function LoadingContent({ node, theme, onOpenTaskDetails, onCancelTask }: Pick<CanvasNodeContentProps, "node" | "theme" | "onOpenTaskDetails" | "onCancelTask">) {
    const production = node.metadata?.shortDrama?.productionAgent;
    const screenplayRepair = Boolean(node.metadata?.shortDrama?.screenplayRepair);
    const screenplayAudit = Boolean(node.metadata?.shortDrama?.screenplayAudit || node.metadata?.shortDrama?.step === "story.audit");
    const taskId = node.metadata?.taskId;
    const displayTaskId = production?.runId || taskId;
    const displayTask = {
        provider: node.metadata?.taskProvider,
        status: (node.metadata?.taskStatus || "running") as GenerationTask["status"],
        stage: node.metadata?.taskStage,
        mediaStage: node.metadata?.taskMediaStage,
        officialStatus: node.metadata?.taskOfficialStatus,
        errorCode: node.metadata?.taskErrorCode,
    };
    const submissionUncertain = Boolean(displayTaskId) && isGenerationTaskSubmissionUncertain(displayTask);
    const showsProgress = Boolean(displayTaskId) && generationTaskShowsProgress(displayTask);
    const progress = showsProgress && typeof node.metadata?.taskProgress === "number" ? Math.max(0, Math.min(100, Math.round(node.metadata.taskProgress))) : null;
    const statusLabel = screenplayRepair ? "正文修复中" : screenplayAudit ? "正文诊断中" : production ? taskId ? "后台制作任务" : "提交待确认" : taskId ? generationTaskStatusLabel(displayTask) : "等待任务状态";
    const stageLabel = screenplayRepair ? node.metadata?.taskStage || "正在修复正文" : screenplayAudit ? node.metadata?.taskStage || "正在诊断正文" : production ? taskId ? node.metadata?.taskStage || "制作任务执行中" : "提交待确认" : taskId ? generationTaskStageLabel(displayTask) : "正在创建任务";
    const elapsed = useTaskElapsed(node.metadata?.taskCreatedAt);
    const canRequestCancel = Boolean(taskId && onCancelTask && (displayTask.status === "queued" || displayTask.status === "running"));
    return (
        <div className="flex h-full w-full flex-col items-center text-center" style={{ color: theme.node.activeStroke }}>
            <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-2.5 px-5">
                {submissionUncertain ? <AlertCircle className="size-10" /> : <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />}
                <span className="text-[var(--fs-tiny)] font-semibold">{stageLabel}</span>
                {displayTaskId || production ? (
                    <div className="flex w-full max-w-[210px] flex-col items-center gap-1.5">
                        <div className="max-w-full truncate text-[var(--fs-label)] font-medium" style={{ color: theme.node.text }}>
                            {statusLabel}
                            {progress !== null ? ` · ${progress}%` : ""}
                        </div>
                        {progress !== null ? (
                            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: theme.node.stroke }}>
                                <div className="h-full rounded-full transition-[width]" style={{ width: `${progress}%`, background: theme.node.activeStroke }} />
                            </div>
                        ) : null}
                        <div className="max-w-full truncate text-[var(--fs-tiny)] tabular-nums" style={{ color: theme.node.muted }}>
                            <Clock3 className="mr-1 inline size-3" />
                            {displayTaskId ? `${elapsed} · ${shortTaskId(displayTaskId)}` : "请在详情核对原任务"}
                        </div>
                    </div>
                ) : null}
            </div>
            <div className="flex min-h-10 w-full shrink-0 flex-wrap items-center justify-start gap-1 border-t px-3 py-1.5" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel }} data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                {onOpenTaskDetails && taskId ? <CanvasNodeActionButton theme={theme} label="详情" icon={<Info className="size-3.5" />} onClick={() => onOpenTaskDetails(node)} /> : null}
                {canRequestCancel ? <CanvasNodeActionButton theme={theme} label="停止任务" icon={<Square className="size-3.5" />} onClick={() => onCancelTask?.(node)} /> : null}
            </div>
        </div>
    );
}

export function useTaskElapsed(createdAt?: string) {
    const now = useSyncExternalStore(createdAt ? subscribeTaskTicker : idleTaskTickerSubscribe, taskTickerSnapshot, taskTickerSnapshot);
    if (!createdAt) return "刚刚";
    const started = new Date(createdAt).getTime();
    if (!Number.isFinite(started)) return "刚刚";
    const seconds = Math.max(0, Math.floor((now - started) / 1000));
    if (seconds < 60) return `${seconds}秒`;
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}分${seconds % 60}秒` : `${Math.floor(minutes / 60)}时${minutes % 60}分`;
}

export function shortTaskId(id: string) {
    if (id.length <= 20) return id;
    return `${id.slice(0, 14)}...${id.slice(-4)}`;
}

export function ErrorContent({ node, theme, onRetry, onReloadResource, onOpenInfo, onOpenTaskDetails }: Pick<CanvasNodeContentProps, "node" | "theme" | "onRetry" | "onReloadResource" | "onOpenInfo" | "onOpenTaskDetails">) {
    const moderationFailure = node.metadata?.generationErrorCode === CONTENT_MODERATION_ERROR_CODE || isContentModerationError(node.metadata?.errorDetails);
    const errorDisplayTask = {
        provider: node.metadata?.taskProvider,
        status: (node.metadata?.taskStatus || "failed") as GenerationTask["status"],
        stage: node.metadata?.taskStage,
        mediaStage: node.metadata?.taskMediaStage,
        officialStatus: node.metadata?.taskOfficialStatus,
        errorCode: node.metadata?.taskErrorCode,
    };
    const submissionUncertain = isGenerationTaskSubmissionUncertain(errorDisplayTask);
    const openDetails = onOpenTaskDetails && (node.metadata?.taskId || node.metadata?.shortDrama?.productionAgent?.runId)
        ? () => onOpenTaskDetails(node)
        : onOpenInfo
            ? () => onOpenInfo(node)
            : undefined;
    return (
        <div className="flex h-full w-full flex-col items-center text-center">
            <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 px-5">
                <div className="max-w-[260px] text-xs leading-5" style={{ color: submissionUncertain ? theme.node.text : theme.accent.danger }}>
                    {submissionUncertain ? generationTaskStatusLabel(errorDisplayTask) : generationErrorMessage(node.metadata?.errorDetails)}
                </div>
                {submissionUncertain ? (
                    <div className="rounded-[var(--r-sm)] px-3 py-2 text-[var(--fs-label)] leading-4" style={{ background: theme.toolbar.itemHover, color: theme.node.muted }}>
                        {generationTaskStageLabel(errorDisplayTask)}
                    </div>
                ) : null}
            </div>
            {!submissionUncertain ? (
                <div className="flex min-h-10 w-full shrink-0 flex-wrap items-center justify-start gap-1 border-t px-3 py-1.5" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel }} data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                    {openDetails ? <CanvasNodeActionButton theme={theme} label="详情" icon={<Info className="size-3.5" />} onClick={openDetails} /> : null}
                    {moderationFailure ? (
                        node.metadata?.shortDrama?.mediaKind === "image" ? <>
                            {node.metadata.shortDrama.assetSheet ? <CanvasNodeActionButton theme={theme} label="自动调整并重试" icon={<WandSparkles className="size-3.5" />} onClick={() => onRetry?.(node, { adjustPrompt: true })} primary /> : null}
                            <CanvasNodeActionButton theme={theme} label="修改生成要求" icon={<Pencil className="size-3.5" />} onClick={() => onRetry?.(node)} />
                        </> : <span className="px-2 text-[var(--fs-label)]" style={{ color: theme.node.muted }}>修改节点提示词后，可重新点击生成。</span>
                    ) : node.metadata?.resourceReloadAvailable ? <>
                        <CanvasNodeActionButton theme={theme} label="重新加载资源" icon={<Download className="size-3.5" />} onClick={() => onReloadResource?.(node)} primary />
                        <CanvasNodeActionButton theme={theme} label="重新生成" icon={<RefreshCw className="size-3.5" />} onClick={() => onRetry?.(node)} />
                    </> : <CanvasNodeActionButton theme={theme} label={node.metadata?.shortDrama?.submission === "planned" ? "查看详情并继续" : node.metadata?.shortDrama?.productionAgent ? "查看详情并重试" : node.metadata?.taskCanRecoverMedia ? "重试保存（不重新生成）" : node.metadata?.isBatchRoot ? "重新生成失败项" : "重新生成"} icon={<RefreshCw className="size-3.5" />} onClick={() => onRetry?.(node)} />}
                </div>
            ) : null}
        </div>
    );
}

export function UnknownNodeContent({ theme }: Pick<CanvasNodeContentProps, "theme">) {
    return (
        <div className="flex h-full w-full items-center justify-center text-sm" style={{ color: theme.node.placeholder }}>
            未知节点
        </div>
    );
}
