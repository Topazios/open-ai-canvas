import { Eye, Image as ImageIcon } from "lucide-react";
import { CachedResourceImage } from "@/components/cached-resource-image";
import type { CanvasNodeData } from "@/types/canvas";
import "./canvas-storyboard-image-stack.css";

export type StoryboardImageStackItem = { id: string; label: string; node?: CanvasNodeData; status?: string; error?: string };
export type StoryboardImagePreview = (node: CanvasNodeData, group?: CanvasNodeData[]) => void;

export function CanvasStoryboardImageStack({ label, items, onPreview, onManage }: {
    label: string; items: StoryboardImageStackItem[]; onPreview: StoryboardImagePreview; onManage?: () => void;
}) {
    if (!items.length) return null;
    const ready = items.filter(item => item.node?.metadata?.content || item.node?.metadata?.storageKey);
    const cover = ready[0] || items[0];
    const layers = [cover, ...items.filter(item => item.id !== cover.id)].slice(0, 3);
    const summary = ready.length === items.length ? `${items.length} 张` : `${ready.length}/${items.length} 已生成`;
    const pending = items.filter(item => !ready.includes(item));
    return <figure className="canvas-storyboard-image-stack" aria-label={label}>
        <button type="button" className="canvas-storyboard-image-stack-trigger" aria-label={`${ready.length ? "放大预览" : "管理"} ${label}`} title={`${label} · ${summary}`} onClick={() => cover.node && ready.length ? onPreview(cover.node, ready.map(item => item.node!)) : onManage?.()}>
            {[...layers].reverse().map((item, reverseIndex) => {
                const depth = layers.length - reverseIndex - 1;
                return <span key={item.id} className="canvas-storyboard-image-stack-layer" data-stack-depth={depth}>
                    {item.node?.metadata?.content || item.node?.metadata?.storageKey ? <CachedResourceImage storageKey={item.node.metadata.storageKey} src={item.node.metadata.previewContent || item.node.metadata.content} className="absolute inset-0 block size-full min-h-0 min-w-0 object-contain" alt={item.label} loading="lazy" /> : <ImageIcon className="size-5 opacity-40" />}
                </span>;
            })}
            <span className="canvas-storyboard-image-stack-count">{items.length}</span>
            {ready.length ? <Eye className="canvas-storyboard-image-stack-eye" size={17} /> : null}
        </button>
        <figcaption className="canvas-storyboard-image-stack-caption">
            <span className="font-medium">{label}</span>
            <span role="status" className="opacity-70">{summary}</span>
            {pending.length ? <button type="button" className="canvas-storyboard-image-stack-pending" onClick={onManage} title={pending.map(item => `${item.label}：${item.error || item.status || "待生成"}`).join("\n")}>
                {pending.some(item => item.error || item.status === "生成失败") ? `失败 ${pending.filter(item => item.error || item.status === "生成失败").length}` : `待处理 ${pending.length}`}
            </button> : null}
        </figcaption>
    </figure>;
}
