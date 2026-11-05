import { Button, Checkbox, Tooltip } from "antd";
import { Image as ImageIcon, RefreshCw, WandSparkles } from "lucide-react";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { storyboardFrameLabels } from "@/lib/canvas/episode-storyboard-frames";
import { storyboardFrameTrack, storyboardFrameTrackLabel, type StoryboardFrameTrackItem } from "@/lib/canvas/storyboard-frame-track";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { storyboardFramePrerequisite } from "@/lib/canvas/storyboard-frame-continuity";
import { StoryboardFrameKind, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";
import type { StoryboardImagePreview } from "./canvas-storyboard-image-stack";

export function CanvasEpisodeFrameGallery({ row, nodes, onPreview, onManage, trackItems, selectedIds = [], onToggle, onGenerate, preparing = false, previewGroup }: {
    row: StoryboardRow;
    nodes: CanvasNodeData[];
    onPreview: StoryboardImagePreview;
    onManage: (rowId: string) => void;
    trackItems?: StoryboardFrameTrackItem[];
    selectedIds?: string[];
    onToggle?: (id: string, checked: boolean) => void;
    onGenerate?: (item: StoryboardFrameTrackItem) => void;
    preparing?: boolean;
    previewGroup?: CanvasNodeData[];
}) {
    const items = trackItems || storyboardFrameTrack([row], nodes);
    const group = previewGroup || items.flatMap(item => {
        const image = nodes.find(node => node.id === item.frame.imageNodeId);
        return image && (image.metadata?.content || image.metadata?.storageKey) ? [{ ...image, title: item.usages.map(usage => `${usage.shot} ${storyboardFrameLabels[usage.kind]}`).join(" · ") }] : [];
    });
    return <div className="canvas-episode-frame-gallery" role="group" aria-label={`${row.shotCode || row.shotNumber} 画面帧`}>
        {items.map(item => {
            const { frame } = item;
            const image = nodes.find(node => node.id === frame.imageNodeId);
            const plan = item.needsPlan ? nodes.find(node => node.id === row.framePlanNodeId) : undefined;
            const target = image || plan;
            const ready = Boolean(image?.metadata?.content || image?.metadata?.storageKey);
            const latest = target && nodes.flatMap(node => (node.metadata?.generationBatches || []).flatMap(batch => batch.items.filter(entry => entry.nodeId === target.id).map(entry => ({ batch, entry })))).at(-1);
            const waiting = latest && !latest.batch.paused && ["waiting", "submitting", "queued", "running"].includes(latest.entry.status);
            const running = isCanvasNodeGenerating(target) || Boolean(waiting);
            const label = `${storyboardFrameTrackLabel(item)}${frame.kind === StoryboardFrameKind.Key && !item.needsPlan ? ` ${frame.timeSeconds}秒` : ""}`;
            const usageLabel = item.usages.map(usage => `${usage.shot} ${storyboardFrameLabels[usage.kind]}`).join(" · ");
            const dependency = image && !ready ? storyboardFramePrerequisite(image, nodes) : undefined;
            const status = !item.ready ? "待镜头详情" : running ? item.needsPlan ? "提取中" : "生成中" : ready ? "已生成" : target?.metadata?.taskStatus === "cancelled" ? "已暂停" : target?.metadata?.taskStatus === "failed" || target?.metadata?.status === "error" ? "生成失败" : dependency && !dependency.ready ? dependency.reason : "待生成";
            const command = ready ? "重新生成" : "生成";
            return <div key={item.id} className={`canvas-episode-frame-item${selectedIds.includes(item.id) ? " is-selected" : ""}`} data-frame-id={item.id}>
                <div className="canvas-episode-frame-item-header">
                    {onToggle ? <Checkbox checked={selectedIds.includes(item.id)} onChange={event => onToggle(item.id, event.target.checked)} aria-label={`选择${usageLabel}`} /> : null}
                    <span title={label}>{label}</span>
                    {onGenerate ? <Tooltip title={`${command} · ${usageLabel}`}><Button type="text" size="small" aria-label={`${command} ${usageLabel}`} disabled={running || preparing} icon={ready ? <RefreshCw size={12} /> : <WandSparkles size={12} />} onClick={() => onGenerate(item)} /></Tooltip> : null}
                </div>
                <button type="button" className="canvas-episode-frame-tile" onClick={() => ready && image ? onPreview(image, group) : onManage(item.rowId)} title={`${usageLabel} · ${status}`} aria-label={`查看${usageLabel}，${status}`}>
                    <span className="canvas-episode-frame-tile-image">
                        {ready && image ? <CachedResourceImage storageKey={image.metadata?.storageKey} src={image.metadata?.previewContent || image.metadata?.content} alt={usageLabel} className="size-full object-cover" loading="lazy" /> : <ImageIcon size={16} aria-hidden="true" />}
                    </span>
                    <span className="canvas-episode-frame-tile-status" data-state={running ? "running" : ready ? "ready" : status === "生成失败" ? "failed" : "waiting"}>{status}</span>
                </button>
                <div className="canvas-episode-frame-usages" aria-label="使用分镜" title={usageLabel}>
                    {item.usages.map(usage => <span key={`${usage.rowId}-${usage.kind}`} title={`${usage.code || usage.shot} ${storyboardFrameLabels[usage.kind]}`}>{usage.shot} {storyboardFrameLabels[usage.kind]}</span>)}
                </div>
            </div>;
        })}
    </div>;
}
