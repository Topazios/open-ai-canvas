import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { AIMessageMarkdown } from "@/components/ai/ai-message-markdown";
import type { CanvasTheme } from "@/lib/canvas-theme";

type CanvasMarkdownPreviewProps = {
    source: string;
    theme: CanvasTheme;
    className?: string;
    style?: CSSProperties;
    dataCanvasNoZoom?: boolean;
};

/** 在节点容器内展示 Markdown 预览；内容超出容器时裁切并给出省略提示。 */
export function CanvasMarkdownPreview({ source, theme, className = "", style, dataCanvasNoZoom = false }: CanvasMarkdownPreviewProps) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const [truncated, setTruncated] = useState(false);

    useLayoutEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const update = () => setTruncated(viewport.scrollHeight > viewport.clientHeight + 1);
        update();
        const observer = new ResizeObserver(update);
        observer.observe(viewport);
        return () => observer.disconnect();
    }, [source]);

    return (
        <div
            ref={viewportRef}
            className={`relative block h-full w-full select-text overflow-hidden break-words bg-transparent ${className}`.trim()}
            style={{ ...style, color: style?.color || theme.node.text }}
            data-canvas-no-zoom={dataCanvasNoZoom || undefined}
            onWheel={(event) => event.stopPropagation()}
        >
            <AIMessageMarkdown>{source}</AIMessageMarkdown>
            {truncated ? (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 bottom-0 flex h-8 items-end justify-end px-2 pb-0.5 text-lg font-semibold leading-none"
                    style={{ color: theme.node.text, background: `linear-gradient(to bottom, transparent, ${theme.node.fill} 72%)` }}
                >
                    …
                </div>
            ) : null}
        </div>
    );
}
