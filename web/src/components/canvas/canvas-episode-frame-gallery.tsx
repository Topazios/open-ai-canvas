import { storyboardDisplayFrames, storyboardFrameLabels } from "@/lib/canvas/episode-storyboard-frames";
import { isCanvasNodeGenerating } from "@/lib/canvas/canvas-node-task-state";
import { storyboardFramePrerequisite } from "@/lib/canvas/storyboard-frame-continuity";
import { StoryboardFrameKind, type CanvasNodeData, type StoryboardRow } from "@/types/canvas";
import { CanvasStoryboardImageStack, type StoryboardImagePreview } from "./canvas-storyboard-image-stack";

export function CanvasEpisodeFrameGallery({ row, nodes, onPreview, onManage }: {
    row: StoryboardRow; nodes: CanvasNodeData[]; onPreview: StoryboardImagePreview; onManage: () => void;
}) {
    const frames = storyboardDisplayFrames(row, nodes);
    const groups = [
        { label: "首尾帧", frames: frames.filter(frame => frame.kind !== StoryboardFrameKind.Key) },
        { label: "关键帧", frames: frames.filter(frame => frame.kind === StoryboardFrameKind.Key) },
    ];
    return <div className="canvas-episode-frame-gallery" role="group" aria-label={`${row.shotCode || row.shotNumber} 镜头画面`}>
        {groups.filter(group => group.frames.length).map(group => <div key={group.label} className="canvas-episode-frame-gallery-group" role="group" aria-label={`${row.shotCode || row.shotNumber} ${group.label}`}>
            <CanvasStoryboardImageStack label={group.label} onPreview={onPreview} onManage={onManage} items={group.frames.map(frame => {
            const image = nodes.find(node => node.id === frame.imageNodeId);
            const ready = Boolean(image?.metadata?.content || image?.metadata?.storageKey);
            const waiting = image && nodes.some(node => node.metadata?.generationBatches?.some(batch => !batch.paused && batch.items.some(item => item.nodeId === image.id && ["waiting", "submitting", "queued", "running"].includes(item.status))));
            const label = `${storyboardFrameLabels[frame.kind]}${frame.kind === "key" ? ` ${frame.timeSeconds}秒` : ""}`;
            const dependency = image && !ready ? storyboardFramePrerequisite(image, nodes) : undefined;
            const status = ready ? frame.sharedFrom ? "复用上一镜尾帧" : "已生成" : image?.metadata?.taskStatus === "cancelled" ? "已暂停" : image?.metadata?.taskStatus === "failed" ? "生成失败" : dependency && !dependency.ready ? dependency.reason : image?.metadata?.status === "error" ? "生成失败" : isCanvasNodeGenerating(image) || waiting ? "生成中" : "待生成";
            const error = status === "生成失败" ? image?.metadata?.errorDetails || "生成失败，点击图片查看详情并重试" : "";
            return { id: frame.id, label: `${row.shotCode || row.shotNumber} ${label}`, node: image ? { ...image, title: `${row.shotCode || row.shotNumber} ${label}` } : undefined, status, error };
            })} />
        </div>)}
    </div>;
}
