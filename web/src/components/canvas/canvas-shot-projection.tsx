import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { CanvasNodeActionContext } from "./canvas-node-action-context";
import { AudioNodeContent, ImageNodeContent, VideoNodeContent } from "./canvas-node-media-content";
import type { CanvasNodeContentProps } from "./canvas-node-content";
import { canvasShotBindingLabel, canvasShotMediaNode, type CanvasShotBinding } from "@/lib/canvas/canvas-shot-projection";

const READ_ONLY_ACTIONS = {};

export function CanvasShotProjection({ binding, refresh, ...props }: CanvasNodeContentProps & { binding: CanvasShotBinding; refresh: () => void }) {
    const { view, link } = binding;
    const mediaNode = useMemo(() => canvasShotMediaNode(props.node, binding), [props.node, binding]);
    const revision = !binding.unavailable ? view?.revision : undefined;
    const full = props.renderLOD === "full";
    const mediaBox = useRef<HTMLDivElement>(null);
    const [mediaSize, setMediaSize] = useState<{ width: number; height: number } | null>(null);
    useEffect(() => {
        const element = mediaBox.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => {
            if (!entry) return;
            const { width, height } = entry.contentRect;
            setMediaSize((current) => current?.width === width && current.height === height ? current : { width, height });
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [mediaNode?.metadata?.storageKey]);
    const available = !binding.unavailable && Boolean(view) && !["shot_missing", "unit_missing", "node_missing"].includes(view!.state);
    const route = `/projects/${encodeURIComponent(link.projectId)}/workflow/${encodeURIComponent(link.unitId)}/storyboard`;
    const status = canvasShotBindingLabel(binding);
    const safeProps = mediaNode ? { ...props, node: { ...mediaNode, ...(mediaSize || {}) }, isEditingContent: false, isBatchRoot: false, batchCount: 0, batchPreviewNodes: undefined } : null;
    return <section aria-label="项目镜头视图" data-canvas-no-zoom data-canvas-wheel-scroll onWheel={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} className="flex min-h-0 w-full flex-1 flex-col overflow-hidden" style={{ color: props.theme.node.text, background: props.theme.node.fill }}>
        <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1.5 text-xs" style={{ borderColor: props.theme.toolbar.border }}>
            <div className="min-w-0 flex-1"><p className="truncate font-medium">{view?.shotTitle || "项目镜头"}</p><p className="truncate opacity-65" role="status">{status}{revision ? ` · 已关联 v${revision.version}` : ""}</p></div>
            {full ? <>
                <button type="button" aria-label="刷新项目镜头" title="刷新项目镜头" onClick={refresh} className="grid size-7 shrink-0 place-items-center rounded"><RefreshCw className="size-3.5" /></button>
                {available ? <Link to={route} aria-label="编辑项目镜头" title="编辑项目镜头" className="grid size-7 shrink-0 place-items-center rounded" onClick={() => sessionStorage.setItem(`project-workflow-selected-shot:${link.projectId}`, link.shotId)}><ArrowUpRight className="size-3.5" /></Link> : null}
            </> : null}
        </div>
        {safeProps ? <div ref={mediaBox} className="min-h-0 w-full flex-1 overflow-hidden">
            <CanvasNodeActionContext.Provider value={READ_ONLY_ACTIONS}>
                {mediaNode!.type === "image" ? <ImageNodeContent {...safeProps} /> : mediaNode!.type === "audio" ? <AudioNodeContent {...safeProps} /> : <VideoNodeContent {...safeProps} />}
            </CanvasNodeActionContext.Provider>
        </div> : <div data-canvas-wheel-scroll className="min-h-0 flex-1 select-text overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-xs leading-5">
            {binding.unavailable || !view ? <p>项目内容读取失败或尚未就绪，请刷新。</p> : <>
                {link.artifactId && view.state !== "current" ? <p className="mb-2">{status}。重新确认映射后可播放。</p> : null}
                {revision && available ? <>
                    <p>{revision.plotDescription || "暂无画面描述"}</p>
                    {full && revision.action ? <p className="mt-2">动作：{revision.action}</p> : null}
                    {full && revision.dialogue ? <p className="mt-2">对白：{revision.dialogue}</p> : null}
                    {full && revision.continuityNotes ? <p className="mt-2">连续性：{revision.continuityNotes}</p> : null}
                </> : <p>{status}</p>}
            </>}
        </div>}
    </section>;
}
