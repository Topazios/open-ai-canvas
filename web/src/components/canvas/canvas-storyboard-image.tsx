import { Eye } from "lucide-react";
import { CachedResourceImage } from "@/components/cached-resource-image";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasStoryboardImage({ node, label = node.title, onPreview, className = "h-12 w-16" }: {
    node: CanvasNodeData; label?: string; onPreview: (node: CanvasNodeData) => void; className?: string;
}) {
    return <button type="button" className={`relative block shrink-0 cursor-zoom-in overflow-hidden rounded border border-current/10 ${className}`} aria-label={`放大预览 ${label}`} title={`放大预览 ${label}`} onClick={() => onPreview(node)}>
        <span className="absolute inset-0 block overflow-hidden">
            <CachedResourceImage storageKey={node.metadata?.storageKey} src={node.metadata?.previewContent || node.metadata?.content} className="absolute inset-0 block size-full min-h-0 min-w-0 object-contain" alt={label} loading="lazy" />
        </span>
        <Eye className="absolute bottom-0.5 right-0.5 size-3.5 rounded-sm bg-black/60 p-0.5 text-white" />
    </button>;
}
