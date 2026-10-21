import { lazy, Suspense, useMemo, useState, type SyntheticEvent } from "react";
import { Button, Input } from "antd";
import { Images, Info, Pause, PencilLine, Play, RefreshCw, ScanSearch } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { ModelPicker } from "@/components/model-picker";
import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { episodeStoryboardPromptPatch, episodeStoryboardTiming, resolveEpisodeShotAssets, storyboardRowIsReady } from "@/lib/canvas/workflow-episode-storyboard";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { CanvasNodeType, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import type { AgentRun } from "@/services/api/agent";
import { CanvasGenerationTaskDetails } from "@/pages/canvas/canvas-generation-task-details";
import { CanvasNodeActionButton } from "./canvas-node-action-bar";
import { CanvasVideoPreviewImage } from "./canvas-video-preview-image";
import { useVideoPlaybackUrl } from "./canvas-node-media-content";
import { CanvasEpisodeShotFrames } from "./canvas-episode-shot-frames";
import { CanvasEpisodeFrameGallery } from "./canvas-episode-frame-gallery";
import { CanvasEpisodeAssetReferences } from "./canvas-episode-asset-references";
import { CanvasImagePreview } from "./canvas-image-preview";
import { failedStoryboardBoundaryImageCount, type StoryboardFrameGenerationOptions } from "@/lib/canvas/episode-storyboard-frames";
import "./canvas-episode-storyboard.css";

const VideoPlayer = lazy(() => import("@/components/video-player").then(module => ({ default: module.VideoPlayer })));
const stop = (event: SyntheticEvent) => event.stopPropagation();

export function CanvasEpisodeStoryboard({ node, nodes, progress, onGenerate, onPause, onRetry, onDetails, onUpdate, onCancel, onModelChange, onGenerateFrames, onExtractKeyframes, onRetryFrame, onFrameModelChange }: {
    node: CanvasNodeData; nodes: CanvasNodeData[];
    progress?: AgentRun["production"];
    onGenerate: (rowIds: string[]) => Promise<void> | void;
    onPause: () => Promise<void> | void;
    onRetry: (node: CanvasNodeData) => void;
    onDetails: () => void;
    onUpdate: (rowId: string, patch: Partial<StoryboardRow>) => void;
    onCancel: (task: GenerationTask) => void;
    onModelChange: (model: string) => void;
    onGenerateFrames: (rowId?: string, kind?: "boundary" | "keyframes", options?: StoryboardFrameGenerationOptions) => Promise<void>;
    onExtractKeyframes: (rowId: string) => Promise<void>;
    onRetryFrame: (node: CanvasNodeData) => void;
    onFrameModelChange: (kind: "text" | "image", model: string) => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const config = useEffectiveConfig();
    const videoConfig = buildGenerationConfig(config, undefined, "video");
    const imageConfig = buildGenerationConfig(config, undefined, "image");
    const [frameRowId, setFrameRowId] = useState<string>();
    const [preparingFrames, setPreparingFrames] = useState<{ rowId?: string; failedOnly: boolean }>();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [playingId, setPlayingId] = useState<string | null>(null);
    const [preview, setPreview] = useState<{ items: CanvasNodeData[]; index: number }>();
    const [submitting, setSubmitting] = useState(false);
    const [pausing, setPausing] = useState(false);
    const rows = node.metadata?.storyboard?.rows || [];
    const detailStates = new Map(progress?.parallelItems?.map(item => [item.key, item]));
    const detailLabel = (row: StoryboardRow) => {
		if (progress?.executionMode === "episode") {
			if (progress.paused) return "本集已暂停";
			return `${progress.phaseLabel || "本集连续补全中"}${progress.currentItem ? ` · ${progress.currentItem}` : ""} · ${({ queued: "等待全局并发名额", running: "正在执行", succeeded: "正在校验保存", failed: "等待重试", cancelled: "已取消", preparing: "准备下一批" } as Record<string, string>)[progress.episodeTaskStatus || "preparing"] || "正在核对状态"}`;
		}
        const work = detailStates.get(row.shotCode || "");
        if (work) return ({ queued: "排队中 · 等待全局 Agent 并发名额", running: "正在生成镜头详情", succeeded: "响应已完成 · 正在校验保存", failed: "模型调用失败 · 等待处理", cancelled: "镜头详情已取消", retrying: "镜头详情等待重试", error: "镜头详情生成失败", unknown: "正在核对镜头任务状态" })[work.status];
        return row.detailStatus === "queued" ? "镜头详情已调度" : row.detailStatus === "retrying" ? "镜头详情重试中" : row.detailStatus === "error" ? "镜头详情生成失败" : "等待生成镜头详情";
    };
    const failedFrameCount = useMemo(() => failedStoryboardBoundaryImageCount(node, nodes), [node, nodes]);
    const timing = episodeStoryboardTiming(node);
    const timingIssues = timing ? rows.filter(row => storyboardRowIsReady(row) && timing.issue(row)) : [];
    const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes]);
    const previewImage = preview?.items[preview.index];
    const previewItems = useMemo(() => preview?.items.map(item => ({ src: item.metadata?.content, storageKey: item.metadata?.storageKey, alt: item.title })), [preview?.items]);
    const onPreviewFrame = (image: CanvasNodeData, group = [image]) => {
        const items = group.filter((item, index) => group.findIndex(other => other.id === item.id) === index);
        setPreview({ items, index: Math.max(0, items.findIndex(item => item.id === image.id)) });
    };
    const items = useMemo(() => rows.map(row => {
        const detailReady = storyboardRowIsReady(row);
        const video = row.videoNodeId ? byId.get(row.videoNodeId) : undefined;
        const batches = (node.metadata?.generationBatches || []).filter(batch => batch.mode === "storyboard_video").flatMap(batch => batch.items.map(item => ({ batch, item })));
        const current = batches.filter(entry => entry.item.rowId === row.id).at(-1);
        const active = isCanvasNodeGenerating(video) || Boolean(current && !current.batch.paused && ["waiting", "submitting", "queued", "running"].includes(current.item.status));
        const ready = Boolean(video?.metadata?.content || video?.metadata?.storageKey);
        const failed = !ready && !active && (video?.metadata?.status === "error" && video.metadata.taskStatus !== "cancelled" || current?.item.status === "failed");
        let assets: ReturnType<typeof resolveEpisodeShotAssets> | undefined;
        let assetError = "";
        if (detailReady) try { assets = resolveEpisodeShotAssets(node, row, nodes); } catch (error) { assetError = error instanceof Error ? error.message : "资产解析失败"; }
        return { row, video, active, failed, ready, detailReady, assets, assetError, paused: current?.batch.paused };
    }), [rows, node, nodes, byId]);
    const selected = items.find(item => item.row.id === selectedId);
    const playing = playingId ? byId.get(playingId) : undefined;
    const { url, loading } = useVideoPlaybackUrl(playing || node, Boolean(playing));
    const generating = node.metadata?.status === "loading";
    const remaining = items.filter(item => item.detailReady && !item.ready && !item.active && !item.failed && !item.assetError);
    const active = items.some(item => item.active) || nodes.some(item => (item.metadata?.storyboardFramePlan?.scriptId === node.id || item.metadata?.storyboardFrame?.scriptId === node.id) && isCanvasNodeGenerating(item)) || (node.metadata?.generationBatches || []).some(batch => !batch.paused && batch.items.some(item => ["waiting", "submitting", "queued", "running"].includes(item.status)));
    const generate = async (ids: string[]) => {
        if (submitting || pausing) return;
        setSubmitting(true);
        try { await onGenerate(ids); } finally { setSubmitting(false); }
    };
    const pause = async () => {
        if (pausing) return;
        setPausing(true);
        try { await onPause(); } finally { setPausing(false); }
    };
    const generateFrames = async (rowId?: string, failedOnly = false) => {
        if (preparingFrames || pausing) return;
        setPreparingFrames({ rowId, failedOnly });
        try { await onGenerateFrames(rowId, "boundary", { failedOnly }); } finally { setPreparingFrames(undefined); }
    };
    return <section className="box-border flex size-full min-h-0 flex-col overflow-hidden px-3 pb-2 pt-10" style={{ color: theme.node.text, background: theme.node.fill }} aria-label="分集视频分镜列表" data-canvas-no-zoom data-canvas-wheel-scroll onPointerDown={stop} onMouseDown={stop} onWheel={stop} onKeyDown={stop} onDoubleClick={stop}>
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b pb-2" style={{ borderColor: theme.node.stroke }}>
            <strong className="mr-auto text-sm">第 {node.metadata?.shortDrama?.episodeNumber || 1} 集 · {rows.length} 个镜头 <span className="text-xs font-normal" style={{ color: theme.node.muted }}>详情 {items.filter(item => item.detailReady).length}/{rows.length} · 视频 {items.filter(item => item.ready).length}/{rows.length}</span></strong>
            <div className="w-48 min-w-0"><ModelPicker fullWidth config={videoConfig} value={videoConfig.model} capability="video" placeholder="选择视频模型" showSelectedPrice={false} onChange={onModelChange} /></div>
            <Button size="small" type="primary" icon={<Play size={14} />} loading={submitting} disabled={pausing || !remaining.length} onClick={() => void generate(remaining.map(item => item.row.id))}>全部生成</Button>
            <Button size="small" icon={<Pause size={14} />} loading={pausing} disabled={!active || submitting} onClick={() => void pause()}>全部暂停</Button>
        </header>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b py-2" style={{ borderColor: theme.node.stroke }}>
            <span className="mr-auto text-xs" style={{ color: theme.node.muted }}>镜头画面{node.metadata?.shortDrama?.parameters?.shotDurationSeconds ? ` · 目标 ${node.metadata.shortDrama.parameters.shotDurationSeconds} 秒 ±${node.metadata.shortDrama.parameters.shotDurationToleranceSeconds || 3} 秒` : ""}</span>
            <div className="w-48 min-w-0"><ModelPicker fullWidth config={imageConfig} value={imageConfig.model} capability="image" placeholder="选择生图模型" showSelectedPrice={false} onChange={model => onFrameModelChange("image", model)} /></div>
            <Button size="small" icon={<Images size={14} />} loading={Boolean(preparingFrames && !preparingFrames.rowId && !preparingFrames.failedOnly)} disabled={!items.some(item => item.detailReady) || pausing || Boolean(preparingFrames)} onClick={() => void generateFrames()}>生成全部首尾帧</Button>
            {failedFrameCount ? <Button size="small" icon={<RefreshCw size={14} />} loading={Boolean(preparingFrames?.failedOnly)} disabled={pausing || Boolean(preparingFrames)} onClick={() => void generateFrames(undefined, true)}>重试失败首尾帧（影响 {failedFrameCount}）</Button> : null}
        </div>
        {generating ? <p role="status" className="shrink-0 py-2 text-xs">{node.metadata?.taskStage || "正在拆解本集镜头"}{progress?.executionMode === "episode" ? ` · ${detailLabel(rows[0])} · 全局 Agent 并发上限 ${progress.concurrencyLimit ?? "--"}` : progress?.parallelItems?.length ? ` · 本集执行 ${progress.parallelItems.filter(item => item.status === "running").length} · 排队 ${progress.parallelItems.filter(item => item.status === "queued").length} · 待保存 ${progress.parallelItems.filter(item => item.status === "succeeded").length} · 全局 Agent 并发上限 ${progress.concurrencyLimit ?? "--"}` : ""}</p> : null}
        {node.metadata?.status === "error" ? <p role="alert" className="shrink-0 py-2 text-xs" style={{ color: theme.accent.danger }}>{node.metadata.errorDetails || "本集拆解中断，可在执行详情继续。已保存镜头仍可生成视频。"}</p> : null}
        {timingIssues.length ? <p role="alert" className="shrink-0 py-2 text-xs" style={{ color: theme.accent.danger }}>{timingIssues.length} 个已保存镜头超出 {timing!.min}–{timing!.max} 秒范围，需重新拆解对应场次；原内容已保留。</p> : null}
        <div className="thin-scrollbar canvas-episode-storyboard-scroll min-h-0 flex-1 overflow-auto" aria-label="分镜内容">
            <div className="canvas-episode-storyboard-rows">
                {items.map(({ row, video, active, failed, ready, detailReady, assets, assetError, paused }) => <article key={row.id} className="canvas-episode-storyboard-card" data-storyboard-row={row.id} data-storyboard-detail-status={row.detailStatus} style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
                    <div className="canvas-episode-storyboard-card-main">
                        <div className="canvas-episode-storyboard-meta">
                            <strong className="break-all">{row.shotCode || row.shotNumber}</strong>
                            <span style={{ color: timing?.issue(row) ? theme.accent.danger : theme.node.muted }}>{row.durationSeconds} 秒</span>
                            {timing?.issue(row) ? <span className="line-clamp-2" style={{ color: theme.accent.danger }}>{timing.issue(row)}</span> : row.timingException === "scene_tail" ? <span style={{ color: theme.node.muted }}>场尾余量</span> : null}
                        </div>
                        <div className="canvas-episode-storyboard-prompt">
                            <span className="canvas-episode-storyboard-section-label">分镜提示词</span>
                            <p className={detailReady ? "line-clamp-5 whitespace-pre-wrap break-words leading-5" : "line-clamp-4 whitespace-pre-wrap break-words leading-5"} title={detailReady ? row.videoMotionPrompt : row.plannedGoal}>{detailReady ? row.videoMotionPrompt || row.plotDescription : row.plannedGoal || "已规划镜头"}</p>
                            <p role="status" className="canvas-episode-storyboard-status line-clamp-2" style={{ color: row.detailStatus === "error" ? theme.accent.danger : theme.node.muted }}>{detailReady ? (active ? video?.metadata?.taskStage || "排队中" : failed ? "生成失败" : paused || video?.metadata?.taskStatus === "cancelled" ? "已暂停" : "待生成") : detailLabel(row)}</p>
                            {row.detailError ? <p role="alert" className="line-clamp-2 break-words" style={{ color: theme.accent.danger }}>{row.detailError}</p> : null}
                        </div>
                    </div>
                    <div className="canvas-episode-storyboard-media">
                        <span className="canvas-episode-storyboard-section-label">画面素材</span>
                        {detailReady ? <CanvasEpisodeFrameGallery row={row} nodes={nodes} onPreview={onPreviewFrame} onManage={() => setFrameRowId(row.id)} /> : <div className="canvas-episode-storyboard-placeholder" style={{ color: theme.node.muted }}>详情完成后关联首尾帧与素材</div>}
                        <div className="canvas-episode-storyboard-reference-block">
                            {detailReady ? <CanvasEpisodeAssetReferences assets={assets} onPreview={onPreviewFrame} /> : null}
                            {!detailReady ? <span style={{ color: theme.node.muted }}>{row.detailDependencies?.length ? `前置镜头：${row.detailDependencies.join("、")}` : "等待分镜详情"}</span> : null}
                            {detailReady && !assets?.media.some(image => image.type === CanvasNodeType.Image) ? <span className="canvas-episode-storyboard-empty-reference" style={{ color: theme.node.muted }} title={assets?.codes.join("、") || row.assetKeys?.join("、")}>{assets?.codes.length ? `${assets.codes.length} 项资产，无图片` : "无图片引用"}</span> : null}
                            {assetError ? <button type="button" role="alert" className="canvas-episode-storyboard-asset-error" style={{ color: theme.accent.danger }} onClick={() => setSelectedId(row.id)} title={assetError}>素材引用异常 · 查看详情</button> : null}
                        </div>
                    </div>
                    <div className="canvas-episode-storyboard-video">
                        <span className="canvas-episode-storyboard-section-label">生成视频</span>
                        {detailReady && ready && video ? <button type="button" className="relative block aspect-video w-full overflow-hidden rounded" aria-label={`播放镜头 ${row.shotCode || row.shotNumber}`} onClick={() => setPlayingId(video.id)}><CanvasVideoPreviewImage node={video} className="size-full object-cover" fallback={<span className="block size-full" style={{ background: theme.node.panel }} />} /><Play className="absolute left-1/2 top-1/2 size-6 -translate-x-1/2 -translate-y-1/2" /></button> : <div className="canvas-episode-storyboard-video-status" role="status" style={{ color: failed ? theme.accent.danger : theme.node.muted }}>{detailReady ? (active ? video?.metadata?.taskStage || "排队中" : failed ? "生成失败" : paused || video?.metadata?.taskStatus === "cancelled" ? "已暂停" : "待生成") : "等待分镜详情"}</div>}
                    </div>
                    <div className="canvas-episode-storyboard-actions">
                        {!detailReady ? <CanvasNodeActionButton theme={theme} label="执行详情" icon={<Info size={14} />} onClick={onDetails} /> : <>{!ready && !failed ? <CanvasNodeActionButton theme={theme} label="生成" icon={<Play size={14} />} disabled={active || submitting || pausing || Boolean(assetError)} onClick={() => void generate([row.id])} primary /> : null}<CanvasNodeActionButton theme={theme} label="详情" icon={<Info size={14} />} onClick={() => setSelectedId(row.id)} /><CanvasNodeActionButton theme={theme} label="首尾帧" icon={<Images size={14} />} disabled={Boolean(preparingFrames) || pausing} onClick={() => void generateFrames(row.id)} /><CanvasNodeActionButton theme={theme} label="关键帧" icon={<ScanSearch size={14} />} onClick={() => setFrameRowId(row.id)} />{failed ? <CanvasNodeActionButton theme={theme} label="重试" icon={<RefreshCw size={14} />} disabled={active || Boolean(assetError)} onClick={() => video ? onRetry(video) : void generate([row.id])} /> : null}</>}
                    </div>
                </article>)}
            </div>
            {!rows.length ? <p className="p-5 text-center" style={{ color: theme.node.muted }}>正在规划本集镜头清单</p> : null}
        </div>
        <footer className="flex shrink-0 border-t pt-1" style={{ borderColor: theme.node.stroke }}><CanvasNodeActionButton theme={theme} label="执行详情" icon={<Info size={14} />} onClick={onDetails} /></footer>
        {selected ? <AppModal open focusable={{ trap: !previewImage }} title={`镜头 ${selected.row.shotCode || selected.row.shotNumber}`} footer={null} width="min(900px, calc(100vw - 24px))" onCancel={() => setSelectedId(null)}>
            <div className="thin-scrollbar max-h-[75dvh] overflow-y-auto" data-canvas-no-zoom onPointerDown={stop} onWheel={stop} onKeyDown={stop}>
                <label className="mb-2 flex items-center gap-1 text-sm"><PencilLine size={14} />分镜提示词</label>
                <Input.TextArea aria-label="分镜提示词" autoSize={{ minRows: 5 }} value={selected.row.videoMotionPrompt} disabled={selected.active || generating} onChange={event => onUpdate(selected.row.id, episodeStoryboardPromptPatch(selected.row, event.target.value))} />
                <p className="my-3 text-xs">引用素材：{selected.assets?.nodes.map(item => `${item.metadata?.shortDrama?.assetIdentity?.code} ${item.title}`).join("、") || selected.assetError || "无固定资产引用"}</p>
                <CanvasEpisodeAssetReferences assets={selected.assets} onPreview={onPreviewFrame} large />
                <CanvasEpisodeFrameGallery row={selected.row} nodes={nodes} onPreview={onPreviewFrame} onManage={() => { setSelectedId(null); setFrameRowId(selected.row.id); }} />
                {selected.video?.metadata?.taskId ? <CanvasGenerationTaskDetails key={selected.video.id} node={selected.video} onRetry={onRetry} onCancel={onCancel} /> : <p className="py-3 text-sm">尚未提交视频任务</p>}
            </div>
        </AppModal> : null}
        {rows.find(row => row.id === frameRowId) ? <CanvasEpisodeShotFrames key={frameRowId} row={rows.find(row => row.id === frameRowId)!} rows={rows} nodes={nodes} previewOpen={Boolean(previewImage)} onUpdate={patch => onUpdate(frameRowId!, patch)} onClose={() => setFrameRowId(undefined)} onExtract={() => onExtractKeyframes(frameRowId!)} onGenerate={() => onGenerateFrames(frameRowId, "keyframes")} onRetry={onRetryFrame} onCancel={onCancel} onPreview={onPreviewFrame} onModelChange={onFrameModelChange} /> : null}
        {previewImage ? <CanvasImagePreview items={previewItems} index={preview!.index} onNavigate={index => setPreview(current => current && { ...current, index })} onClose={() => setPreview(undefined)} /> : null}
        {playing ? <AppModal open title={playing.title} footer={null} width="min(1000px, calc(100vw - 24px))" onCancel={() => setPlayingId(null)} destroyOnHidden><div className="aspect-video" data-canvas-no-zoom onPointerDown={stop} onWheel={stop}>{url ? <Suspense fallback={<span>加载播放器</span>}><VideoPlayer src={url} title={playing.title} autoPlay preload="metadata" className="size-full" /></Suspense> : <span>{loading ? "加载视频中" : "视频暂不可用"}</span>}</div></AppModal> : null}
    </section>;
}
