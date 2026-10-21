import { useState } from "react";
import { Button, Select } from "antd";
import { Images, Info, RefreshCw, ScanSearch } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { ModelPicker } from "@/components/model-picker";
import { useEffectiveConfig } from "@/stores/use-config-store";
import { buildGenerationConfig } from "@/lib/canvas/canvas-project-generation";
import { shotKeyframes, storyboardDisplayFrames, storyboardFrameLabels } from "@/lib/canvas/episode-storyboard-frames";
import { storyboardPreviousFrameSource } from "@/lib/canvas/workflow-episode-storyboard";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { storyboardFramePrerequisite } from "@/lib/canvas/storyboard-frame-continuity";
import { CanvasGenerationTaskDetails } from "@/pages/canvas/canvas-generation-task-details";
import { StoryboardStartFrameMode, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";
import type { GenerationTask } from "@/services/api/task-center";
import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { CanvasStoryboardImageStack, type StoryboardImagePreview } from "./canvas-storyboard-image-stack";

export function CanvasEpisodeShotFrames({ row, rows, nodes, previewOpen = false, onUpdate, onClose, onExtract, onGenerate, onRetry, onCancel, onPreview, onModelChange }: {
    previewOpen?: boolean;
    rows: StoryboardRow[]; onUpdate: (patch: Partial<StoryboardRow>) => void;
    row: StoryboardRow; nodes: CanvasNodeData[]; onClose: () => void;
    onExtract: () => Promise<void>; onGenerate: () => Promise<void>;
    onRetry: (node: CanvasNodeData) => void; onCancel: (task: GenerationTask) => void;
    onPreview: StoryboardImagePreview; onModelChange: (kind: "text" | "image", model: string) => void;
}) {
    const theme = canvasThemes[useActiveTheme()];
    const config = useEffectiveConfig(), textConfig = buildGenerationConfig(config, undefined, "text"), imageConfig = buildGenerationConfig(config, undefined, "image");
    const [preparing, setPreparing] = useState(false), [detailsId, setDetailsId] = useState<string>();
    const { frames: extracted, plan, error } = shotKeyframes(row, nodes);
    const previous = storyboardPreviousFrameSource(row, rows);
    const frames = storyboardDisplayFrames(row, nodes);
    const frameGroups = [
        { label: "首尾帧", frames: frames.filter(frame => frame.kind !== "key") },
        { label: "关键帧", frames: frames.filter(frame => frame.kind === "key") },
    ];
    const running = isCanvasNodeGenerating(plan) || nodes.some(node => node.metadata?.generationBatches?.some(batch => !batch.paused && batch.items.some(item => item.nodeId === plan?.id && ["waiting", "submitting", "queued", "running"].includes(item.status))));
    const details = nodes.find(node => node.id === detailsId);
    return <AppModal open focusable={{ trap: !previewOpen }} title={`镜头 ${row.shotCode || row.shotNumber} · 关键帧`} footer={null} width="min(920px, calc(100vw - 24px))" onCancel={onClose}>
        <div className="thin-scrollbar max-h-[75dvh] space-y-4 overflow-y-auto" data-canvas-no-zoom onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
                <label htmlFor="shot-start-frame-mode">首帧衔接</label>
                <Select id="shot-start-frame-mode" aria-label="首帧衔接" className="min-w-52" value={row.startFrameMode || StoryboardStartFrameMode.Auto} disabled={rows[0]?.id === row.id} onChange={startFrameMode => onUpdate({ startFrameMode })} options={[
                    { value: StoryboardStartFrameMode.Auto, label: "自动衔接（换场、转场除外）" },
                    { value: StoryboardStartFrameMode.ReusePrevious, label: "复用上一镜尾帧" },
                    { value: StoryboardStartFrameMode.Independent, label: "独立首帧" },
                ]} />
                <span>{previous ? `首帧复用 ${previous.shotCode || previous.shotNumber} 的尾帧` : "独立生成首帧"}</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs"><span>提取模型</span><ModelPicker fullWidth capability="text" config={textConfig} value={textConfig.model} onChange={model => onModelChange("text", model)} /></label>
                <label className="space-y-1 text-xs"><span>生图模型</span><ModelPicker fullWidth capability="image" config={imageConfig} value={imageConfig.model} onChange={model => onModelChange("image", model)} /></label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <Button icon={<ScanSearch size={15} />} loading={running} onClick={() => void onExtract()}>{plan ? "重新提取关键帧" : "提取关键帧"}</Button>
                <Button type="primary" icon={<Images size={15} />} disabled={!extracted.length || running || Boolean(error)} loading={preparing} onClick={async () => { setPreparing(true); try { await onGenerate(); } finally { setPreparing(false); } }}>生成关键帧图片</Button>
                {plan?.metadata?.taskId ? <Button type="text" icon={<Info size={15} />} onClick={() => setDetailsId(plan.id)}>提取详情</Button> : null}
            </div>
            {running ? <p role="status" className="text-sm">{plan?.metadata?.taskStage || "正在提取当前镜头关键帧"}</p> : null}
            {error || plan?.metadata?.status === "error" ? <p role="alert" className="text-sm" style={{ color: theme.accent.danger }}>{error || plan?.metadata?.errorDetails || "提取失败，可以重新提取"}</p> : null}
            {frames.length ? <div className="space-y-4">{frameGroups.filter(group => group.frames.length).map(group => <section key={group.label} aria-label={group.label}>
                <h3 className="text-sm font-medium">{group.label}</h3>
                <CanvasStoryboardImageStack label={group.label} onPreview={onPreview} items={group.frames.map(frame => {
                    const image = nodes.find(node => node.id === frame.imageNodeId);
                    const label = `${row.shotCode || row.shotNumber} ${storyboardFrameLabels[frame.kind]} ${frame.timeSeconds}秒`;
                    return { id: frame.id, label, node: image ? { ...image, title: label } : undefined };
                })} onManage={() => {
                    const image = group.frames.map(frame => nodes.find(node => node.id === frame.imageNodeId)).find(node => node?.metadata?.taskId);
                    if (image) setDetailsId(image.id);
                }} />
                {group.frames.map(frame => {
                const image = nodes.find(node => node.id === frame.imageNodeId), ready = Boolean(image?.metadata?.content || image?.metadata?.storageKey);
                const dependency = image && !ready ? storyboardFramePrerequisite(image, nodes) : undefined;
                return <article key={frame.id} className="flex flex-wrap gap-3 border-b py-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="min-w-0 flex-1"><strong className="text-sm">{storyboardFrameLabels[frame.kind]} · {frame.timeSeconds} 秒{frame.sharedFrom ? " · 复用上一镜尾帧" : ""}</strong><p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5">{frame.prompt}</p><div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        <span>{ready ? "已生成" : dependency && !dependency.ready ? dependency.reason : image?.metadata?.status === "error" ? "生成失败" : isCanvasNodeGenerating(image) ? image?.metadata?.taskStage || "生成中" : "待生成"}</span>
                        {image?.metadata?.taskId ? <Button type="text" size="small" icon={<Info size={14} />} onClick={() => setDetailsId(image.id)}>详情</Button> : null}
                        {image?.metadata?.status === "error" ? <Button type="text" size="small" icon={<RefreshCw size={14} />} onClick={() => onRetry(image)}>重试</Button> : null}
                    </div>{image?.metadata?.status === "error" && image.metadata.errorDetails ? <p role="alert" className="mt-2 whitespace-pre-wrap break-words text-xs" style={{ color: theme.accent.danger }}>{image.metadata.errorDetails}</p> : null}</div>
                </article>;
                })}
            </section>)}</div> : <p className="text-sm opacity-60">尚未提取关键帧</p>}
            {details?.metadata?.taskId ? <CanvasGenerationTaskDetails key={details.id} node={details} onRetry={node => node.metadata?.storyboardFramePlan ? void onExtract() : onRetry(node)} onCancel={onCancel} /> : null}
        </div>
    </AppModal>;
}
