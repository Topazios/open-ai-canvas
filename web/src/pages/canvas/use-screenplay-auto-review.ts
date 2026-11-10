import { useCallback, useRef, useState } from "react";
import type { App } from "antd";
import { nodeWorkflow } from "@/lib/canvas/canvas-short-drama-workflow";
import { resetGenerationTaskMetadata } from "@/lib/canvas/canvas-task-state";
import {
    AUTO_REVIEW_MAX_ROUNDS, autoReviewExcerpt, autoReviewRoundFromReport, autoReviewStalled,
    screenplayAuditState, screenplayBodySignature, screenplayAutoReviewCandidates, type AutoReviewRound, type AutoReviewState,
} from "@/lib/canvas/workflow-screenplay-audit";
import { shortDramaSettingsChanged } from "@/lib/short-drama-settings";
import { ShortDramaStep } from "@/lib/short-drama-steps";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { useShortDramaWorkflowGeneration } from "./use-short-drama-workflow-generation";

const BATCH_CONCURRENCY = 3;
const PARSE_RETRY_LIMIT = 2;
const LOCK_WAIT_MS = 300;
const LOCK_WAIT_LIMIT = 400;
const TRANSIENT_RETRY_LIMIT = 3;
const TRANSIENT_BACKOFF_MS = [2000, 6000, 15000];

type Workflow = Pick<ReturnType<typeof useShortDramaWorkflowGeneration>, "run" | "waitForNode" | "submissionLock">;
type Options = {
    projectId: string; config: AiConfig;
    nodesRef: { current: CanvasNodeData[] };
    setNodes: (update: CanvasNodeData[] | ((nodes: CanvasNodeData[]) => CanvasNodeData[])) => void;
    save: () => Promise<boolean>;
    workflow: Workflow;
    message: ReturnType<typeof App.useApp>["message"];
};

class StopReview extends Error {}

const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

/** 上游、网络这类重试可能成功的失败。内容审核、结果未确认和诊断解析失败不算。 */
export function isTransientReviewFailure(reason: string) {
    if (/内容审核|敏感|违规|安全策略|诊断报告待核对|待确认|未确认/.test(reason)) return false;
    return /上游|流式|网络|超时|中断|生成未完成|\b(502|503|504|429)\b|timeout|network|fetch failed/i.test(reason);
}

type RecoverOptions = { content?: string; richText?: unknown; stage: string };

/** 自动流程失败后把正文节点恢复成可操作状态。给了 content 就同时还原正文，并清掉未复检的修复记录。 */
export function recoverReviewBody(nodes: CanvasNodeData[], bodyId: string, options: RecoverOptions): CanvasNodeData[] {
    return nodes.map(node => {
        if (node.id !== bodyId) return node;
        const restore = options.content !== undefined;
        return {
            ...node,
            metadata: {
                ...resetGenerationTaskMetadata(node.metadata, "success"),
                ...(restore ? { content: options.content, richText: options.richText as Record<string, unknown> | undefined } : {}),
                taskStage: options.stage,
                shortDrama: node.metadata?.shortDrama && {
                    ...node.metadata.shortDrama,
                    submission: undefined, materializedTaskId: undefined,
                    ...(restore ? { screenplayRepair: undefined } : {}),
                },
            },
        };
    });
}

/** 清掉正文上的旧报告和旧修复记录，保留自动诊断修复历史。 */
export function resetScreenplayReviewNodes(nodes: CanvasNodeData[], bodyId: string): CanvasNodeData[] {
    return nodes.map(node => node.id !== bodyId ? node : {
        ...node,
        metadata: {
            ...resetGenerationTaskMetadata(node.metadata, "success"),
            taskStage: "准备重新审核",
            shortDrama: node.metadata?.shortDrama && {
                ...node.metadata.shortDrama,
                submission: undefined, materializedTaskId: undefined, screenplayAudit: undefined, screenplayRepair: undefined,
            },
        },
    });
}

function nodeFailure(node: CanvasNodeData | undefined) {
    const meta = node?.metadata;
    if (!node || !meta) return { reason: "正文节点已不存在", parse: false };
    if (meta.shortDrama?.submission === "unknown") return { reason: "提交结果待确认，已暂停以免重复提交", parse: false };
    if (meta.status === "loading") return { reason: "任务仍在执行或结果未确认，已暂停以免重复提交", parse: false };
    if (meta.status === "error") {
        const detail = typeof meta.errorDetails === "string" && meta.errorDetails ? `：${meta.errorDetails}` : "";
        return { reason: `${meta.taskStage || "任务失败"}${detail}`, parse: meta.taskStage === "诊断报告待核对" };
    }
    return undefined;
}

export function useScreenplayAutoReview({ projectId, config, nodesRef, setNodes, save, workflow, message }: Options) {
    const [running, setRunning] = useState<string[]>([]);
    const cancelled = useRef(new Set<string>());
    const active = useRef(new Set<string>());

    const markRunning = useCallback((id: string, on: boolean) => {
        if (on) active.current.add(id); else active.current.delete(id);
        setRunning([...active.current]);
    }, []);

    const runOne = useCallback(async (bodyId: string, resume = false) => {
        const find = () => nodesRef.current.find(node => node.id === bodyId);
        const settings = () => useCanvasStore.getState().openProject(projectId)?.globalSettings;
        const startSettings = settings();
        const first = find();
        const data = nodeWorkflow(first);
        if (!first || !data?.episodeNumber || data.step !== ShortDramaStep.Body) { message.warning("请选择已完成的分集正文"); return; }
        if (!first.metadata?.content?.trim()) { message.warning("正文为空，无法诊断"); return; }
        const episodeNumber = data.episodeNumber;
        const model = config.textModel || "";
        const request = (step: ShortDramaStep, repair: boolean) => ({
            step, pipelineId: data.pipelineId, anchorId: bodyId, sourceNodeIds: [bodyId], model, instruction: "",
            ...(repair ? { auditRepairReportId: bodyId } : {}),
            episodeCount: data.parameters?.episodeCount || useCanvasStore.getState().openProject(projectId)?.globalSettings?.episodeCount || 1,
            minutesPerEpisode: data.parameters?.minutesPerEpisode || "1-2",
            reasoningEffort: config.textReasoningEffort || "medium",
            start: episodeNumber, count: 1, globalSettings: settings(),
        });

        // 续跑：上次以 settled 或异常中断结束且正文没被改过时，保留原稿和已有轮次接着跑。
        const prior = data.autoReview;
        const resumable = Boolean(resume && (prior?.status === "manual" || prior?.status === "settled") && prior.originalContent && prior.bodySignature === screenplayBodySignature(first));
        const base = resumable ? prior!.rounds.length : 0;
        let state: AutoReviewState = resumable ? {
            ...prior!, status: "auditing", round: base + 1, maxRounds: base + AUTO_REVIEW_MAX_ROUNDS,
            finishedAt: undefined, stopReason: undefined,
        } : {
            status: "auditing", round: 1, maxRounds: AUTO_REVIEW_MAX_ROUNDS, startedAt: new Date().toISOString(),
            originalContent: first.metadata.content, originalRichText: first.metadata.richText, rounds: [],
            bodySignature: screenplayBodySignature(first),
        };
        // 修复提交期间持有修复前正文，修复失败时据此还原。
        let restore: { content: string; richText: unknown } | undefined;
        let expectedSignature = screenplayBodySignature(first);
        const commit = () => setNodes(current => current.map(node => node.id !== bodyId || !node.metadata?.shortDrama ? node : {
            ...node, metadata: { ...node.metadata, shortDrama: { ...node.metadata.shortDrama, autoReview: state } },
        }));
        const persist = async () => {
            commit();
            if (!await save()) throw new StopReview("云端保存失败，已停止自动流程，请稍后重试");
        };
        const stop = (reason: string): never => { throw new StopReview(reason); };
        const guard = () => {
            if (cancelled.current.has(bodyId)) stop("已取消");
            const node = find();
            if (!node) stop("正文节点已不存在");
            const now = settings();
            if (startSettings && now && shortDramaSettingsChanged(startSettings, now)) stop("流程中全局设定被修改，请基于新设定重新发起");
        };
        const submit = async (step: ShortDramaStep, repair: boolean) => {
            // 提交锁被其他任务占用时排队等待，锁释放后再提交。
            for (let attempt = 0; ; attempt++) {
                for (let i = 0; workflow.submissionLock.current && i < LOCK_WAIT_LIMIT; i++) await sleep(LOCK_WAIT_MS);
                if (workflow.submissionLock.current) stop("等待其他任务提交超时，请稍后重试");
                guard();
                try { await workflow.run(request(step, repair)); break; }
                catch (error) {
                    // run 在锁被抢占时会同步抛错，此时回到循环继续等待。
                    if (workflow.submissionLock.current && attempt < LOCK_WAIT_LIMIT) continue;
                    stop(error instanceof Error ? error.message : "任务提交失败");
                }
            }
            await workflow.waitForNode(bodyId);
            await sleep(0);
        };

        try {
            state = { ...state }; await persist();
            for (let n = 1; n <= AUTO_REVIEW_MAX_ROUNDS; n++) {
                const round = base + n;
                state = { ...state, status: "auditing", round }; commit();
                let parseRetries = 0;
                let transientRetries = 0;
                let report;
                for (;;) {
                    guard();
                    setNodes(current => resetScreenplayReviewNodes(current, bodyId));
                    commit();
                    if (!await save()) stop("正文状态清理后未能保存到云端，尚未审核");
                    await submit(ShortDramaStep.Audit, false);
                    const node = find();
                    const failure = nodeFailure(node);
                    if (failure) {
                        if (failure.parse && parseRetries < PARSE_RETRY_LIMIT) { parseRetries++; continue; }
                        if (isTransientReviewFailure(failure.reason) && transientRetries < TRANSIENT_RETRY_LIMIT) {
                            await sleep(TRANSIENT_BACKOFF_MS[transientRetries++]);
                            continue;
                        }
                        stop(`诊断失败：${failure.reason}`);
                    }
                    if (screenplayBodySignature(node!) !== expectedSignature) stop("流程中正文被修改，请重新发起");
                    const audit = screenplayAuditState(node, nodesRef.current, settings());
                    if (!audit.report || audit.stale) stop("诊断结果已失效或缺失，请重新发起");
                    report = audit.report!;
                    break;
                }
                const current: AutoReviewRound = { ...autoReviewRoundFromReport(report, round), ...(parseRetries ? { parseRetries } : {}) };
                state = { ...state, rounds: [...state.rounds, current] };
                if (current.result === "passed") {
                    state = { ...state, status: "passed", finishedAt: new Date().toISOString(), stopReason: undefined };
                    await persist();
                    message.success(`第${episodeNumber}集自动诊断通过，共${round}轮`);
                    return;
                }
                await persist();
                // 停滞或轮数用尽不算故障：带着未解决的阻塞项收尾，正文保留最后一轮修复结果，下游照常继续。
                const settleReason = autoReviewStalled(state.rounds)
                    ? "连续两次修复后阻塞问题数都没有减少，已停止自动修复，未解决的问题留在记录里供抽查"
                    : n === AUTO_REVIEW_MAX_ROUNDS ? `本次已达到${AUTO_REVIEW_MAX_ROUNDS}轮上限，仍有阻塞问题，未解决的问题留在记录里供抽查` : "";
                if (settleReason) {
                    state = { ...state, status: "settled", finishedAt: new Date().toISOString(), stopReason: settleReason };
                    await persist();
                    message.warning(`第${episodeNumber}集自动诊断修复已结束，仍有${current.blocking}项阻塞问题待留意，不影响后续制作`);
                    return;
                }

                // 修复
                guard();
                const before = find()!;
                const beforeContent = before.metadata?.content || "";
                const beforeRichText = before.metadata?.richText;
                const audit = screenplayAuditState(before, nodesRef.current, settings());
                if (!audit.report || audit.stale) stop("修复前诊断已失效，请重新发起");
                const startedAt = new Date().toISOString();
                const repairRecord = {
                    startedAt,
                    adopted: report.findings.filter(item => item.certainty === "确认错误").map(item => item.id),
                    skipped: report.findings.filter(item => item.certainty !== "确认错误").map(item => ({
                        id: item.id,
                        reason: item.certainty === "待核实风险" ? "待核实风险，不当作事实改写，仅记录" : "创作建议，仅在不改变剧情事实时采用",
                    })),
                    beforeChars: beforeContent.length, beforeExcerpt: autoReviewExcerpt(beforeContent), repairPrompt: report.repairPrompt,
                };
                state = { ...state, status: "repairing", rounds: state.rounds.map(item => item.round === round ? { ...item, repair: repairRecord } : item) };
                commit();
                restore = { content: beforeContent, richText: beforeRichText };
                let after: CanvasNodeData | undefined;
                for (let repairRetries = 0; ; repairRetries++) {
                    await submit(ShortDramaStep.Body, true);
                    after = find();
                    const failure = nodeFailure(after);
                    if (!failure) break;
                    if (!isTransientReviewFailure(failure.reason) || repairRetries >= TRANSIENT_RETRY_LIMIT) stop(`修复失败：${failure.reason}`);
                    await sleep(TRANSIENT_BACKOFF_MS[repairRetries]);
                    guard();
                    // 失败的修复请求把正文节点置为 error，重提前先还原到可提交状态，不新增轮数。
                    setNodes(current => recoverReviewBody(current, bodyId, { ...restore!, stage: "准备重新修复" }));
                    commit();
                    if (!await save()) stop("修复重试前未能保存到云端，已停止自动流程");
                }
                const afterContent = after?.metadata?.content || "";
                if (!afterContent.trim()) stop("修复结果为空，已停止");
                if (afterContent === beforeContent) stop("修复没有改动正文，已停止以免重复消耗");
                expectedSignature = screenplayBodySignature(after!);
                restore = undefined;
                state = {
                    ...state, bodySignature: expectedSignature,
                    rounds: state.rounds.map(item => item.round === round ? {
                        ...item, result: "repaired",
                        repair: { ...repairRecord, finishedAt: new Date().toISOString(), afterChars: afterContent.length, afterExcerpt: autoReviewExcerpt(afterContent) },
                    } : item),
                };
                await persist();
            }
        } catch (error) {
            const reason = error instanceof StopReview ? error.message : error instanceof Error ? error.message : "自动流程异常中断";
            state = { ...state, status: "manual", stopReason: reason, finishedAt: new Date().toISOString() };
            commit();
            // 失败后正文节点不能停在 error，否则报告判定失效，诊断和修复入口都会消失。
            const failed = find();
            if (failed && failed.metadata?.status !== "loading") {
                if (restore) setNodes(current => recoverReviewBody(current, bodyId, { ...restore!, stage: "自动修复未完成，已保留修复前正文" }));
                else if (failed.metadata?.status === "error") setNodes(current => recoverReviewBody(current, bodyId, { stage: "准备重新审核" }));
                commit();
            }
            await save().catch(() => false);
            message.warning(`第${episodeNumber}集自动诊断修复已中断，可重试：${reason}`);
        }
    }, [config, message, nodesRef, projectId, save, setNodes, workflow]);

    const start = useCallback(async (bodyId: string, resume = false) => {
        if (active.current.has(bodyId)) { message.info("这一集正在自动诊断修复"); return; }
        const body = nodesRef.current.find(node => node.id === bodyId);
        const settings = useCanvasStore.getState().openProject(projectId)?.globalSettings;
        if (!body || !screenplayAutoReviewCandidates([body], nodesRef.current, settings, active.current).length) return;
        cancelled.current.delete(bodyId);
        markRunning(bodyId, true);
        try { await runOne(bodyId, resume); } finally { markRunning(bodyId, false); cancelled.current.delete(bodyId); }
    }, [markRunning, message, runOne, nodesRef, projectId]);

    const startBatch = useCallback(async (bodyIds: string[]) => {
        const nodes = nodesRef.current;
        const byId = new Map(nodes.map(node => [node.id, node]));
        const bodies = bodyIds.flatMap(id => { const node = byId.get(id); return node ? [node] : []; });
        const settings = useCanvasStore.getState().openProject(projectId)?.globalSettings;
        const queue = screenplayAutoReviewCandidates(bodies, nodes, settings, active.current).map(node => node.id);
        if (!queue.length) { message.info("没有需要自动诊断修复的分集"); return; }
        message.info(`已加入${queue.length}集自动诊断修复队列`);
        const worker = async () => { for (let id = queue.shift(); id; id = queue.shift()) await start(id, true); };
        await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, worker));
    }, [message, start, nodesRef, projectId]);

    const cancel = useCallback((bodyId: string) => { cancelled.current.add(bodyId); }, []);

    return { start, startBatch, stop: cancel, running };
}
