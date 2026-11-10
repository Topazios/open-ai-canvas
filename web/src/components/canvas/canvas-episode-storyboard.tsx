import { lazy, Suspense, useCallback, useMemo, useState, type CSSProperties, type SyntheticEvent } from "react";
import { App, Button, Checkbox, Input, Tooltip } from "antd";
import { Image as ImageIcon, Info, Link2, ListChecks, Pause, PencilLine, Play, Sparkles } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { ModelPicker } from "@/components/model-picker";
import { CanvasVideoSettingsPopover } from "@/components/canvas/canvas-video-settings-popover";
import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { storyboardFrameGenerationConfig } from "@/lib/canvas/storyboard-frame-model";
import { episodeStoryboardPromptPatch, episodeStoryboardTiming, resolveEpisodeShotAssets, storyboardRowIsReady, storyboardSceneId } from "@/lib/canvas/workflow-episode-storyboard";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { bindingForConnectedNode } from "@/lib/canvas/canvas-storyboard-materializer";
import { CanvasNodeType, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import type { AgentRun } from "@/services/api/agent";
import { CanvasGenerationTaskDetails } from "@/pages/canvas/canvas-generation-task-details";
import { CanvasVideoPreviewImage } from "./canvas-video-preview-image";
import { useVideoPlaybackUrl } from "./canvas-node-media-content";
import { CanvasEpisodeShotFrames } from "./canvas-episode-shot-frames";
import { CanvasEpisodeFrameGallery } from "./canvas-episode-frame-gallery";
import { CanvasEpisodeAssetReferences } from "./canvas-episode-asset-references";
import { CanvasImagePreview } from "./canvas-image-preview";
import { storyboardFrameLabels, type StoryboardFrameGenerationOptions } from "@/lib/canvas/episode-storyboard-frames";
import { storyboardFrameTrack, storyboardFrameTrackSelection, storyboardFrameTrackSlotCount, storyboardFrameTrackTargets, type StoryboardFrameTrackItem } from "@/lib/canvas/storyboard-frame-track";
import "./canvas-episode-storyboard.css";

const VideoPlayer = lazy(() => import("@/components/video-player").then((module) => ({ default: module.VideoPlayer })));
const stop = (event: SyntheticEvent) => event.stopPropagation();
const FOCUSABLE_TARGET = "input, textarea, select, button, a[href], label, [tabindex], [contenteditable='true']";
// 点击时间线非交互区域时主动失焦，避免复选框一直保留焦点样式。
const blurOnBlankPointer = (event: React.PointerEvent<HTMLElement>) => {
    stop(event);
    const target = event.target instanceof Element ? event.target : null;
    const active = document.activeElement;
    if (!target?.closest(FOCUSABLE_TARGET) && active instanceof HTMLElement && event.currentTarget.contains(active)) active.blur();
};
const handleWheel = (event: React.WheelEvent) => {
    // 按住 Ctrl/Meta 时,允许事件传播以支持画布缩放
    // 其他情况也不阻止传播,让浏览器处理容器内的正常滚动
};

export function CanvasEpisodeStoryboard({
    node,
    nodes,
    progress,
    onGenerate,
    onPause,
    onRetry,
    onDetails,
    onUpdate,
    onCancel,
    onModelChange,
    onGenerateFrames,
    onExtractKeyframes,
    onRetryFrame,
    onFrameModelChange,
}: {
    node: CanvasNodeData;
    nodes: CanvasNodeData[];
    progress?: AgentRun["production"];
    onGenerate: (rowIds: string[], regenerate?: boolean) => Promise<void> | void;
    onPause: () => Promise<void> | void;
    onRetry: (node: CanvasNodeData) => void;
    onDetails: () => void;
    onUpdate: (rowId: string, patch: Partial<StoryboardRow>) => void;
    onCancel: (task: GenerationTask) => void;
    onModelChange: (model: string) => void;
    onGenerateFrames: (rowId?: string, kind?: "all" | "boundary" | "keyframes", options?: StoryboardFrameGenerationOptions) => Promise<void>;
    onExtractKeyframes: (rowId: string) => Promise<void>;
    onRetryFrame: (node: CanvasNodeData) => void;
    onFrameModelChange: (kind: "text" | "image", model: string) => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const { modal } = App.useApp();
    const config = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const videoConfig = buildGenerationConfig(config, undefined, "video");
    const imageConfig = storyboardFrameGenerationConfig(config, node, "image");
    const [frameRowId, setFrameRowId] = useState<string>();
    const [preparingFrames, setPreparingFrames] = useState<{ rowId?: string; failedOnly: boolean }>();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedRows, setSelectedRows] = useState<string[]>([]);
    const [selectedFrames, setSelectedFrames] = useState<string[]>([]);
    const [density, setDensity] = useState<"normal" | "compact">("normal");
    const [playingId, setPlayingId] = useState<string | null>(null);
    const [preview, setPreview] = useState<{ items: CanvasNodeData[]; index: number }>();
    const [submitting, setSubmitting] = useState(false);
    const [pausing, setPausing] = useState(false);
    const confirmRegeneration = useCallback(
        (label: string) =>
            new Promise<boolean>((resolve) => {
                modal.confirm({
                    title: `确认重新生成${label}`,
                    content: `将重新提交${label}任务，可能再次产生费用。已生成的结果会保留，确认后才开始新的生成。`,
                    okText: "确认重新生成",
                    cancelText: "取消",
                    onOk: () => resolve(true),
                    onCancel: () => resolve(false),
                });
            }),
        [modal],
    );
    const retryVideo = useCallback(
        async (video: CanvasNodeData) => {
            if (await confirmRegeneration("视频")) onRetry(video);
        },
        [confirmRegeneration, onRetry],
    );
    const rows = node.metadata?.storyboard?.rows || [];
    const frameTrack = useMemo(() => storyboardFrameTrack(rows, nodes), [rows, nodes]);
    const selectedFrameIds = storyboardFrameTrackSelection(frameTrack, selectedFrames);
    const selectableFrames = frameTrack;
    const frameTargets = storyboardFrameTrackTargets(frameTrack, selectedFrameIds);
    const framePreviewGroup = frameTrack.flatMap(item => {
        const image = nodes.find(node => node.id === item.frame.imageNodeId);
        return image && (image.metadata?.content || image.metadata?.storageKey) ? [{ ...image, title: item.usages.map(usage => `${usage.shot} ${storyboardFrameLabels[usage.kind]}`).join(" · ") }] : [];
    });
    const detailStates = new Map(progress?.parallelItems?.map((item) => [item.key, item]));
    const detailLabel = (row: StoryboardRow) => {
        if (progress?.executionMode === "episode") {
            if (progress.paused) return "本集已暂停";
            return `${progress.phaseLabel || "本集连续补全中"}${progress.currentItem ? ` · ${progress.currentItem}` : ""} · ${({ queued: "等待全局并发名额", running: "正在执行", succeeded: "正在校验保存", failed: "等待重试", cancelled: "已取消", preparing: "准备下一批" } as Record<string, string>)[progress.episodeTaskStatus || "preparing"] || "正在核对状态"}`;
        }
        const work = detailStates.get(progress?.executionMode === "scene" ? row.sceneId || "" : row.shotCode || "");
        if (work)
            return {
                queued: "排队中 · 等待全局 Agent 并发名额",
                running: "正在生成镜头详情",
                succeeded: "响应已完成 · 正在校验保存",
                failed: "模型调用失败 · 等待处理",
                cancelled: "镜头详情已取消",
                retrying: "镜头详情等待重试",
                error: "镜头详情生成失败",
                warning: "待检查",
                unknown: "正在核对镜头任务状态",
                blocked: "等待前置场次镜头完成",
            }[work.status];
        return row.detailStatus === "queued" ? "镜头详情已调度" : row.detailStatus === "retrying" ? "镜头详情重试中" : row.detailStatus === "error" ? "镜头详情生成失败" : "等待生成镜头详情";
    };
    const timing = episodeStoryboardTiming(node);
    const timingIssues = timing ? rows.filter((row) => storyboardRowIsReady(row) && timing.issue(row)) : [];
    const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const previewImage = preview?.items[preview.index];
    const previewItems = useMemo(() => preview?.items.map((item) => ({ src: item.metadata?.content, storageKey: item.metadata?.storageKey, alt: item.title })), [preview?.items]);
    const onPreviewFrame = (image: CanvasNodeData, group = [image]) => {
        const items = group.filter((item, index) => group.findIndex((other) => other.id === item.id) === index);
        setPreview({
            items,
            index: Math.max(
                0,
                items.findIndex((item) => item.id === image.id),
            ),
        });
    };
    const items = useMemo(
        () =>
            rows.map((row) => {
                const detailReady = storyboardRowIsReady(row);
                const legacyVideo = row.videoNodeId ? byId.get(row.videoNodeId) : undefined;
                const inline = row.videoGeneration;
                const video =
                    legacyVideo ||
                    (inline
                        ? ({
                              id: `storyboard-video:${node.id}:${row.id}`,
                              type: CanvasNodeType.Video,
                              title: `镜头 ${row.shotNumber} · 视频`,
                              position: node.position,
                              width: 640,
                              height: 360,
                              metadata: {
                                  ...node.metadata,
                                  content: inline.content,
                                  storageKey: inline.storageKey,
                                  mimeType: inline.mimeType,
                                  bytes: inline.bytes,
                                  naturalWidth: inline.width,
                                  naturalHeight: inline.height,
                                  durationMs: inline.durationMs,
                                  taskId: inline.taskId,
                                  taskStatus: inline.taskStatus,
                                  taskProgress: inline.taskProgress,
                                  taskStage: inline.taskStage,
                                  taskProvider: inline.taskProvider,
                                  taskErrorCode: inline.taskErrorCode,
                                  taskCreatedAt: inline.taskCreatedAt,
                                  taskStartedAt: inline.taskStartedAt,
                                  taskCompletedAt: inline.taskCompletedAt,
                                  taskDurationMs: inline.taskDurationMs,
                                  errorDetails: inline.errorDetails,
                                  prompt: inline.prompt,
                                  model: inline.model,
                                  status: inline.taskStatus === "succeeded" ? "success" : inline.taskStatus === "failed" ? "error" : inline.taskStatus === "cancelled" ? "idle" : inline.taskStatus ? "loading" : "idle",
                              },
                          } as CanvasNodeData)
                        : undefined);
                const batches = (node.metadata?.generationBatches || []).filter((batch) => batch.mode === "storyboard_video").flatMap((batch) => batch.items.map((item) => ({ batch, item })));
                const current = batches.filter((entry) => entry.item.rowId === row.id).at(-1);
                const ready = Boolean(inline?.content || inline?.storageKey || legacyVideo?.metadata?.content || legacyVideo?.metadata?.storageKey);
                const active = Boolean(inline && ["queued", "running"].includes(inline.taskStatus || "")) || !ready && (
                    isCanvasNodeGenerating(legacyVideo) ||
                    Boolean(current && !current.batch.paused && ["waiting", "submitting", "queued", "running"].includes(current.item.status))
                );
                const failed = !active && (inline?.taskStatus === "failed" || (legacyVideo?.metadata?.status === "error" && legacyVideo.metadata.taskStatus !== "cancelled") || current?.item.status === "failed") && (!ready || Boolean(inline?.errorDetails));
                let assets: ReturnType<typeof resolveEpisodeShotAssets> | undefined;
                let assetError = "";
                if (detailReady)
                    try {
                        assets = resolveEpisodeShotAssets(node, row, nodes);
                    } catch (error) {
                        assetError = error instanceof Error ? error.message : "资产解析失败";
                    }
                return { row, video, active, failed, ready, detailReady, assets, assetError, paused: current?.batch.paused };
            }),
        [rows, node, nodes, byId],
    );
    // Assets resolved by code but not yet written into the row bindings (e.g. generated after the storyboard was split).
    const pendingBindings = (row: StoryboardRow, assets?: ReturnType<typeof resolveEpisodeShotAssets>) => {
        if (!assets) return [];
        const bound = new Set((row.assetBindings || []).map((binding) => binding.nodeId));
        return [...new Set(assets.referenceNodeIds)].flatMap((id) => {
            const binding = bound.has(id) ? null : bindingForConnectedNode(byId.get(id) as CanvasNodeData);
            return binding ? [binding] : [];
        });
    };
    const bindAssets = (row: StoryboardRow, assets?: ReturnType<typeof resolveEpisodeShotAssets>) => {
        const next = pendingBindings(row, assets);
        if (next.length) onUpdate(row.id, { assetBindings: [...(row.assetBindings || []), ...next] });
    };
    const selected = items.find((item) => item.row.id === selectedId);
    const playing = playingId ? byId.get(playingId) || items.find((item) => item.video?.id === playingId)?.video : undefined;
    const { url, loading } = useVideoPlaybackUrl(playing || node, Boolean(playing));
    const generating = node.metadata?.status === "loading";
    const active =
        items.some((item) => item.active) ||
        nodes.some((item) => (item.metadata?.storyboardFramePlan?.scriptId === node.id || item.metadata?.storyboardFrame?.scriptId === node.id) && isCanvasNodeGenerating(item)) ||
        (node.metadata?.generationBatches || []).some((batch) => !batch.paused && batch.items.some((item) => ["waiting", "submitting", "queued", "running"].includes(item.status)));
    const sceneGroups = useMemo(() => {
        const groups: { key: string; label: string; count: number }[] = [];
        for (const item of items) {
            const code = storyboardSceneId(item.row) || "scene-1";
            const existing = groups[groups.length - 1];
            if (existing?.key === code) existing.count += 1;
            else {
                const match = code.match(/S?(\d+)/i);
                groups.push({ key: code, label: `场次 ${String(Number(match?.[1] || groups.length + 1)).padStart(2, "0")}`, count: 1 });
            }
        }
        return groups;
    }, [items]);
    const targetItems = selectedRows.length ? items.filter((item) => selectedRows.includes(item.row.id) && item.detailReady) : items.filter((item) => item.detailReady);
    const generate = async (ids: string[], regenerate = false) => {
        if (submitting || pausing) return;
        setSubmitting(true);
        try {
            await onGenerate(ids, regenerate);
        } finally {
            setSubmitting(false);
        }
    };
    const pause = async () => {
        if (pausing) return;
        setPausing(true);
        try {
            await onPause();
        } finally {
            setPausing(false);
        }
    };
    const generateFrames = async (options: StoryboardFrameGenerationOptions = {}) => {
        if (preparingFrames || pausing) return;
        const frameTargets = options.frameTargets || storyboardFrameTrackTargets(frameTrack, selectedFrameIds);
        if (!frameTargets.length) return;
        setPreparingFrames({ failedOnly: Boolean(options.failedOnly) });
        try {
            await onGenerateFrames(undefined, "all", { ...options, frameTargets });
        } finally {
            setPreparingFrames(undefined);
        }
    };
    const generateFrame = (item: StoryboardFrameTrackItem) => void generateFrames({ regenerate: true, frameTargets: storyboardFrameTrackTargets([item], [item.id]) });
    // One action for the current selection: checked shots generate videos, checked frames generate images.
    const selectedVideoIds = selectedRows.length ? targetItems.filter((item) => !item.active && !item.assetError).map((item) => item.row.id) : [];
    const selectedFrameTargets = selectedFrameIds.length ? frameTargets : [];
    const canGenerateVideos = selectedVideoIds.length > 0 && !submitting;
    const canGenerateFrames = selectedFrameTargets.length > 0 && !preparingFrames;
    const generateSelectionTip = !selectedRows.length && !selectedFrameIds.length
        ? "勾选镜头生成视频，勾选画面生成画面"
        : [selectedRows.length ? `视频 ${selectedVideoIds.length} 个` : "", selectedFrameIds.length ? `画面 ${selectedFrameTargets.length} 张` : ""].filter(Boolean).join(" · ");
    const generateSelected = () => {
        if (pausing) return;
        void Promise.all([
            canGenerateVideos ? generate(selectedVideoIds, true) : undefined,
            canGenerateFrames ? generateFrames({ regenerate: true, frameTargets: selectedFrameTargets }) : undefined,
        ]);
    };
    const toggleFrame = (id: string, checked: boolean) => setSelectedFrames(current => {
        const selected = storyboardFrameTrackSelection(frameTrack, current);
        return checked ? [...new Set([...selected, id])] : selected.filter(value => value !== id);
    });
    const toggleRow = (rowId: string, checked: boolean) => setSelectedRows((current) => checked ? [...new Set([...current, rowId])] : current.filter((id) => id !== rowId));
    const toggleAllRows = (checked: boolean) => setSelectedRows(checked ? items.map((item) => item.row.id) : []);
    const compact = density === "compact";
    const shotState = ({ row, video, active, failed, ready, detailReady }: Pick<(typeof items)[number], "row" | "video" | "active" | "failed" | "ready" | "detailReady">) =>
        detailReady ? active ? video?.metadata?.taskStage || "生成中" : failed ? "生成失败" : ready ? "已完成" : "待生成" : detailLabel(row);
    const frameWidth = compact ? 88 : 112;
    const frameGap = compact ? 6 : 8;
    const gridColumns = `${compact ? 88 : 112}px ${items.map(item => `${Math.max(compact ? 112 : 192, storyboardFrameTrackSlotCount(frameTrack.filter(frame => frame.rowId === item.row.id)) * (frameWidth + frameGap) + frameGap)}px`).join(" ")}`;
    return (
        <section className="canvas-episode-timeline box-border flex size-full min-h-0 flex-col overflow-hidden px-3 pb-2 pt-8" style={{ color: theme.node.text, background: theme.node.fill, "--timeline-surface": theme.node.fill, "--timeline-selected": theme.node.activeStroke } as CSSProperties} aria-label="分集视频分镜时间线" data-canvas-no-zoom data-canvas-wheel-scroll onPointerDown={blurOnBlankPointer} onMouseDown={stop} onWheel={handleWheel} onKeyDown={stop} onDoubleClick={stop}>
            <header className="canvas-episode-toolbar flex shrink-0 flex-wrap items-center gap-2 border-b pb-2" style={{ borderColor: theme.node.stroke }}>
                <strong className="mr-auto text-sm">第 {node.metadata?.shortDrama?.episodeNumber || 1} 集 · {rows.length} 个镜头 <span className="text-xs font-normal" style={{ color: theme.node.muted }}>完成 {items.filter((item) => item.detailReady).length}/{rows.length} · 视频 {items.filter((item) => item.ready).length}/{rows.length}</span></strong>
                <div className="w-40 min-w-0"><ModelPicker fullWidth config={videoConfig} value={videoConfig.model} capability="video" placeholder="视频模型" showSelectedPrice={false} onChange={onModelChange} /></div>
                <CanvasVideoSettingsPopover config={videoConfig} placement="bottomRight" resolutionOnly onConfigChange={(key, value) => updateConfig(key, value)} />
                <div className="w-40 min-w-0"><ModelPicker fullWidth config={imageConfig} value={imageConfig.model} capability="image" placeholder="生图模型" showSelectedPrice={false} onChange={(model) => onFrameModelChange("image", model)} /></div>
                <Button.Group size="small"><Button aria-pressed={density === "normal"} onClick={() => setDensity("normal")}>正常</Button><Button aria-pressed={density === "compact"} onClick={() => setDensity("compact")}>缩略</Button></Button.Group>
                <div className="canvas-episode-toolbar-actions flex items-center gap-1">
                    <Tooltip title={generateSelectionTip}>
                        <Button size="small" type="primary" icon={<Sparkles size={14} />} loading={submitting || Boolean(preparingFrames && !preparingFrames.failedOnly)} disabled={pausing || (!canGenerateVideos && !canGenerateFrames)} onClick={generateSelected}>生成选中</Button>
                    </Tooltip>
                    <Tooltip title="暂停"><Button size="small" icon={<Pause size={14} />} aria-label="暂停" loading={pausing} disabled={!active || submitting} onClick={() => void pause()} /></Tooltip>
                    <Tooltip title="执行详情"><Button size="small" type="text" icon={<ListChecks size={14} />} aria-label="执行详情" onClick={onDetails} /></Tooltip>
                </div>
            </header>
            {generating ? <p role="status" className="shrink-0 py-2 text-xs">{node.metadata?.taskStage || "正在拆解本集镜头"}{progress?.executionMode === "episode" ? ` · ${detailLabel(rows[0])} · 全局 Agent 并发上限 ${progress.concurrencyLimit ?? "--"}` : progress?.parallelItems?.length ? ` · 执行 ${progress.parallelItems.filter((item) => item.status === "running").length} · 排队 ${progress.parallelItems.filter((item) => item.status === "queued").length} · 全局并发上限 ${progress.concurrencyLimit ?? "--"}` : ""}</p> : null}
            {node.metadata?.status === "error" ? <p role="alert" className="shrink-0 py-2 text-xs" style={{ color: theme.accent.danger }}>{node.metadata.errorDetails || "本集拆解中断，可在执行详情继续。已保存镜头仍可生成视频。"}</p> : null}
            {timingIssues.length ? <p role="alert" className="shrink-0 py-2 text-xs" style={{ color: theme.accent.danger }}>{timingIssues.length} 个镜头超出 {timing!.min}–{timing!.max} 秒范围。</p> : null}
            <div className="thin-scrollbar canvas-episode-storyboard-scroll min-h-0 flex-1 overflow-auto" aria-label="分镜时间线">
                {rows.length ? <div className={`canvas-episode-timeline-grid ${density === "compact" ? "is-compact" : ""}`} style={{ "--shot-columns": Math.max(items.length, 1), "--timeline-columns": gridColumns } as CSSProperties}>
                    <div className="timeline-spacer" />
                    {sceneGroups.map((scene, index) => <div key={`${scene.key}-${index}`} className="scene-group-label" style={{ gridColumn: `span ${scene.count}` }}>{scene.label}<span>{scene.count} 镜</span></div>)}
                    <div className="track-label"><strong>镜头主轨</strong><Checkbox checked={items.length > 0 && selectedRows.length === items.length} indeterminate={selectedRows.length > 0 && selectedRows.length < items.length} onChange={event => toggleAllRows(event.target.checked)}>全选视频</Checkbox></div>
                    {items.map(({ row, video, active: rowActive, failed, ready, detailReady }) => <div key={`shot-${row.id}`} className={`timeline-shot ${selectedRows.includes(row.id) ? "is-selected" : ""}`} data-state={rowActive ? "running" : failed ? "failed" : ready ? "ready" : "waiting"}>
                        <div className="timeline-shot-header"><Checkbox checked={selectedRows.includes(row.id)} onChange={event => toggleRow(row.id, event.target.checked)} aria-label={`选择镜头 ${row.shotCode || row.shotNumber}`} /><strong title={row.shotCode}>镜头 {String(row.shotNumber).padStart(2, "0")}</strong><span>{row.durationSeconds.toFixed(1)} 秒</span><Button size="small" type="text" icon={<Info size={13} />} aria-label={`镜头 ${row.shotCode || row.shotNumber} 详情`} onClick={() => setSelectedId(row.id)} /></div>
                        <button type="button" className="timeline-shot-preview" aria-label={`${ready ? "播放" : "查看"}镜头 ${row.shotCode || row.shotNumber}`} onClick={() => ready && video ? setPlayingId(video.id) : setSelectedId(row.id)}>
                            {ready && video ? <span className="timeline-shot-image"><CanvasVideoPreviewImage node={video} className="size-full object-cover" fallback={<ImageIcon size={20} />}/><Play size={18} className="timeline-shot-play" /></span> : <span className="timeline-shot-image timeline-placeholder"><ImageIcon size={18}/></span>}
                            <span className="timeline-state" title={shotState({ row, video, active: rowActive, failed, ready, detailReady })}>{shotState({ row, video, active: rowActive, failed, ready, detailReady })}</span>
                        </button>
                    </div>)}
                    <div className="track-label"><strong>画面帧</strong><Checkbox checked={selectedFrameIds.length > 0 && selectedFrameIds.length === selectableFrames.length} indeterminate={selectedFrameIds.length > 0 && selectedFrameIds.length < selectableFrames.length} onChange={event => setSelectedFrames(event.target.checked ? selectableFrames.map(item => item.id) : [])}>全选画面</Checkbox></div>
                    {items.map(({ row }) => <div key={`frames-${row.id}`} className="timeline-frame-cell"><CanvasEpisodeFrameGallery row={row} nodes={nodes} trackItems={frameTrack.filter(item => item.rowId === row.id)} selectedIds={selectedFrameIds} onToggle={toggleFrame} onGenerate={generateFrame} preparing={Boolean(preparingFrames) || pausing} previewGroup={framePreviewGroup} onPreview={onPreviewFrame} onManage={setFrameRowId} /></div>)}
                    <div className="track-label">引用资产</div>
                    {items.map(({ row, assets, assetError, detailReady }) => <div key={`assets-${row.id}`} className="timeline-assets-cell">{detailReady ? <CanvasEpisodeAssetReferences assets={assets} onPreview={onPreviewFrame} /> : <span>{assetError || "待引用"}</span>}{detailReady && assets?.missingCodes.length ? <span title={assets.missingCodes.join("、")}>待引用 {assets.missingCodes.length}</span> : null}</div>)}
                </div> : <p className="p-5 text-center" style={{ color: theme.node.muted }}>{node.metadata?.status === "error" ? node.metadata.errorDetails || "分镜任务失败，请在执行详情中重试" : node.metadata?.shortDrama?.submission === "planned" ? "本集尚未提交，请在分组详情中继续提交" : generating ? "正在规划本集镜头清单" : "本集尚未生成分镜"}</p>}
            </div>
            {selected ? (
                <AppModal open focusable={{ trap: !previewImage }} title={`镜头 ${selected.row.shotCode || selected.row.shotNumber}`} footer={null} width="min(900px, calc(100vw - 24px))" onCancel={() => setSelectedId(null)}>
                    <div className="thin-scrollbar max-h-[75dvh] overflow-y-auto" data-canvas-no-zoom onPointerDown={stop} onWheel={handleWheel} onKeyDown={stop}>
                        <label className="mb-2 flex items-center gap-1 text-sm">
                            <PencilLine size={14} />
                            分镜提示词
                        </label>
                        <Input.TextArea
                            aria-label="分镜提示词"
                            autoSize={{ minRows: 5 }}
                            value={selected.row.videoMotionPrompt}
                            disabled={selected.active || generating}
                            onChange={(event) => onUpdate(selected.row.id, episodeStoryboardPromptPatch(selected.row, event.target.value))}
                        />
                        <p className="my-3 text-xs">引用素材：{selected.assets?.nodes.map((item) => `${item.metadata?.shortDrama?.assetIdentity?.code} ${item.title}`).join("、") || selected.assetError || "无固定资产引用"}</p>
                        <CanvasEpisodeAssetReferences assets={selected.assets} onPreview={onPreviewFrame} large />
                        {pendingBindings(selected.row, selected.assets).length ? <Button size="small" icon={<Link2 size={13} />} onClick={() => bindAssets(selected.row, selected.assets)}>引用已匹配资产</Button> : null}
                        <CanvasEpisodeFrameGallery
                            row={selected.row}
                            nodes={nodes}
                            trackItems={frameTrack.filter(item => item.usages.some(usage => usage.rowId === selected.row.id))}
                            previewGroup={framePreviewGroup}
                            onPreview={onPreviewFrame}
                            onManage={() => {
                                setSelectedId(null);
                                setFrameRowId(selected.row.id);
                            }}
                        />
                        {selected.video?.metadata?.taskId ? (
                            <CanvasGenerationTaskDetails key={selected.video.id} node={selected.video} onRetry={(node) => (selected.row.videoGeneration ? void generate([selected.row.id]) : void retryVideo(node))} onCancel={onCancel} />
                        ) : selected.active ? (
                            <p role="status" className="py-3 text-sm">
                                已加入视频生成队列，正在等待调度；任务提交后这里会显示模型、阶段和实时进度。
                            </p>
                        ) : (
                            <p className="py-3 text-sm">尚未提交视频任务</p>
                        )}
                    </div>
                </AppModal>
            ) : null}
            {rows.find((row) => row.id === frameRowId) ? (
                <CanvasEpisodeShotFrames
                    key={frameRowId}
                    script={node}
                    row={rows.find((row) => row.id === frameRowId)!}
                    rows={rows}
                    nodes={nodes}
                    previewOpen={Boolean(previewImage)}
                    onUpdate={(patch) => onUpdate(frameRowId!, patch)}
                    onClose={() => setFrameRowId(undefined)}
                    onExtract={() => onExtractKeyframes(frameRowId!)}
                    onGenerate={() => onGenerateFrames(frameRowId, "keyframes")}
                    onRetry={onRetryFrame}
                    onCancel={onCancel}
                    onPreview={onPreviewFrame}
                    onModelChange={onFrameModelChange}
                />
            ) : null}
            {previewImage ? <CanvasImagePreview items={previewItems} index={preview!.index} onNavigate={(index) => setPreview((current) => current && { ...current, index })} onClose={() => setPreview(undefined)} /> : null}
            {playing ? (
                <AppModal open title={playing.title} footer={null} width="min(1000px, calc(100vw - 24px))" onCancel={() => setPlayingId(null)} destroyOnHidden>
                    <div className="aspect-video" data-canvas-no-zoom onPointerDown={stop} onWheel={handleWheel}>
                        {url ? (
                            <Suspense fallback={<span>加载播放器</span>}>
                                <VideoPlayer src={url} title={playing.title} autoPlay preload="metadata" className="size-full" />
                            </Suspense>
                        ) : (
                            <span>{loading ? "加载视频中" : "视频暂不可用"}</span>
                        )}
                    </div>
                </AppModal>
            ) : null}
        </section>
    );
}
