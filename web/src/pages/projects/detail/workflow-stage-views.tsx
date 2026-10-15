import { Button, Input } from "antd";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AudioLines, BookOpen, CheckCircle2, Clock3, FileCheck2, Film, Layers3, MapPinned, Mic2, Music2, PackageCheck, Palette, Plus, Scissors, Settings2, ShieldCheck, Sparkles, TimerReset, Upload, UsersRound, X } from "lucide-react";
import { Link } from "react-router";

import { ASSET_CATEGORIES } from "@/lib/asset-category";
import { getProjectUnitWorkspace, listProjectAssetsPage, type ProjectDetail } from "@/services/api/projects";
import { getActiveUserScope } from "@/lib/user-scope";
import { resourceFileUrl } from "@/services/api/resources";
import {
    addLocalDeliveryIssue,
    canVerifyLocalDelivery,
    isLocalDeliveryCurrent,
    loadLocalDeliverySnapshot,
    resolveLocalDeliveryIssue,
    updateLocalDeliveryReview,
    type DeliveryIssueSeverity,
} from "@/services/short-drama-delivery-store";
import { assessShotTimelineDependencies, shotDependencyFingerprint } from "@/lib/timeline/shot-dependencies";
import { parseVoiceTiming } from "@/lib/timeline/voice-assembly";
import { loadProjectEditorTimeline } from "@/services/project-editor-timeline";
import { timelineFingerprint } from "@/services/short-drama-delivery-store";
import { captureDeliveryIssuePosition, formatReviewTime, locateDeliveryIssuePosition, reviewClipsAt, type DeliveryIssuePosition } from "@/lib/timeline/review-position";

import { assetCategoryLabel, currentRevision, formatDuration, MetricCard, StageHeading } from "./workflow-shared";

function useDeliverySnapshot(projectId: string, unitId: string) {
    const scope = getActiveUserScope();
    const query = useQuery({
        queryKey: ["local-short-drama-delivery", scope, projectId, unitId],
        queryFn: () => loadLocalDeliverySnapshot(projectId, unitId, scope),
        retry: false,
        refetchOnWindowFocus: "always",
        refetchInterval: 3000,
    });
    const delivery = query.data?.record || null;
    const timeline = query.data?.timeline || null;
    const currentTimelineFingerprint = query.data?.currentTimelineFingerprint || null;
    const isCurrent = !query.isError && isLocalDeliveryCurrent(delivery, currentTimelineFingerprint);
    const timelineWarning = delivery && !query.isError && !isCurrent
        ? currentTimelineFingerprint ? "时间线已修改，此成片需要重新渲染和审片" : "当前集时间线尚未保存，暂不能核验此成片"
        : "";
    return { query, scope, delivery, timeline, currentTimelineFingerprint, timelineWarning };
}

function DeliveryReadError({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
    return error ? <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-xs text-[var(--status-error)]"><span>交付记录读取失败：{error.message}</span><Button size="small" onClick={onRetry}>重试读取</Button></div> : null;
}

export function StoryStage({ detail, projectId, unitId }: { detail: ProjectDetail; projectId: string; unitId: string }) {
    const unit = detail.units.find((item) => item.id === unitId)!;
    const hasText = Boolean(unit.sourceText.trim());
    const hasShots = detail.shots.some((shot) => shot.unitId === unit.id);
    const storyTasks = [
        { id: "story.setup", icon: <Settings2 className="size-4" />, label: "制作设置", description: "复用项目设置中的制作形式、画幅、集数与制作要求。", value: detail.project.aspectRatio || "待设置", tone: detail.project.aspectRatio ? "ready" : "pending", href: `/projects/${projectId}/settings`, action: "打开项目设置" },
        { id: "story.import", icon: <Upload className="size-4" />, label: "原稿导入与章节结构", description: "当前集沿用已有章节正文；导入与拆分不会覆盖已有章节。", value: hasText ? `${unit.wordCount || 0} 字` : "待导入", tone: hasText ? "ready" : "pending", href: `/projects/${projectId}/chapters/${unit.id}`, action: "编辑章节" },
        { id: "story.develop", icon: <Sparkles className="size-4" />, label: "剧情开发", description: "梗概、主线、人物关系与世界观先作为候选内容，当前字段不足时明确待补充。", value: detail.project.description?.trim() ? "已有项目描述" : "待补充", tone: detail.project.description?.trim() ? "ready" : "pending", href: `/projects/${projectId}/overview`, action: "查看项目概览" },
        { id: "story.script", icon: <BookOpen className="size-4" />, label: "分集 / 场次脚本", description: "复用当前集分镜与修订版本，镜头内容继续在现有分镜工作台编辑。", value: hasShots ? `${detail.shots.filter((shot) => shot.unitId === unit.id).length} 个镜头` : "待拆分", tone: hasShots ? "ready" : "pending", href: `/projects/${projectId}/workflow/${unit.id}/storyboard`, action: "打开分镜脚本" },
        { id: "story.approve", icon: <FileCheck2 className="size-4" />, label: "剧本审核", description: "现有数据没有独立剧本审核记录，不能用正文存在直接推断审核通过。", value: "待复核", tone: "pending", href: `/projects/${projectId}/chapters/${unit.id}`, action: "返回章节" },
    ] as const;
    return <section className="mx-auto max-w-6xl">
        <StageHeading eyebrow="01 / 剧情与章节" title={unit.title} description="从制作设置、原稿与章节结构，到剧情开发、分集脚本和审核，当前阶段复用现有项目入口并明确未接入的确认记录。" />
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{storyTasks.map((task) => <div key={task.id} data-task-key={task.id} className="rounded-xl border border-border/70 bg-surface p-4">
            <div className="flex items-start gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent)]">{task.icon}</span><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-3"><h3 className="text-sm font-semibold">{task.label}</h3><span className={`shrink-0 text-xs ${task.tone === "ready" ? "text-[var(--status-success)]" : "text-foreground/45"}`}>{task.value}</span></div><p className="mt-2 text-xs leading-5 text-foreground/48">{task.description}</p></div></div>
            <Link className="mt-4 inline-flex text-xs font-medium text-[var(--workspace-accent)] hover:underline" to={task.href}>{task.action} →</Link>
        </div>)}</div>
        <div className="mt-5 rounded-xl border border-border/70 bg-surface p-5"><div className="mb-3 flex items-center justify-between gap-3"><span className="text-xs font-medium text-foreground/55">当前章节原文</span><Link to={`/projects/${projectId}/chapters/${unit.id}`}><Button size="small">编辑章节</Button></Link></div><div className="max-h-[42vh] overflow-y-auto whitespace-pre-wrap text-sm leading-7 text-foreground/78">{unit.sourceText || "当前章节还没有正文。请先在剧情章节中上传小说或添加内容。"}</div></div>
    </section>;
}

export function AssetsStage({ detail, projectId, unitId }: { detail: ProjectDetail; projectId: string; unitId: string }) {
    const candidates = detail.assetCandidates.filter((item) => !item.unitId || item.unitId === unitId);
    const assetCountsQuery = useQuery({ queryKey: ["project", projectId, "assets", "workflow-counts"], queryFn: () => listProjectAssetsPage(projectId, { page: 1, pageSize: 1 }) });
    const confirmedCounts = assetCountsQuery.data?.categoryCounts || {};
    const styleReady = Boolean(detail.project.stylePresetId || detail.project.styleProfileJson);
    const pendingCandidates = candidates.filter((item) => item.status === "pending_confirmation").length;
    const characterCount = confirmedCounts.character || 0;
    const environmentCount = (confirmedCounts.environment || 0) + (confirmedCounts.prop || 0);
    const assetTasks = [
        { id: "assets.style", icon: <Palette className="size-4" />, label: "项目画风与视觉规范", description: "沿用项目设置中的画风版本；未选择时不会把默认主题当作已确认风格。", value: styleReady ? "已设置" : "待选择", tone: styleReady ? "ready" : "pending", href: `/projects/${projectId}/settings`, action: "打开项目设置" },
        { id: "assets.extract", icon: <MapPinned className="size-4" />, label: "剧本提取候选与归并", description: "候选资产保留当前集范围和确认状态，重复提取不自动覆盖已确认资产。", value: candidates.length ? `${candidates.length} 个候选` : "待提取", tone: candidates.length ? "ready" : "pending", href: `/projects/${projectId}/chapters/${unitId}`, action: "检查章节资产" },
        { id: "assets.characters", icon: <UsersRound className="size-4" />, label: "角色版本与声音画像", description: "角色需要有可用版本后才能在镜头工作台绑定；声线状态在配音阶段单独展示。", value: `${characterCount} 个角色`, tone: characterCount ? "ready" : "pending", href: `/projects/${projectId}/assets`, action: "打开角色资产" },
        { id: "assets.environments", icon: <Layers3 className="size-4" />, label: "场景、道具与素材版本", description: "场景和道具继续使用项目资产库，镜头引用具体版本，不在流程页复制一份资产。", value: `${environmentCount} 个场景/道具`, tone: environmentCount ? "ready" : "pending", href: `/projects/${projectId}/assets`, action: "打开资产库" },
        { id: "assets.approve", icon: <ShieldCheck className="size-4" />, label: "资产版本与一致性确认", description: pendingCandidates ? `${pendingCandidates} 个候选仍待处理；当前页面不把数量当作审核通过。` : "当前没有待确认候选；正式审核记录仍沿用资产库状态。", value: pendingCandidates ? `${pendingCandidates} 待确认` : "待复核", tone: "pending", href: `/projects/${projectId}/assets`, action: "检查确认状态" },
    ] as const;
    return <section className="mx-auto max-w-6xl">
        <StageHeading eyebrow="02 / 资产拆分" title="确认镜头真正会使用的资产" description="角色、场景、道具、素材与其他资产先建立稳定版本，镜头再绑定具体版本；每个子任务都沿用现有项目入口。" />
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{assetTasks.map((task) => <div key={task.id} data-task-key={task.id} className="rounded-xl border border-border/70 bg-surface p-4">
            <div className="flex items-start gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent)]">{task.icon}</span><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-3"><h3 className="text-sm font-semibold">{task.label}</h3><span className={`shrink-0 text-xs ${task.tone === "ready" ? "text-[var(--status-success)]" : "text-foreground/45"}`}>{task.value}</span></div><p className="mt-2 text-xs leading-5 text-foreground/48">{task.description}</p></div></div>
            <Link className="mt-4 inline-flex text-xs font-medium text-[var(--workspace-accent)] hover:underline" to={task.href}>{task.action} →</Link>
        </div>)}</div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-y border-border/70 py-5"><div><h3 className="text-sm font-semibold">资产库承担正式版本确认</h3><p className="mt-1 text-xs text-foreground/48">确认后可直接在分镜工作台左栏绑定到镜头；工作台不复制资产主记录。</p></div><Link to={`/projects/${projectId}/assets`}><Button type="primary">打开资产库</Button></Link></div>
    </section>;
}

export function DeliveryStage({ detail, unitId }: { detail: ProjectDetail; unitId: string }) {
    const shots = detail.shots.filter((item) => item.unitId === unitId);
    const readyVideos = shots.filter((shot) =>
        detail.shotArtifacts.some((item) => item.shotId === shot.id && item.type === "video" && item.selected && item.status === "ready"),
    );
    const stale = detail.shotArtifacts.filter((item) => item.unitId === unitId && item.status === "stale").length;
    const { query, delivery, currentTimelineFingerprint, timelineWarning } = useDeliverySnapshot(detail.project.id, unitId);
    const dependency = query.data?.timeline ? assessShotTimelineDependencies({ projectId: detail.project.id, unitId, shots, artifacts: detail.shotArtifacts, timeline: query.data.timeline }) : null;
    const verified = !query.isError && delivery?.reviewStatus === "verified" && canVerifyLocalDelivery(delivery, {
        readyShotCount: readyVideos.length, totalShotCount: shots.length, staleArtifactCount: stale, currentTimelineFingerprint,
        currentShotDependencyFingerprint: dependency?.currentFingerprint ?? null,
    });
    const unresolvedIssues = delivery?.issues.filter((issue) => !issue.resolvedAt).length || 0;
    const blockers = [
        shots.length === 0 ? "当前集还没有镜头" : "",
        readyVideos.length !== shots.length ? `还有 ${Math.max(0, shots.length - readyVideos.length)} 个镜头没有确认视频` : "",
        stale ? `${stale} 个过期产物需要复核` : "",
        unresolvedIssues ? `${unresolvedIssues} 个审片问题尚未关闭` : "",
        timelineWarning,
        ...(delivery && dependency && !dependency.ok ? dependency.blockers : []),
        query.isPending ? "正在读取当前集的时间线与审片记录" : query.isError ? "交付记录读取失败，尚不能确认版本" : !delivery ? "尚未生成当前集审片成片" : delivery.reviewStatus !== "verified" ? "当前成片尚未通过人工审片" : "",
    ].filter(Boolean);

    return (
        <section className="mx-auto max-w-5xl">
            <StageHeading
                eyebrow="08 / 导出交付"
                title="交付前质量门禁"
                description="所有镜头视频就绪、过期产物清零后，再打包成片与生产资料。"
            />
            <DeliveryReadError error={query.error} onRetry={() => void query.refetch()} />
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
                <MetricCard icon={<Film className="size-5" />} label="视频已就绪" value={`${readyVideos.length} / ${shots.length}`} />
                <MetricCard
                    icon={<Clock3 className="size-5" />}
                    label="总时长"
                    value={formatDuration(shots.reduce((total, item) => total + item.durationMs, 0))}
                />
                <MetricCard icon={<Layers3 className="size-5" />} label="过期产物" value={String(stale)} />
            </div>
            <div className="mt-5 border-y border-border/70 py-5">
                <div className="flex items-start gap-3">
                    <PackageCheck className="mt-0.5 size-5 text-[var(--workspace-accent)]" />
                    <div>
                        <h3 className="text-sm font-semibold">计划交付内容</h3>
                        <p className="mt-1 text-xs leading-5 text-foreground/48">
                            成片 MP4、字幕 SRT、分镜 JSON/CSV、资产清单和生成参数 ZIP。
                        </p>
                    </div>
                </div>
                {blockers.length ? <div className="mt-5 rounded-lg border border-[var(--status-warning)]/30 bg-[var(--status-warning)]/8 p-3 text-xs leading-5 text-foreground/65"><strong>当前不能确认交付</strong><ul className="mt-1 list-disc pl-4">{blockers.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
                <div className="mt-5 flex flex-wrap items-center gap-3">
                    <Link to={`/projects/${detail.project.id}/editor/${unitId}`}><Button type="primary">打开剪辑器核验</Button></Link>
                    {delivery?.resourceId ? <a className="ant-btn" href={resourceFileUrl(delivery.resourceId)} download={delivery.fileName || "timeline.mp4"}>{verified ? "下载已核验成片" : "下载待复核成片"}</a> : null}
                </div>
                <div className="mt-5 rounded-lg border border-border/70 bg-surface p-3 text-xs leading-5 text-foreground/55">
                    <div className="flex items-center gap-2 text-foreground/75"><ShieldCheck className="size-4" />交付记录</div>
                    {delivery ? <p className="mt-2">{delivery.fileName || "timeline.mp4"} · {verified ? "已完成人工核验" : "待人工核验"} · {new Date(delivery.renderedAt).toLocaleString("zh-CN")}</p> : query.isPending ? <p className="mt-2">正在读取交付记录…</p> : !query.isError ? <p className="mt-2">尚未记录当前集的服务端渲染结果。请先在剪辑器导出成片。</p> : null}
                    <p className="mt-1">资料 ZIP、平台发布和外部交付仍属于后续增强；当前记录只绑定本集 MP4、时间线版本和审片问题。</p>
                </div>
            </div>
        </section>
    );
}

export function VoiceStage({ detail, projectId, unitId }: { detail: ProjectDetail; projectId: string; unitId: string }) {
    const shots = detail.shots.filter((item) => item.unitId === unitId).sort((left, right) => left.position - right.position);
    const dialogueShots = shots.filter((shot) => Boolean(currentRevision(detail, shot)?.dialogue.trim())).length;
    const characterVoices = detail.assets.filter((asset) => asset.category === "character" && asset.character?.voiceStatus === "ready").length;
    const selectedAudio = detail.shotArtifacts.filter((artifact) => artifact.unitId === unitId && artifact.type === "audio" && artifact.selected);
    const readyAudio = selectedAudio.filter((artifact) => artifact.status === "ready" && Boolean(artifact.resourceId));
    const timedAudio = readyAudio.filter((artifact) => Boolean(parseVoiceTiming(artifact.metadataJson).timing)).length;
    const voiceTasks = [
        { id: "voice.dialogue", icon: <AudioLines className="size-4" />, label: "台词、旁白与声音设计", description: `${dialogueShots} 个镜头已有对白内容；无对白镜头可继续视频制作。`, value: dialogueShots ? `${dialogueShots} 个镜头` : "待补充", tone: dialogueShots ? "ready" : "pending", href: `/projects/${projectId}/workflow/${unitId}/storyboard`, action: "检查分镜对白" },
        { id: "voice.casting", icon: <Mic2 className="size-4" />, label: "角色声线与试听", description: "沿用角色资产中的声音配置和素材库试听能力。", value: characterVoices ? `${characterVoices} 个角色声线` : "待配置", tone: characterVoices ? "ready" : "pending", href: `/projects/${projectId}/assets`, action: "打开角色资产" },
        { id: "voice.recording", icon: <Music2 className="size-4" />, label: "配音、音乐与音效素材", description: "采用的音频产物必须属于当前镜头版本且资源已就绪。", value: `${readyAudio.length}/${selectedAudio.length} 可用`, tone: readyAudio.length ? "ready" : "pending", href: `/projects/${projectId}/assets`, action: "打开声音素材" },
        { id: "voice.timing", icon: <TimerReset className="size-4" />, label: "音画对齐与混音", description: "只有明确对白/镜头内区间并确认媒体时长后，才允许进入当前集音轨。", value: readyAudio.length && timedAudio === readyAudio.length ? `${timedAudio} 段已具备区间` : `${timedAudio}/${readyAudio.length} 段有区间`, tone: readyAudio.length && timedAudio === readyAudio.length ? "ready" : "pending", href: `/projects/${projectId}/editor/${unitId}`, action: "打开当前集剪辑器" },
    ] as const;
    return <section className="mx-auto max-w-5xl">
        <StageHeading eyebrow="04 / 配音与声音" title="把角色声音带入镜头制作" description="沿用资产库中的角色声线、试听和音频生成入口；当前阶段把对白、声音素材和音画对齐拆开显示，状态不足时明确保留待处理。" />
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {voiceTasks.map((task) => <div key={task.id} data-task-key={task.id} className="rounded-xl border border-border/70 bg-surface p-4">
                <div className="flex items-start gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent)]">{task.icon}</span><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-3"><h3 className="text-sm font-semibold">{task.label}</h3><span className={`shrink-0 text-xs ${task.tone === "ready" ? "text-[var(--status-success)]" : "text-foreground/45"}`}>{task.value}</span></div><p className="mt-2 text-xs leading-5 text-foreground/48">{task.description}</p></div></div>
                <Link className="mt-4 inline-flex text-xs font-medium text-[var(--workspace-accent)] hover:underline" to={task.href}>{task.action} →</Link>
            </div>)}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-y border-border/70 py-5"><div><h3 className="text-sm font-semibold">当前集声音入轨</h3><p className="mt-1 text-xs text-foreground/48">按镜头区间追加声音会进入现有音轨，并支持一次撤销、重做和保存恢复。</p></div><Link to={`/projects/${projectId}/editor/${unitId}`}><Button type="primary" icon={<Scissors className="size-4" />}>打开当前集剪辑器</Button></Link></div>
    </section>;
}

export function EditStage({ projectId, unitId }: { projectId: string; unitId: string }) {
    return <LinkedStage
        eyebrow="06 / 剪辑与后期"
        title="在现有时间线中完成剪辑"
        description="进入原有剪辑器继续处理镜头排序、声音、字幕和导出。编辑器按用户与集数保存本地时间线，当前不会自动覆盖其他集。"
        icon={<Scissors className="size-5" />}
        actionLabel="打开当前集剪辑器"
        actionHref={`/projects/${projectId}/editor/${unitId}`}
        secondaryLabel="返回镜头视频"
        secondaryHref={`/projects/${projectId}/workflow/${unitId}/video`}
    />;
}

export function ReviewStage({ detail, projectId, unitId }: { detail: ProjectDetail; projectId: string; unitId: string }) {
    const shots = detail.shots.filter((item) => item.unitId === unitId);
    const readyVideos = shots.filter((shot) => detail.shotArtifacts.some((item) => item.shotId === shot.id && item.type === "video" && item.selected && item.status === "ready"));
    const stale = detail.shotArtifacts.filter((item) => item.unitId === unitId && item.status === "stale").length;
    const { query, scope, delivery, currentTimelineFingerprint, timelineWarning } = useDeliverySnapshot(projectId, unitId);
    const dependency = query.data?.timeline ? assessShotTimelineDependencies({ projectId, unitId, shots, artifacts: detail.shotArtifacts, timeline: query.data.timeline }) : null;
    const [issueNote, setIssueNote] = useState("");
    const [issueSeverity, setIssueSeverity] = useState<DeliveryIssueSeverity>("major");
    const [issuePosition, setIssuePosition] = useState<DeliveryIssuePosition>();
    const reviewVideo = useRef<HTMLVideoElement>(null);
    const [readyRender, setReadyRender] = useState("");
    const renderKey = delivery ? `${delivery.resourceId}:${delivery.renderedAt}` : "";
    const [savingIssue, setSavingIssue] = useState(false);
    const [mutationError, setMutationError] = useState("");
    const unresolvedIssues = delivery?.issues.filter((issue) => !issue.resolvedAt) || [];
    const canVerify = !query.isError && canVerifyLocalDelivery(delivery, {
        readyShotCount: readyVideos.length,
        totalShotCount: shots.length,
        staleArtifactCount: stale,
        currentTimelineFingerprint,
        currentShotDependencyFingerprint: dependency?.currentFingerprint ?? null,
    });
    const dependencyWarning = dependency && !dependency.ok ? dependency.blockers[0] : "";
    const verified = canVerify && delivery?.reviewStatus === "verified";
    const capturePosition = () => {
        const video = reviewVideo.current;
        if (!delivery || !video || readyRender !== renderKey || video.readyState < 1) return;
        video.pause();
        try {
            const timeMs = Math.floor(video.currentTime * 1000);
            const clips = reviewClipsAt(delivery, timeMs);
            setIssuePosition(captureDeliveryIssuePosition(delivery, timeMs, clips.length === 1 ? clips[0].id : undefined));
            setMutationError("");
        } catch (error) { setMutationError(error instanceof Error ? error.message : "时间点读取失败"); }
    };
    const seekIssue = (position: DeliveryIssuePosition) => {
        const video = reviewVideo.current;
        if (!delivery || !video || readyRender !== renderKey || video.readyState < 1) return;
        const location = locateDeliveryIssuePosition(position, delivery);
        if ("reason" in location) return setMutationError(location.reason);
        if (!Number.isFinite(video.duration) || location.timeMs > video.duration * 1000) return setMutationError("时间点超出实际播放文件时长，请核对审片文件");
        video.pause();
        video.currentTime = location.timeMs / 1000;
        setMutationError("");
        video.scrollIntoView({ block: "nearest" });
    };
    const addIssue = async () => {
        if (!issueNote.trim() || !delivery || savingIssue || query.isError) return;
        setSavingIssue(true);
        setMutationError("");
        try {
            await addLocalDeliveryIssue(projectId, unitId, issueSeverity, issueNote, delivery, scope, issuePosition);
            setIssueNote("");
            setIssuePosition(undefined);
            await query.refetch();
        } catch (error) {
            setMutationError(error instanceof Error ? error.message : "保存审片问题失败，请重试");
        } finally {
            setSavingIssue(false);
        }
    };
    const verifyDelivery = async () => {
        if (!canVerify || !delivery || savingIssue) return;
        setSavingIssue(true);
        setMutationError("");
        try {
            const workspace = await getProjectUnitWorkspace(projectId, unitId);
            if (getActiveUserScope() !== scope) throw new Error("账号已切换，本次审片确认已取消");
            const currentShots = workspace.shots.filter((shot) => shot.unitId === unitId);
            const latestTimeline = await loadProjectEditorTimeline(projectId, unitId, scope);
            if (!latestTimeline) throw new Error("当前集时间线尚未保存，暂不能确认审片");
            const latestDependency = assessShotTimelineDependencies({ projectId, unitId, shots: currentShots, artifacts: workspace.shotArtifacts, timeline: latestTimeline });
            if (!latestDependency.ok) throw new Error(`当前镜头来源尚未同步：${latestDependency.blockers[0]}`);
            await updateLocalDeliveryReview(projectId, unitId, "verified", delivery, {
                readyShotCount: currentShots.filter((shot) => workspace.shotArtifacts.some((artifact) => artifact.shotId === shot.id && artifact.type === "video" && artifact.selected && artifact.status === "ready")).length,
                totalShotCount: currentShots.length,
                staleArtifactCount: workspace.shotArtifacts.filter((artifact) => artifact.unitId === unitId && artifact.status === "stale").length,
                currentTimelineFingerprint: timelineFingerprint(latestTimeline),
                currentShotDependencyFingerprint: latestDependency.currentFingerprint,
            }, scope);
            await query.refetch();
        } catch (error) {
            setMutationError(error instanceof Error ? error.message : "审片确认保存失败，请重试");
        } finally { setSavingIssue(false); }
    };
    const resolveIssue = async (issueId: string) => {
        if (!delivery || savingIssue || query.isError) return;
        setSavingIssue(true);
        setMutationError("");
        try {
            await resolveLocalDeliveryIssue(projectId, unitId, issueId, delivery, scope);
            await query.refetch();
        } catch (error) {
            setMutationError(error instanceof Error ? error.message : "关闭审片问题失败，请重试");
        } finally { setSavingIssue(false); }
    };
    return <section className="mx-auto max-w-5xl">
        <StageHeading eyebrow="07 / 成片质检" title="先审片，再导出交付" description="复用现有预览、字幕和导出能力；当前阶段把可确定的缺口展示出来，人工审片仍需要你确认。" />
        <DeliveryReadError error={query.error} onRetry={() => void query.refetch()} />
        {timelineWarning || dependencyWarning ? <p role="status" className="mt-4 text-xs text-[var(--status-warning)]">{timelineWarning || dependencyWarning}</p> : null}
        {mutationError ? <p role="alert" className="mt-4 text-xs text-[var(--status-error)]">{mutationError}</p> : null}
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <MetricCard icon={<CheckCircle2 className="size-5" />} label="可审视频" value={`${readyVideos.length} / ${shots.length}`} />
            <MetricCard icon={<Film className="size-5" />} label="镜头总数" value={String(shots.length)} />
            <MetricCard icon={<Layers3 className="size-5" />} label="过期产物" value={String(stale)} />
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-y border-border/70 py-5">
            <div><h3 className="text-sm font-semibold">审片工作仍在原剪辑器完成</h3><p className="mt-1 text-xs leading-5 text-foreground/48">打开当前集时间线，检查画面、声音、字幕和导出预览。</p></div>
            <Link to={`/projects/${projectId}/editor/${unitId}`}><Button type="primary">打开剪辑器审片</Button></Link>
        </div>
        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,.8fr)]">
            <div className="rounded-xl border border-border/70 bg-surface p-4">
                <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">审片版本</h3><span className="text-xs text-foreground/45">{query.isError ? "读取失败" : query.isPending ? "读取中" : delivery ? (verified ? "已核验" : timelineWarning || dependencyWarning ? "需重新核验" : "待核验") : "未生成"}</span></div>
                {delivery?.resourceId ? <video key={renderKey} ref={reviewVideo} aria-label="审片播放器" className="mt-3 aspect-video w-full rounded-lg bg-black object-contain" src={resourceFileUrl(delivery.resourceId)} controls preload="metadata" onLoadedMetadata={() => setReadyRender(renderKey)} onError={() => setReadyRender("")} /> : <p className="mt-3 text-xs leading-5 text-foreground/48">当前集还没有服务端渲染结果。请在剪辑器导出后返回此处审片。</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="primary" icon={<ShieldCheck className="size-4" />} disabled={!canVerify || verified || savingIssue} onClick={() => void verifyDelivery()}>标记审片通过</Button>
                    {delivery?.resourceId ? <a className="ant-btn" href={resourceFileUrl(delivery.resourceId)} download={delivery.fileName || "timeline.mp4"}>下载审片文件</a> : null}
                </div>
            </div>
            <div className="rounded-xl border border-border/70 bg-surface p-4">
                <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">审片问题</h3><span className="text-xs text-foreground/45">未关闭 {unresolvedIssues.length}</span></div>
                <div className="mt-3 flex gap-2">
                    <select className="h-8 rounded-md border border-border bg-transparent px-2 text-xs" value={issueSeverity} disabled={!delivery || savingIssue || query.isError} onChange={(event) => setIssueSeverity(event.target.value as DeliveryIssueSeverity)} aria-label="审片问题级别"><option value="blocker">阻断</option><option value="major">重要</option><option value="minor">一般</option></select>
                    <Input size="small" value={issueNote} onChange={(event) => setIssueNote(event.target.value)} onPressEnter={(event) => { if (!event.nativeEvent.isComposing) void addIssue(); }} aria-label="审片问题内容" placeholder="记录画面、声音、字幕或连续性问题" disabled={!delivery || savingIssue || query.isError} />
                    <Button size="small" icon={<Plus className="size-3.5" />} loading={savingIssue} disabled={!delivery || !issueNote.trim() || query.isError} onClick={() => void addIssue()} aria-label="添加审片问题" title="添加审片问题" />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <Button size="small" icon={<MapPinned className="size-3.5" />} disabled={!delivery || savingIssue || query.isError || readyRender !== renderKey} onClick={capturePosition}>标记当前时间</Button>
                    {issuePosition ? <>
                        <span className="tabular-nums">{formatReviewTime(issuePosition.timeMs)}</span>
                        <select className="h-8 min-w-0 max-w-full rounded-md border border-border bg-transparent px-2" aria-label="问题关联片段" value={issuePosition.clipId || ""} disabled={savingIssue} onChange={(event) => {
                            try { setIssuePosition(captureDeliveryIssuePosition(issuePosition, issuePosition.timeMs, event.target.value || undefined)); }
                            catch (error) { setMutationError(error instanceof Error ? error.message : "片段定位失败"); }
                        }}>
                            <option value="">仅记录成片时间</option>
                            {reviewClipsAt(issuePosition, issuePosition.timeMs).map((clip) => <option key={clip.id} value={clip.id}>{clip.title || clip.id}</option>)}
                        </select>
                        <Button type="text" size="small" icon={<X className="size-3.5" />} disabled={savingIssue} aria-label="移除问题时间点" title="移除问题时间点" onClick={() => setIssuePosition(undefined)} />
                        {delivery && (issuePosition.resourceId !== delivery.resourceId || issuePosition.timelineFingerprint !== delivery.timelineFingerprint) ? <span role="status" className="text-[var(--status-warning)]">审片文件已更新，请重新标记时间；问题草稿已保留。</span> : null}
                    </> : null}
                </div>
                <div className="mt-3 space-y-2">{delivery?.issues.length ? delivery.issues.map((issue) => {
                    const location = issue.position ? locateDeliveryIssuePosition(issue.position, delivery) : null;
                    const source = issue.position?.clipId ? reviewClipsAt(issue.position, issue.position.timeMs).find((clip) => clip.id === issue.position!.clipId)?.shotSource : undefined;
                    const sourceShot = source?.projectId === projectId && source.unitId === unitId ? shots.find((shot) => shot.id === source.shotId) : undefined;
                    return <div key={issue.id} data-review-issue={issue.id} className={`rounded-md border p-2 text-xs ${issue.resolvedAt ? "border-border/60 opacity-50" : issue.severity === "blocker" ? "border-[var(--status-error)]/35" : "border-border/70"}`}>
                        <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words leading-5">{issue.note}</span>{issue.resolvedAt ? <span className="shrink-0 text-foreground/45">已关闭</span> : <Button type="link" size="small" disabled={savingIssue || query.isError} onClick={() => void resolveIssue(issue.id)}>关闭</Button>}</div>
                        {issue.position && location ? <div className="mt-1 flex flex-wrap items-center gap-2">
                            <Button size="small" type="link" icon={<Clock3 className="size-3.5" />} disabled={"reason" in location || readyRender !== renderKey || query.isError} onClick={() => seekIssue(issue.position!)} aria-label={`定位问题 ${formatReviewTime(issue.position.timeMs)}`}>
                                {formatReviewTime("timeMs" in location ? location.timeMs : issue.position.timeMs)}
                            </Button>
                            <span className="text-foreground/50">{"reason" in location ? location.reason : location.remapped ? `已映射片段位置 · 原 ${formatReviewTime(issue.position.timeMs)}` : "审片时间点"}</span>
                            {sourceShot ? <Link className="font-medium text-[var(--workspace-accent)] hover:underline" to={`/projects/${projectId}/workflow/${unitId}/video`} onClick={() => sessionStorage.setItem(`project-workflow-selected-shot:${projectId}`, sourceShot.id)}>来源镜头：{sourceShot.title}</Link> : null}
                        </div> : null}
                        <small className="mt-1 block text-foreground/40">{issue.severity === "blocker" ? "阻断" : issue.severity === "major" ? "重要" : "一般"} · {new Date(issue.createdAt).toLocaleString("zh-CN")}</small>
                    </div>;
                }) : <p className="mt-3 text-xs leading-5 text-foreground/45">暂无问题记录。没有问题也请播放完整成片后再确认。</p>}</div>
            </div>
        </div>
    </section>;
}

function LinkedStage({ eyebrow, title, description, icon, actionLabel, actionHref, secondaryLabel, secondaryHref }: { eyebrow: string; title: string; description: string; icon: React.ReactNode; actionLabel: string; actionHref: string; secondaryLabel: string; secondaryHref: string }) {
    return <section className="mx-auto max-w-5xl"><StageHeading eyebrow={eyebrow} title={title} description={description} /><div className="mt-6 flex flex-wrap items-center gap-3 border-y border-border/70 py-5"><span className="grid size-10 place-items-center rounded-lg bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent)]">{icon}</span><div className="mr-auto min-w-[220px]"><h3 className="text-sm font-semibold">沿用现有工作台</h3><p className="mt-1 text-xs text-foreground/48">入口已接入，具体产物状态以对应页面为准。</p></div><Link to={actionHref}><Button type="primary">{actionLabel}</Button></Link><Link to={secondaryHref}><Button>{secondaryLabel}</Button></Link></div></section>;
}
