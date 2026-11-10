import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronUp } from "lucide-react";
import { AIMessageMarkdown } from "@/components/ai/ai-message-markdown";
import { largeDocumentThreshold, parseVirtualDocument, type DocumentBlock, type DocumentTable } from "@/lib/canvas/virtual-document";

const gridStyle = (table: DocumentTable) => ({ gridTemplateColumns: [...table.widths.map((width) => `${width}px`), "40px"].join(" "), width: table.widths.reduce((sum, width) => sum + width, 40) });

export const CanvasVirtualDocument = memo(function CanvasVirtualDocument({ source }: { source: string }) {
    const local = useMemo(() => (source.length <= largeDocumentThreshold ? parseVirtualDocument(source) : null), [source]);
    const [remote, setRemote] = useState<{ source: string; blocks?: DocumentBlock[]; error?: string } | null>(null);
    useEffect(() => {
        if (source.length <= largeDocumentThreshold) return;
        if (typeof Worker === "undefined") {
            setRemote({ source, error: "当前浏览器无法打开此文稿，请使用编辑模式。" });
            return;
        }
        let worker: Worker;
        try {
            worker = new Worker(new URL("../../lib/canvas/virtual-document.worker.ts", import.meta.url), { type: "module" });
        } catch {
            setRemote({ source, error: "文稿加载失败，可切换到编辑模式查看。" });
            return;
        }
        worker.onmessage = (event: MessageEvent<{ blocks?: DocumentBlock[]; error?: string }>) => {
            setRemote({ source, ...event.data });
            worker.terminate();
        };
        worker.onerror = () => {
            setRemote({ source, error: "文稿加载失败，可切换到编辑模式查看。" });
            worker.terminate();
        };
        worker.postMessage(source);
        return () => {
            worker.onmessage = null;
            worker.onerror = null;
            worker.terminate();
        };
    }, [source]);
    const blocks = local ?? (remote?.source === source ? remote.blocks : undefined);
    if (!blocks)
        return (
            <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm" role="status">
                {remote?.source === source && remote.error ? remote.error : "正在打开文稿…"}
            </div>
        );
    return <CanvasVirtualDocumentView key={source} blocks={blocks} />;
});

export const CanvasVirtualDocumentView = memo(function CanvasVirtualDocumentView({ blocks }: { blocks: DocumentBlock[] }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
    const virtualizer = useVirtualizer({ count: blocks.length, getScrollElement: () => scrollRef.current, estimateSize: (index) => (blocks[index]?.table ? (blocks[index].header ? 44 : 96) : 100), overscan: 6, initialRect: { width: 1080, height: 640 } });
    const visible = virtualizer.getVirtualItems();
    const activeTable = blocks[visible.find((item) => item.end > (virtualizer.scrollOffset ?? 0))?.index ?? 0]?.table;
    const minWidth = useMemo(() => blocks.reduce((width, block) => (block.header ? Math.max(width, gridStyle(block.table!).width) : width), 320), [blocks]);
    const toggle = (id: number) =>
        setExpanded((prior) => {
            const next = new Set(prior);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    return (
        <div ref={scrollRef} className="thin-scrollbar relative min-h-0 flex-1 overflow-auto" data-canvas-no-zoom data-canvas-wheel-scroll data-testid="virtual-document">
            <div style={{ minWidth }} role="table" aria-label="文稿内容">
                {activeTable && (
                    <div className="sticky top-0 z-10 h-0" aria-hidden="true">
                        <div className="grid border-b bg-[var(--background)] font-semibold text-sm" role="row" style={gridStyle(activeTable)}>
                            {activeTable.headers.map((title, index) => (
                                <div key={index} className="px-3 py-3" role="columnheader">
                                    {title}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                    {visible.map((item) => {
                        const block = blocks[item.index];
                        return (
                            <div key={block.id} ref={virtualizer.measureElement} data-index={item.index} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}>
                                {block.table ? (
                                    <VirtualTableRow block={block} expanded={expanded.has(block.id)} toggle={() => toggle(block.id)} />
                                ) : (
                                    <div className="max-w-[1100px] px-6 py-3 sm:px-10">{block.plain ? <div className="whitespace-pre-wrap break-words text-sm leading-7">{block.text}</div> : <AIMessageMarkdown>{block.text}</AIMessageMarkdown>}</div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
});

function VirtualTableRow({ block, expanded, toggle }: { block: DocumentBlock; expanded: boolean; toggle: () => void }) {
    if (block.header)
        return (
            <div className="grid border-b text-sm font-semibold" role="row" style={gridStyle(block.table!)}>
                {block.cells?.map((cell, index) => (
                    <div key={index} role="columnheader" className="px-3 py-3">
                        {cell}
                    </div>
                ))}
            </div>
        );
    return (
        <div className="grid border-b border-[var(--border)] text-sm leading-6" role="row" style={gridStyle(block.table!)}>
            {block.cells?.map((cell, index) => (
                <div key={index} role="cell" className="min-w-0 px-3 py-3 text-left align-top" style={{ overflowWrap: "anywhere" }}>
                    <div className={expanded ? "whitespace-pre-wrap" : "line-clamp-3"}>{cell}</div>
                </div>
            ))}
            <button
                type="button"
                className="mt-3 flex size-8 items-center justify-center self-start rounded hover:bg-[var(--accent)]"
                onClick={toggle}
                aria-expanded={expanded}
                aria-label={expanded ? "收起行内容" : "展开行内容"}
                title={expanded ? "收起行内容" : "展开行内容"}
            >
                {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </button>
        </div>
    );
}
