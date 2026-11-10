import { Button, Dropdown } from "antd";
import { CheckCircle2, Eye, FileSearch, MoreHorizontal, PencilLine, Play, RotateCcw, WandSparkles, X } from "lucide-react";
import { useState, type SyntheticEvent } from "react";
import { AppModal } from "@/components/ui/product/app-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { ShortDramaGlobalSettings } from "@/lib/short-drama-settings";
import { autoReviewBlockingCount, autoReviewOutdated, autoReviewPassed, latestBodyAudit, screenplayAuditState, screenplayAuditChecks, type AutoReviewRound, type AutoReviewState } from "@/lib/canvas/workflow-screenplay-audit";
import { nodeWorkflow } from "@/lib/canvas/canvas-short-drama-workflow";
import { CanvasNodeActionButton } from "./canvas-node-action-bar";

type AuditProps = { node: CanvasNodeData; nodes: CanvasNodeData[]; settings?: ShortDramaGlobalSettings; onRepair: (nodeId: string) => void; onReport: (nodeId: string) => void; onAudit: () => void; onEdit: () => void; onResume?: (bodyId: string) => void };

function autoReviewOf(body?: CanvasNodeData): AutoReviewState | undefined {
    return body?.metadata?.shortDrama?.autoReview as AutoReviewState | undefined;
}

function autoReviewBadge(review?: AutoReviewState) {
    if (!review) return null;
    if (review.status === "auditing") return { text: `自动诊断中(第${review.round}轮)`, title: "正在自动诊断" };
    if (review.status === "repairing") return { text: `自动修复中(第${review.round}轮)`, title: "正在自动修复正文" };
    if (review.status === "passed") return { text: `自动审核已通过(${review.rounds.length}轮)`, title: "诊断、修复、复检已全部通过" };
    if (review.status === "settled") {
        const blocking = review.rounds[review.rounds.length - 1]?.blocking ?? 0;
        return { text: blocking ? `已完成，仍有${blocking}项待留意` : "已完成", title: review.stopReason || "自动诊断修复已结束，未解决的问题留在记录里" };
    }
    return { text: "已中断，可重试", title: review.stopReason || "自动诊断修复已中断" };
}

// 异常中断和带警告结束的记录都提供重试入口。
function canRetryReview(review?: AutoReviewState) {
    return review?.status === "manual" || review?.status === "settled";
}

function roundResultLabel(round: AutoReviewRound) {
    if (round.result === "passed") return "通过";
    if (round.result === "repaired") return "已修复";
    return "未通过";
}

function currentReview(reportNode: CanvasNodeData | undefined, body: CanvasNodeData | undefined, nodes: CanvasNodeData[], settings?: ShortDramaGlobalSettings) {
    const { report, stale } = screenplayAuditState(reportNode, nodes, settings);
    const review = autoReviewOf(body);
    const outdated = Boolean(review && body && autoReviewOutdated(review, body));
    const busy = review?.status === "auditing" || review?.status === "repairing" || body?.metadata?.status === "loading";
    const passed = Boolean(report && !stale && !busy && autoReviewPassed(report));
    const needsRecheck = !busy && Boolean(report ? stale : outdated);
    const blocking = report ? autoReviewBlockingCount(report) : 0;
    const badge = autoReviewBadge(review);
    const label = busy ? (review?.status === "auditing" || review?.status === "repairing" ? badge!.text : "诊断中")
        : needsRecheck ? "当前版本待复检" : passed ? "审核通过"
        : review?.status === "passed" ? "诊断结论待核对"
        : badge?.text || (report ? "诊断未通过" : body?.metadata?.status === "error" ? "诊断未完成" : "尚未诊断");
    return { report, stale, review, outdated, busy, passed, needsRecheck, blocking, label };
}

function reviewTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "时间未记录" : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

export function CanvasScreenplayNodeContent({ node, nodes, settings, onRepair, onReport, onAudit, onEdit, onResume }: AuditProps) {
    const theme = canvasThemes[useActiveTheme()];
    const isReport = node.metadata?.shortDrama?.step === "story.audit";
    const reportNode = isReport ? node : latestBodyAudit(node, nodes);
    const detailsNodeId = reportNode?.id || node.id;
    const bodyNode = isReport ? nodes.find((source) => source.id === reportNode?.metadata?.shortDrama?.screenplayAudit?.bodyNodeId) : node;
    const state = currentReview(reportNode, bodyNode, nodes, settings);
    const canResume = Boolean(!state.busy && !state.passed && !state.needsRecheck && onResume && bodyNode && canRetryReview(state.review));
    const stopCanvasEvent = (event: SyntheticEvent) => event.stopPropagation();
    return (
        <section className="box-border flex size-full min-h-0 flex-col overflow-hidden px-4 pt-11" style={{ color: theme.node.text }}>
            <div className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap break-words text-xs leading-6" style={{ color: theme.node.muted }}>
                {isReport && state.report ? (
                    <>
                        <strong>{state.report.summary}</strong>
                        <div>质量：{state.report.quality}</div>
                        <div>分镜可用性：{state.report.usability}</div>
                    </>
                ) : (
                    node.metadata?.content
                )}
            </div>
            <div className="mt-2 shrink-0 border-t pt-2" style={{ borderColor: theme.node.stroke }}>
                {(state.review || state.report || state.needsRecheck) ? (
                    <div className="mb-1 flex items-center gap-1.5 text-xs" style={{ color: state.passed ? "var(--status-success)" : state.needsRecheck ? "var(--status-warning)" : theme.node.muted }} role="status">
                        {state.passed ? <CheckCircle2 size={13} aria-hidden /> : null}
                        <span>{state.label}</span>
                        {state.passed && state.review ? <span style={{ color: theme.node.muted }}>· {state.review.rounds.length}轮诊修</span> : null}
                    </div>
                ) : null}
            <div
                className="thin-scrollbar flex min-h-9 min-w-0 items-center gap-1 overflow-x-auto"
                style={{ borderColor: theme.node.stroke }}
                data-canvas-no-zoom
                onPointerDown={stopCanvasEvent}
                onMouseDown={stopCanvasEvent}
                onWheel={stopCanvasEvent}
            >
                <CanvasNodeActionButton theme={theme} label="编辑" icon={<PencilLine size={14} />} onClick={onEdit} primary />
                {!state.passed && !state.busy && !canResume ? <CanvasNodeActionButton theme={theme} label={state.needsRecheck ? "复检当前版本" : state.report ? "再次诊断" : "诊断"} icon={<FileSearch size={14} />} onClick={onAudit} /> : null}
                <CanvasNodeActionButton theme={theme} label={state.review ? "诊修记录" : "诊断详情"} icon={<Eye size={14} />} onClick={() => onReport(detailsNodeId)} />
                {canResume && bodyNode ? <CanvasNodeActionButton theme={theme} label="重试自动修复" icon={<Play size={14} />} onClick={() => onResume?.(bodyNode.id)} /> : null}
                {!state.busy && !state.passed && !state.stale && state.report?.findings.length && reportNode ? (
                    <CanvasNodeActionButton theme={theme} label="修复正文" icon={<WandSparkles size={14} />} onClick={() => onRepair(reportNode.id)} />
                ) : null}
                {!isReport && node.metadata?.shortDrama?.screenplayRepair && !state.report ? (
                    <span className="min-w-0 truncate whitespace-nowrap px-1 text-xs" style={{ color: theme.node.muted }}>
                        修复版 · 待复检
                    </span>
                ) : null}
            </div>
            </div>
        </section>
    );
}

function AutoReviewRecord({ review, outdated, borderColor, mutedColor, sourceName }: { review: AutoReviewState; outdated?: boolean; borderColor: string; mutedColor: string; sourceName: (id: string) => string }) {
    const statusText = review.status === "passed" ? "已通过" : review.status === "settled" ? "已完成，仍有待留意项" : review.status === "manual" ? "已中断" : review.status === "repairing" ? "修复中" : "诊断中";
    return (
        <details className="mt-5 border-t pt-4" style={{ borderColor }} aria-label="自动诊断修复记录">
            <summary className="cursor-pointer text-sm font-semibold">诊修历史 · {review.rounds.length}轮 <span className="font-normal" style={{ color: mutedColor }}>· {outdated ? "旧版本记录" : statusText}</span></summary>
            <p className="mt-2 text-xs" style={{ color: mutedColor }}>
                最多 {review.maxRounds} 轮 · 开始 {reviewTime(review.startedAt)}
                {review.finishedAt ? ` · 结束 ${reviewTime(review.finishedAt)}` : ""}
            </p>
            {outdated ? <p className="mt-1 break-words text-xs" style={{ color: mutedColor }}>以下是旧版本的诊修过程，不代表当前正文已通过。</p> : null}
            {review.stopReason ? <p className="mt-1 break-words text-xs">结束说明：{review.stopReason}</p> : null}
            {[...review.rounds].reverse().map((round) => {
                const repair = round.repair;
                return (
                    <details key={round.round} className="mt-3 border-t pt-3" style={{ borderColor }}>
                        <summary className="cursor-pointer text-sm font-medium">
                            第{round.round}轮 · {roundResultLabel(round)} <span className="font-normal" style={{ color: mutedColor }}>· {round.blocking}项阻塞{repair ? ` · 采用${repair.adopted.length}项修复` : ""}</span>
                        </summary>
                        <div className="mt-2 text-xs leading-6">
                            <p style={{ color: mutedColor }}>内容质量：{round.quality} · 分镜可用性：{round.usability}</p>
                            <p className="whitespace-pre-wrap break-words">{round.summary}</p>
                            {round.parseRetries ? <p style={{ color: mutedColor }}>报告格式不合规，自动重审 {round.parseRetries} 次</p> : null}
                            {round.checks?.length ? (
                                <details className="mt-3">
                                    <summary className="cursor-pointer font-medium">正文验收维度 · {round.checks.length}项</summary>
                                    {round.checks.map((check) => (
                                        <p key={check.key} className="break-words">
                                            {screenplayAuditChecks[check.key] || check.key}：{check.verdict}
                                            <span style={{ color: mutedColor }}> · {check.note}</span>
                                        </p>
                                    ))}
                                </details>
                            ) : null}
                            {round.coverage?.length || round.limitations?.length ? (
                                <details className="mt-2">
                                    <summary className="cursor-pointer">审读范围与未验证项</summary>
                                    <div className="mt-1" style={{ color: mutedColor }}>
                                        {round.coverage?.map((item) => (
                                            <p key={item.sourceId} className="break-words">
                                                {sourceName(item.sourceId)}：{item.mode} · {item.note}
                                            </p>
                                        ))}
                                        {round.limitations?.map((item, index) => (
                                            <p key={index} className="break-words">{item}</p>
                                        ))}
                                    </div>
                                </details>
                            ) : null}
                            {round.findings.length ? (
                                round.findings.map((item) => (
                                    <details key={item.id} className="mt-3 break-words border-t pt-3" style={{ borderColor }}>
                                        <summary className="cursor-pointer">
                                        <strong>
                                            {item.severity} · {item.title}
                                        </strong>{" "}
                                        <span style={{ color: mutedColor }}>
                                            {item.certainty} · {item.blocking ? "阻塞" : "不阻塞"}
                                        </span>
                                        </summary>
                                        <p>定位：{item.location}</p>
                                        {item.evidence.map((quote, index) => (
                                            <blockquote key={index} className="my-1 whitespace-pre-wrap border-l-2 pl-3" style={{ borderColor }}>
                                                {quote}
                                            </blockquote>
                                        ))}
                                        {item.basis ? <p>依据：{item.basis}</p> : null}
                                        <p>影响：{item.impact}</p>
                                        <p>最小修改：{item.suggestion}</p>
                                        <p>复检条件：{item.recheck}</p>
                                        {item.repairPrompt ? (
                                            <details className="mt-1">
                                                <summary className="cursor-pointer">修复提示词</summary>
                                                <p className="mt-1 whitespace-pre-wrap break-words">{item.repairPrompt}</p>
                                            </details>
                                        ) : null}
                                    </details>
                                ))
                            ) : (
                                <p style={{ color: mutedColor }}>本轮未发现问题</p>
                            )}
                            {round.repairPrompt ? (
                                <details className="mt-2">
                                    <summary className="cursor-pointer">综合修复提示词</summary>
                                    <p className="mt-1 whitespace-pre-wrap break-words">{round.repairPrompt}</p>
                                </details>
                            ) : null}
                            {repair ? (
                                <div className="mt-3 border-t pt-2" style={{ borderColor }}>
                                    <strong>修复方式</strong>
                                    <p>
                                        字数 {repair.beforeChars} → {repair.afterChars ?? "未完成"} · 采用 {repair.adopted.length} 项
                                        {repair.skipped.length ? ` · 跳过 ${repair.skipped.length} 项` : ""}
                                    </p>
                                    {repair.adopted.length ? <p>采用的问题：{repair.adopted.join("、")}</p> : null}
                                    {repair.skipped.map((item) => (
                                        <p key={item.id}>
                                            跳过 {item.id}：{item.reason}
                                        </p>
                                    ))}
                                    {repair.beforeExcerpt ? (
                                        <p className="whitespace-pre-wrap break-words">
                                            <span style={{ color: mutedColor }}>修复前：</span>
                                            {repair.beforeExcerpt}
                                        </p>
                                    ) : null}
                                    {repair.afterExcerpt ? (
                                        <p className="whitespace-pre-wrap break-words">
                                            <span style={{ color: mutedColor }}>修复后：</span>
                                            {repair.afterExcerpt}
                                        </p>
                                    ) : null}
                                    {repair.repairPrompt ? (
                                        <details className="mt-1">
                                            <summary className="cursor-pointer">修复提示词</summary>
                                            <p className="mt-1 whitespace-pre-wrap break-words">{repair.repairPrompt}</p>
                                        </details>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                    </details>
                );
            })}
        </details>
    );
}

type DetailsProps = Omit<AuditProps, "onReport" | "onAudit" | "onEdit"> & { onClose: () => void; onReaudit: (bodyId: string) => void; onBody: (bodyId: string) => void; onRestore?: (bodyId: string) => void };

export function CanvasScreenplayAuditDetails(props: DetailsProps) {
    return (
        <AppModal open title={null} footer={null} closable={false} centered flush width="min(940px, calc(100vw - 24px))" onCancel={props.onClose}>
            <CanvasScreenplayAuditPanel {...props} />
        </AppModal>
    );
}

// 弹窗内容单独导出，便于不经过弹窗门户直接渲染和测试。
export function CanvasScreenplayAuditPanel({
    node,
    nodes,
    settings,
    onClose,
    onRepair,
    onReaudit,
    onBody,
    onRestore,
    onResume,
}: DetailsProps) {
    const theme = canvasThemes[useActiveTheme()];
    const [pendingAction, setPendingAction] = useState<"reaudit" | "restore" | null>(null);
    const binding = node.metadata?.shortDrama?.screenplayAudit;
    const inline = nodeWorkflow(node)?.step === "story.body" && binding?.bodyNodeId === node.id;
    const body = inline ? node : nodes.find((source) => source.id === binding?.bodyNodeId);
    const state = currentReview(node, body, nodes, settings);
    const { report, stale, review, busy, passed, needsRecheck, blocking } = state;
    const findings = [...(report?.findings || [])].sort((a, b) => a.severity.localeCompare(b.severity));
    const sourceName = (id: string) => nodes.find((source) => source.id === id)?.title || id;
    // 有自动诊断记录时，完整报告已按轮次收进记录里，外层只保留结论摘要。
    const hasAuto = Boolean(review?.rounds.length);
    const canResume = Boolean(body && onResume && !busy && !passed && !needsRecheck && canRetryReview(review));
    const canRestore = Boolean(body && onRestore && (body.metadata?.shortDrama?.autoReview?.originalContent !== undefined || body.metadata?.shortDrama?.screenplayRepair?.previousContent !== undefined));
    return (
        <>
            <section
                className="flex h-[min(88dvh,840px)] flex-col overflow-hidden"
                style={{ background: theme.node.panel, color: theme.node.text }}
                data-canvas-no-zoom
                data-canvas-wheel-scroll
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                aria-label="正文质量诊断报告"
            >
                <header className="flex shrink-0 flex-wrap items-center gap-2 border-b p-4" style={{ borderColor: theme.node.stroke }}>
                    <strong className="mr-auto min-w-0 break-words text-sm">{node.title}</strong>
                    {!inline ? (
                        <Button size="small" disabled={!body} onClick={() => body && onBody(body.id)}>
                            对应正文
                        </Button>
                    ) : null}
                    {!passed && !busy && !canResume ? <Button size="small" icon={<FileSearch size={14} />} disabled={!body} onClick={() => body && onReaudit(body.id)}>
                        {needsRecheck ? "复检当前版本" : report ? "再次诊断" : "诊断"}
                    </Button> : null}
                    {!passed && !busy && !stale && findings.length ? <Button size="small" icon={<WandSparkles size={14} />} disabled={!body} onClick={() => body && onRepair(inline ? body.id : node.id)}>
                        修复正文
                    </Button> : null}
                    {canResume && body ? (
                        <Button size="small" icon={<Play size={14} />} onClick={() => onResume?.(body.id)}>
                            重试自动修复
                        </Button>
                    ) : null}
                    {body && !busy && (passed || canRestore) ? <Dropdown trigger={["click"]} menu={{ items: [
                        ...(passed ? [{ key: "reaudit", label: "再次诊断…", icon: <RotateCcw size={14} /> }] : []),
                        ...(canRestore ? [{ key: "restore", label: "恢复修复前版本…", icon: <RotateCcw size={14} />, danger: true }] : []),
                    ], onClick: ({ key }) => setPendingAction(key as "reaudit" | "restore") }}>
                        <Button size="small" type="text" icon={<MoreHorizontal size={16} />} aria-label="更多诊断操作">更多操作</Button>
                    </Dropdown> : null}
                    <Button size="small" type="text" icon={<X size={17} />} aria-label="关闭正文诊断报告" onClick={onClose} />
                </header>
                <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-5 text-sm leading-7">
                    <section className="mb-5 rounded-[var(--r-lg)] border p-4" style={{ borderColor: theme.node.stroke, background: theme.node.fill }} aria-label="当前正文诊断结论">
                        <p className="mb-2 text-xs" style={{ color: theme.node.muted }}>当前版本 · 第{nodeWorkflow(body)?.episodeNumber || nodeWorkflow(node)?.episodeNumber || "—"}集</p>
                        <h2 className="flex items-center gap-2 text-lg font-semibold" style={{ color: passed ? "var(--status-success)" : needsRecheck ? "var(--status-warning)" : theme.node.text }} role="status">
                            {passed ? <CheckCircle2 size={20} aria-hidden /> : null}{state.label}
                        </h2>
                        <p className="mt-1 text-sm" style={{ color: theme.node.muted }}>
                            {busy ? "任务正在执行，完成后会更新诊断结论和记录。" : needsRecheck ? "正文或审核依据已变化。下方记录仅供回顾，请复检当前版本后再采用诊断结论。" : passed ? "当前正文无阻塞问题，可继续后续制作，无需重复诊断。" : report ? blocking ? `当前诊断有 ${blocking} 项阻塞问题，请先查看下方处理建议。` : "诊断尚未通过，请查看结论说明及未验证项。" : node.metadata?.errorDetails || "当前正文尚无有效诊断结论。"}
                        </p>
                        {report && !stale && !busy ? <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs" style={{ color: theme.node.muted }}>
                            <span>阻塞问题 <strong style={{ color: theme.node.text }}>{blocking}</strong> 项</span>
                            <span>非阻塞事项 <strong style={{ color: theme.node.text }}>{findings.length - blocking}</strong> 项{passed ? " · 不影响通过" : ""}</span>
                            {review ? <span>已诊断 {review.rounds.length} 轮 · 已修复 {review.rounds.filter(round => round.result === "repaired").length} 轮</span> : null}
                        </div> : null}
                    </section>
                    {report ? (
                        <>
                            <div className="border-b pb-4" style={{ borderColor: theme.node.stroke }}>
                                <h3 className="font-semibold">{stale ? "上次诊断摘要 · 旧版本" : "诊断摘要"}</h3>
                                <p className="mt-2 whitespace-pre-wrap">{report.summary}</p>
                                <p className="text-xs" style={{ color: theme.node.muted }}>
                                    内容质量：{report.quality} · 分镜可用性：{report.usability} · 模型诊断不代表作者确认
                                </p>
                            </div>
                            {hasAuto && findings.length ? <section className="mt-4" aria-label={stale ? "上次诊断问题" : "当前待处理与参考建议"}>
                                <h3 className="font-semibold">{stale ? "上次诊断问题 · 旧版本" : blocking ? "待处理问题与参考建议" : passed ? "参考建议与待核实项 · 不影响审核通过" : "诊断问题与参考建议"}</h3>
                                <p className="text-xs" style={{ color: theme.node.muted }}>点击问题查看定位、证据与建议。</p>
                                {findings.map(item => <details key={item.id} className="border-b py-3" style={{ borderColor: theme.node.stroke }}>
                                    <summary className="cursor-pointer text-sm"><strong>{item.title}</strong> <span className="text-xs" style={{ color: theme.node.muted }}>· {item.severity} · {item.certainty}</span></summary>
                                    <div className="mt-2 space-y-2 text-xs leading-6">
                                        <p>建议：{item.suggestion}</p><p>定位：{item.location}</p><p>影响：{item.impact}</p><p>复检条件：{item.recheck}</p>
                                        {item.evidence.map((e, index) => <blockquote key={index} className="border-l-2 pl-3" style={{ borderColor: theme.node.stroke }}><span style={{ color: theme.node.muted }}>{sourceName(e.sourceId)}</span><p className="whitespace-pre-wrap">{e.quote}</p></blockquote>)}
                                        <p>依据：{item.basis}</p>
                                    </div>
                                </details>)}
                            </section> : null}
                            {hasAuto ? null : (<details className="mt-4" aria-label="完整诊断详情">
                            <summary className="cursor-pointer font-semibold">检查详情与问题依据 · {findings.length}项问题</summary>
                            <details className="border-b py-3" style={{ borderColor: theme.node.stroke }}>
                                <summary className="cursor-pointer font-medium">审读范围与未验证项</summary>
                                <div className="mt-2 text-xs">
                                    {report.coverage.map((item) => (
                                        <p key={item.sourceId}>
                                            {sourceName(item.sourceId)}：{item.mode} · {item.note}
                                        </p>
                                    ))}
                                    <p>
                                        所选集数：{binding?.selectedEpisodes.join("、")}；所选成员中未完成、未审的集数：{binding?.omittedEpisodes.join("、") || "无"}
                                    </p>
                                    {report.limitations.map((item, index) => (
                                        <p key={index}>{item}</p>
                                    ))}
                                </div>
                            </details>
                            <div className="py-2">
                                {report.checks.map((item) => (
                                    <div key={item.key} className="border-b py-2" style={{ borderColor: theme.node.stroke }}>
                                        <div className="flex flex-wrap justify-between gap-2 text-xs font-semibold">
                                            <span>{screenplayAuditChecks[item.key]}</span>
                                            <span>{item.verdict}</span>
                                        </div>
                                        <p className="text-xs" style={{ color: theme.node.muted }}>
                                            {item.note}
                                        </p>
                                    </div>
                                ))}
                            </div>
                            {findings.length ? (
                                findings.map((item) => (
                                    <article key={item.id} className="border-b py-4" style={{ borderColor: theme.node.stroke }}>
                                        <h3 className="text-sm font-semibold">
                                            {item.severity} · {item.title}{" "}
                                            <span className="font-normal" style={{ color: theme.node.muted }}>
                                                {item.certainty}
                                            </span>
                                        </h3>
                                        <p>定位：{item.location}</p>
                                        {item.evidence.map((e, index) => (
                                            <blockquote key={index} className="my-2 border-l-2 pl-3 text-xs" style={{ borderColor: theme.node.stroke }}>
                                                <div style={{ color: theme.node.muted }}>{sourceName(e.sourceId)}</div>
                                                <p className="whitespace-pre-wrap">{e.quote}</p>
                                            </blockquote>
                                        ))}
                                        <p>依据：{item.basis}</p>
                                        <p>影响：{item.impact}</p>
                                        <p>最小修改：{item.suggestion}</p>
                                        <p>复检条件：{item.recheck}</p>
                                        <details className="mt-2">
                                            <summary className="cursor-pointer text-xs">修复提示词 · 未写入原稿</summary>
                                            <p className="mt-2 whitespace-pre-wrap break-words text-xs">{item.repairPrompt}</p>
                                        </details>
                                    </article>
                                ))
                            ) : (
                                <p className="py-4">在所述检查范围内未发现需修复的问题；未验证项不视为通过。</p>
                            )}
                            {report.repairPrompt ? (
                                <details className="py-4">
                                    <summary className="cursor-pointer font-medium">综合修复提示词</summary>
                                    <p className="mt-2 whitespace-pre-wrap break-words">{report.repairPrompt}</p>
                                </details>
                            ) : null}
                            </details>)}
                        </>
                    ) : (
                        <>
                            <p role="alert">{node.metadata?.errorDetails || node.metadata?.taskStage || "等待审核结果"}</p>
                            {node.metadata?.shortDrama?.screenplayAudit?.rawResult ? <pre className="mt-4 whitespace-pre-wrap break-words text-xs">{node.metadata.shortDrama.screenplayAudit.rawResult}</pre> : null}
                        </>
                    )}
                    {review ? <AutoReviewRecord review={review} outdated={state.outdated || Boolean(report && stale)} borderColor={theme.node.stroke} mutedColor={theme.node.muted} sourceName={sourceName} /> : null}
                </div>
            </section>
            <AppModal open={pendingAction !== null} title={pendingAction === "restore" ? "恢复修复前版本？" : "再次诊断当前正文？"} okText={pendingAction === "restore" ? "确认恢复" : "继续设置"} cancelText="取消" onCancel={() => setPendingAction(null)} onOk={() => {
                if (!body || busy) return;
                const action = pendingAction;
                setPendingAction(null);
                if (action === "restore") onRestore?.(body.id);
                else if (action === "reaudit") onReaudit(body.id);
            }}>
                <p>{pendingAction === "restore" ? "恢复后将替换当前正文，并清除当前诊断结论。请确认需要撤回本次修复。" : "当前正文已审核通过，无需重复诊断。继续将打开诊断设置，提交后会重新调用模型，并可能产生费用。"}</p>
            </AppModal>
        </>
    );
}
