import { useEffect, useRef, useState } from "react";
import { Button, Image } from "antd";
import { Image as ImageIcon, LoaderCircle, RotateCcw, RotateCw, Scan, X, ZoomIn, ZoomOut } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import { resourceStorageKeyFromURL } from "@/services/api/resources";
import { resolveImageUrl } from "@/services/image-storage";
import "./canvas-image-preview.css";

export type CanvasImagePreviewItem = { src?: string; storageKey?: string; alt?: string };
type CanvasImagePreviewProps = CanvasImagePreviewItem & { items?: CanvasImagePreviewItem[]; onClose: () => void; index?: number; onNavigate?: (index: number) => void };

export function CanvasImagePreview({ src = "", storageKey, alt = "图片", items, onClose, index = 0, onNavigate }: CanvasImagePreviewProps) {
    const sourceItems = (items?.length ? items : [{ src, storageKey, alt }]).filter(item => item.src || item.storageKey);
    const itemsRef = useRef(sourceItems);
    if (itemsRef.current.length !== sourceItems.length || sourceItems.some((item, index) => {
        const previous = itemsRef.current[index];
        return item.src !== previous.src || item.storageKey !== previous.storageKey || item.alt !== previous.alt;
    })) itemsRef.current = sourceItems;
    const previewItems = itemsRef.current;
    const [resolvedItems, setResolvedItems] = useState<Array<CanvasImagePreviewItem & { src: string }> | null>(null);
    const [error, setError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [current, setCurrent] = useState(index);
    useEffect(() => setCurrent(index), [index]);
    const currentIndex = Math.min(Math.max(current, 0), Math.max(previewItems.length - 1, 0));
    const currentItem = resolvedItems?.[currentIndex];
    const displayItems = resolvedItems || [];
    const navigateRef = useRef<(offset: number) => void>(() => {});
    useEffect(() => {
        if (!currentItem?.src || error) return;
        // Canvas and nested modals stop bubbling key events before native preview listeners.
        const handleKey = (event: KeyboardEvent) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") onClose();
            else navigateRef.current(event.key === "ArrowLeft" ? -1 : 1);
        };
        window.addEventListener("keydown", handleKey, true);
        return () => window.removeEventListener("keydown", handleKey, true);
    }, [currentItem?.src, error, onClose]);
    useEffect(() => {
        let cancelled = false;
        setResolvedItems(null);
        setError(false);
        void Promise.all(previewItems.map(async (item) => {
            const fallback = item.src || "";
            try {
                const url = await resolveImageUrl(item.storageKey || resourceStorageKeyFromURL(fallback), fallback);
                return { ...item, src: url || fallback };
            } catch {
                return { ...item, src: "" };
            }
        }))
            .then((next) => {
                if (cancelled) return;
                setResolvedItems(next);
                setError(!next.some(item => item.src));
            })
            .catch(() => { if (!cancelled) setError(true); });
        return () => { cancelled = true; };
    }, [previewItems, attempt]);
    if (!previewItems.length) return null;
    const currentFailed = error || Boolean(resolvedItems && !currentItem?.src);
    if (!currentItem?.src || currentFailed) return <AppModal open title={previewItems[currentIndex]?.alt || alt} footer={null} centered onCancel={onClose} className="canvas-image-preview-modal">
        <div className="flex min-h-48 flex-col items-center justify-center gap-4" role={currentFailed ? "alert" : "status"}>
            {currentFailed ? <><ImageIcon /><span>图片暂时无法显示</span><Button onClick={() => setAttempt((value) => value + 1)}>重新加载</Button></> : <><LoaderCircle className="animate-spin motion-reduce:animate-none" /><span>正在加载高清图片</span></>}
            {currentFailed && previewItems.length > 1 ? <div className="flex items-center gap-3">
                <Button disabled={currentIndex === 0} onClick={() => { setCurrent(currentIndex - 1); onNavigate?.(currentIndex - 1); }}>上一张</Button>
                <output>{currentIndex + 1} / {previewItems.length}</output>
                <Button disabled={currentIndex === previewItems.length - 1} onClick={() => { setCurrent(currentIndex + 1); onNavigate?.(currentIndex + 1); }}>下一张</Button>
            </div> : null}
        </div>
    </AppModal>;
    return <Image.PreviewGroup
        items={displayItems.map(item => ({ src: item.src, alt: item.alt || alt }))}
        classNames={{ popup: { root: "canvas-image-lightbox" } }}
        preview={{ open: true, current: currentIndex, mask: { closable: true }, movable: true, minScale: 0.25, maxScale: 8, scaleStep: 0.25,
            onOpenChange: (open) => { if (!open) onClose(); },
            onChange: (next) => { setCurrent(next); onNavigate?.(next); },
            closeIcon: <X aria-label="关闭图片预览" />,
            countRender: (current, total) => <output aria-label="当前图片序号">{current} / {total}</output>,
            imageRender: (image, info) => <>{image}<div className="canvas-image-preview-title" title={displayItems[info.current || 0]?.alt || alt}>{displayItems[info.current || 0]?.alt || alt}</div></>,
            actionsRender: (_, { actions, transform }) => {
                navigateRef.current = actions.onActive;
                return <div className="canvas-image-preview-tools" data-canvas-no-zoom>
                <button type="button" aria-label="缩小图片" title="缩小" disabled={transform.scale <= 0.25} onClick={actions.onZoomOut}><ZoomOut size={18} /></button>
                <output aria-label="图片缩放比例">{Math.round(transform.scale * 100)}%</output>
                <button type="button" aria-label="放大图片" title="放大" disabled={transform.scale >= 8} onClick={actions.onZoomIn}><ZoomIn size={18} /></button>
                <button type="button" aria-label="复位图片" title="复位" onClick={actions.onReset}><Scan size={18} /></button>
                <button type="button" aria-label="向左旋转图片" title="向左旋转" onClick={actions.onRotateLeft}><RotateCcw size={18} /></button>
                <button type="button" aria-label="向右旋转图片" title="向右旋转" onClick={actions.onRotateRight}><RotateCw size={18} /></button>
            </div>;
            },
        }}
    />;
}
