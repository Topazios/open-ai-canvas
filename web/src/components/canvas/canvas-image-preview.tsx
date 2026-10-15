import { useEffect, useState } from "react";
import { Button, Image } from "antd";
import { Image as ImageIcon, LoaderCircle, RotateCcw, RotateCw, Scan, X, ZoomIn, ZoomOut } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { resourceStorageKeyFromURL } from "@/services/api/resources";
import { resolveImageUrl } from "@/services/image-storage";
import "./canvas-image-preview.css";

type CanvasImagePreviewProps = { src?: string; storageKey?: string; alt?: string; onClose: () => void };

export function CanvasImagePreview({ src = "", storageKey, alt = "图片", onClose }: CanvasImagePreviewProps) {
    const [resolved, setResolved] = useState<{ source: string; url: string } | null>(null);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const source = `${storageKey || ""}:${src}`;
    const resolvedSrc = resolved?.source === source ? resolved.url : "";
    useEffect(() => {
        let cancelled = false;
        setResolved(null); setError(false);
        if (src || storageKey) void resolveImageUrl(storageKey || resourceStorageKeyFromURL(src), src)
            .then((url) => { if (!cancelled) { setResolved({ source, url }); setError(!url); } })
            .catch(() => { if (!cancelled) setError(true); });
        return () => { cancelled = true; };
    }, [src, storageKey, source, attempt]);
    if (!src && !storageKey) return null;
    if (!resolvedSrc || error) return <AppModal open title={alt} footer={null} centered onCancel={onClose} className="canvas-image-preview-modal">
        <div className="flex min-h-48 flex-col items-center justify-center gap-4" role={error ? "alert" : "status"}>
            {error ? <><ImageIcon /><span>图片暂时无法显示</span><Button onClick={() => setAttempt((value) => value + 1)}>重新加载</Button></> : <><LoaderCircle className="animate-spin motion-reduce:animate-none" /><span>正在加载高清图片</span></>}
        </div>
    </AppModal>;
    return <Image key={`${source}:${attempt}`} src={resolvedSrc} alt={alt} draggable={false}
        styles={{ root: { display: "none" } }} classNames={{ popup: { root: "canvas-image-lightbox" } }}
        onError={() => setError(true)}
        preview={{ open: true, movable: true, minScale: 0.25, maxScale: 8, scaleStep: 0.25,
            onOpenChange: (open) => { if (!open) onClose(); },
            closeIcon: <X aria-label="关闭图片预览" />,
            imageRender: (image) => <>{image}<div className="canvas-image-preview-title" title={alt}>{alt}</div></>,
            actionsRender: (_, { actions, transform }) => <div className="canvas-image-preview-tools" data-canvas-no-zoom>
                <button type="button" aria-label="缩小图片" title="缩小" disabled={transform.scale <= 0.25} onClick={actions.onZoomOut}><ZoomOut size={18} /></button>
                <output aria-label="图片缩放比例">{Math.round(transform.scale * 100)}%</output>
                <button type="button" aria-label="放大图片" title="放大" disabled={transform.scale >= 8} onClick={actions.onZoomIn}><ZoomIn size={18} /></button>
                <button type="button" aria-label="复位图片" title="复位" onClick={actions.onReset}><Scan size={18} /></button>
                <button type="button" aria-label="向左旋转图片" title="向左旋转" onClick={actions.onRotateLeft}><RotateCcw size={18} /></button>
                <button type="button" aria-label="向右旋转图片" title="向右旋转" onClick={actions.onRotateRight}><RotateCw size={18} /></button>
            </div>,
        }} />;
}
