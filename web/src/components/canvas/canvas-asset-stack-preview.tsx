import { memo, useMemo, type CSSProperties } from "react";
import { FileText, Images, Music2 } from "lucide-react";
import { CachedResourceImage } from "@/components/cached-resource-image";
import { assetStackMembers, assetStackPreviews } from "@/lib/canvas/canvas-asset-stack";
import type { CanvasTheme } from "@/lib/canvas-theme";
import { markdownPlainText } from "@/lib/markdown-plain-text";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import "./canvas-asset-stack-preview.css";

export const CanvasAssetStackPreview = memo(function CanvasAssetStackPreview({ frame, children, theme, onOpen }: {
    frame: CanvasNodeData; children: CanvasNodeData[]; theme: CanvasTheme; onOpen: () => void;
}) {
    const members = useMemo(() => assetStackMembers(frame, children), [frame, children]);
    const previews = useMemo(() => assetStackPreviews(members), [members]);
    const layers = previews.length ? previews : [undefined];
    return <button type="button" className="canvas-asset-stack-preview" aria-label={`展开${frame.title}，共 ${members.length} 项资产`}
        aria-expanded={false} title={`展开${frame.title}`} data-canvas-no-zoom
        style={{ "--asset-stack-fill": theme.node.fill, "--asset-stack-stroke": theme.node.stroke,
            "--asset-stack-text": theme.node.text, "--asset-stack-muted": theme.node.muted,
            "--asset-stack-focus": theme.frame.activeStroke } as CSSProperties}
        onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onOpen(); }}>
        {[...layers].reverse().map((node, reverseIndex) => {
            const depth = layers.length - reverseIndex - 1;
            const image = node?.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey);
            const sound = node?.type === CanvasNodeType.Audio || frame.metadata?.shortDrama?.planGroup?.kind === "sound";
            const Icon = sound ? Music2 : FileText;
            const summary = node?.type === CanvasNodeType.Text ? markdownPlainText((node.metadata?.content || "").slice(0, 800)).slice(0, 150) : "";
            return <span key={node?.id || "empty"} className="canvas-asset-stack-sheet" data-stack-depth={depth} aria-hidden={depth !== 0}>
                {image && node ? <CachedResourceImage storageKey={node.metadata?.storageKey} src={node.metadata?.previewContent || node.metadata?.content}
                    alt={depth === 0 ? node.title : ""} className="canvas-asset-stack-image" loading="lazy" decoding="async" draggable={false} /> :
                    <span className="canvas-asset-stack-document"><Icon size={24} aria-hidden="true" />
                        <strong>{node?.title || frame.title}</strong><span>{summary || (node ? "内容待生成" : "暂无资产")}</span>
                    </span>}
            </span>;
        })}
        <span className="canvas-asset-stack-badge"><Images size={14} aria-hidden="true" />{members.length} 项</span>
    </button>;
});
