import { Button } from "antd";
import { Eye, FileSearch, PencilLine, Play, RotateCcw, WandSparkles, X } from "lucide-react";
import type { SyntheticEvent } from "react";
import { AppModal } from "@/components/ui/product/app-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { ShortDramaGlobalSettings } from "@/lib/short-drama-settings";
import { autoReviewOutdated, latestBodyAudit, screenplayAuditState, screenplayAuditChecks, type AutoReviewRound, type AutoReviewState } from "@/lib/canvas/workflow-screenplay-audit";
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

export function CanvasScreenplayNodeContent({ node, nodes, settings, onRepair, onReport, onAudit, onEdit, onResume }: AuditProps) {
    const theme = canvasThemes[useActiveTheme()];
    const isReport = node.metadata?.shortDrama?.step === "story.audit";
    const reportNode = isReport ? node : latestBodyAudit(node, nodes);
    const state = screenplayAuditState(reportNode, nodes, settings);
    const detailsNodeId = reportNode?.id || node.id;
    const bodyNode = isReport ? nodes.find((source) => source.id === reportNode?.metadata?.shortDrama?.screenplayAudit?.bodyNodeId) : node;
    const badge = autoReviewBadge(autoReviewOf(bodyNode));
    const canResume = Boolean(onResume && bodyNode && canRetryReview(autoReviewOf(bodyNode)));
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
            <div
                className="thin-scrollbar mt-2 flex min-h-10 min-w-0 shrink-0 items-center justify-start gap-1 overflow-x-auto border-t pt-2"
                style={{ borderColor: theme.node.stroke }}
                data-canvas-no-zoom
                onPointerDown={stopCanvasEvent}
                onMouseDown={stopCanvasEvent}
                onWheel={stopCanvasEvent}
            >
                <CanvasNodeActionButton theme={theme} label="编辑" icon={<PencilLine size={14} />} onClick={onEdit} primary />
                <CanvasNodeActionButton theme={theme} label={state.report ? "重新审核" : "诊断"} icon={<FileSearch size={14} />} onClick={onAudit} />
                <CanvasNodeActionButton theme={theme} label="详情" icon={<Eye size={14} />} onClick={() => onReport(detailsNodeId)} />
                {canResume && bodyNode ? <CanvasNodeActionButton theme={theme} label="重试自动修复" icon={<Play size={14} />} onClick={() => onResume?.(bodyNode.id)} /> : null}
                {!state.stale && state.report?.findings.length && reportNode ? (
                    <CanvasNodeActionButton theme={theme} label="修复正文" icon={<WandSparkles size={14} />} onClick={() => onRepair(reportNode.id)} />
                ) : null}
                {badge ? (
                    <span className="min-w-0 truncate whitespace-nowrap px-1 text-xs" style={{ color: theme.node.muted }} title={badge.title}>
                        {badge.text}
                    </span>
                ) : null}
                {state.report && !badge ? (
                    <span className="min-w-0 truncate whitespace-nowrap px-1 text-xs" style={{ color: theme.node.muted }} title={state.stale ? "诊断待复检" : `${state.report.findings.length} 项诊断问题`}>
                        {state.stale ? "待复检" : `${state.report.findings.length} 项问题`}
                    </span>
                ) : null}
                {!isReport && node.metadata?.shortDrama?.screenplayRepair && !state.report ? (
                    <span className="min-w-0 truncate whitespace-nowrap px-1 text-xs" style={{ color: theme.node.muted }}>
                        修复版 · 待复检
                    </span>
                ) : null}
            </div>
        </section>
    );
}

function AutoReviewRecord({ review, outdated, borderColor, mutedColor, sourceName }: { review: AutoReviewState; outdated?: boolean; borderColor: string; mutedColor: string; sourceName: (id: string) => string }) {
    const statusText = review.status === "passed" ? "已通过" : review.status === "settled" ? "已完成，仍有待留意项" : review.status === "manual" ? "已中断" : review.status === "repairing" ? "修复中" : "诊断中";
    const lastRound = review.rounds[review.rounds.length - 1]?.round;
    return (
        <section className="mb-4 border-b pb-4" style={{ borderColor }} aria-label="自动诊断修复记录">
            <h3 className="text-sm font-semibold">自动诊断修复记录 · {statusText}</h3>
            <p className="text-xs" style={{ color: mutedColor }}>
                轮数 {review.rounds.length}/{review.maxRounds} · 开始 {review.startedAt}
                {review.finishedAt ? ` · 结束 ${review.finishedAt}` : ""}
            </p>
            {outdated ? <p className="mt-1 break-words text-xs" style={{ color: mutedColor }}>正文已在该记录之后被修改，以下记录对应旧版本。</p> : null}
            {review.stopReason ? <p className="mt-1 break-words text-xs">结束说明：{review.stopReason}</p> : null}
            {review.rounds.map((round) => {
                const repair = round.repair;
                return (
                    <details key={round.round} className="mt-2 border-t pt-2" style={{ borderColor }} open={round.round === lastRound}>
                        <summary className="cursor-pointer text-xs font-medium">
                            第{round.round}轮 · 质量 {round.quality} · 可用性 {round.usability} · 阻塞 {round.blocking} 项 · {roundResultLabel(round)}
                        </summary>
                        <div className="mt-2 text-xs leading-6">
                            <p className="whitespace-pre-wrap break-words">{round.summary}</p>
                            {round.parseRetries ? <p style={{ color: mutedColor }}>报告格式不合规，自动重审 {round.parseRetries} 次</p> : null}
                            {round.checks?.length ? (
                                <div className="mt-2">
                                    <strong>正文验收维度</strong>
                                    {round.checks.map((check) => (
                                        <p key={check.key} className="break-words">
                                            {screenplayAuditChecks[check.key] || check.key}：{check.verdict}
                                            <span style={{ color: mutedColor }}> · {check.note}</span>
                                        </p>
                                    ))}
                                </div>
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
                                    <article key={item.id} className="mt-2 break-words">
                                        <strong>
                                            {item.severity} · {item.title}
                                        </strong>{" "}
                                        <span style={{ color: mutedColor }}>
                                            {item.certainty} · {item.blocking ? "阻塞" : "不阻塞"}
                                        </span>
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
                                    </article>
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
        </section>
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
    const { report, stale } = screenplayAuditState(node, nodes, settings);
    const binding = node.metadata?.shortDrama?.screenplayAudit;
    const inline = nodeWorkflow(node)?.step === "story.body" && binding?.bodyNodeId === node.id;
    const body = inline ? node : nodes.find((source) => source.id === binding?.bodyNodeId);
    const findings = [...(report?.findings || [])].sort((a, b) => a.severity.localeCompare(b.severity));
    const sourceName = (id: string) => nodes.find((source) => source.id === id)?.title || id;
    // 有自动诊断记录时，完整报告已按轮次收进记录里，外层只保留结论摘要。
    const hasAuto = Boolean(autoReviewOf(body)?.rounds.length);
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
                    <Button size="small" icon={<RotateCcw size={14} />} disabled={!body} onClick={() => body && onReaudit(body.id)}>
                        {report ? "重新审核" : "诊断"}
                    </Button>
                    <Button size="small" icon={<WandSparkles size={14} />} disabled={stale || !findings.length} onClick={() => body && onRepair(inline ? body.id : node.id)}>
                        修复正文
                    </Button>
                    {body?.metadata?.shortDrama?.screenplayRepair?.previousContent !== undefined && onRestore ? (
                        <Button size="small" type="text" onClick={() => onRestore(body.id)}>
                            恢复修复前版本
                        </Button>
                    ) : null}
                    {body && onResume && canRetryReview(autoReviewOf(body)) ? (
                        <Button size="small" icon={<Play size={14} />} onClick={() => onResume(body.id)}>
                            重试自动修复
                        </Button>
                    ) : null}
                    <Button size="small" type="text" icon={<X size={17} />} aria-label="关闭正文诊断报告" onClick={onClose} />
                </header>
                <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-5 text-sm leading-7">
                    {stale ? (
                        <p role="status" className="mb-4 font-semibold">
                            {report ? "正文、依据或全局设定已变化，此报告待复检，不能用于修复。" : "报告尚未完成或格式校验未通过，未判定正文审核通过。"}
                        </p>
                    ) : null}
                    {autoReviewOf(body) ? <AutoReviewRecord review={autoReviewOf(body) as AutoReviewState} outdated={body ? autoReviewOutdated(autoReviewOf(body) as AutoReviewState, body) : false} borderColor={theme.node.stroke} mutedColor={theme.node.muted} sourceName={sourceName} /> : null}
                    {report ? (
                        <>
                            <div className="border-b pb-4" style={{ borderColor: theme.node.stroke }}>
                                <div>
                                    内容质量：<strong>{report.quality}</strong>
                                </div>
                                <div>
                                    进入分镜可用性：<strong>{report.usability}</strong>
                                </div>
                                <p className="mt-2 whitespace-pre-wrap">{report.summary}</p>
                                <p className="text-xs" style={{ color: theme.node.muted }}>
                                    模型诊断不代表作者确认 · 修复直接更新当前正文 · 修复后需重新审核
                                </p>
                            </div>
                            {hasAuto ? null : (<>
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
                            </>)}
                        </>
                    ) : (
                        <>
                            <p role="alert">{node.metadata?.errorDetails || node.metadata?.taskStage || "等待审核结果"}</p>
                            {node.metadata?.shortDrama?.screenplayAudit?.rawResult ? <pre className="mt-4 whitespace-pre-wrap break-words text-xs">{node.metadata.shortDrama.screenplayAudit.rawResult}</pre> : null}
                        </>
                    )}
                </div>
            </section>
        </>
    );
}
