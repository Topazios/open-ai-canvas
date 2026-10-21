import { Image as ImageIcon, UserRound, Volume2 } from "lucide-react";
import type { ReactNode } from "react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import type { CanvasNodeData } from "@/types/canvas";
import { CanvasNodeActionButton } from "./canvas-node-action-bar";
import { canvasThemes } from "@/lib/canvas-theme";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";
import { Info } from "lucide-react";

export function CanvasCharacterReferenceNodeContent({ node, onInfo }: { node: CanvasNodeData; onInfo?: () => void }) {
    const theme = canvasThemes[useActiveTheme()];
    const visualReady = node.metadata?.characterVisualStatus === "ready";
    const voiceReady = node.metadata?.characterVoiceStatus === "ready";
    return <div className="flex h-full w-full flex-col overflow-hidden bg-background">
        <div className="relative min-h-0 flex-1 overflow-hidden bg-foreground/[.045]">
            {node.metadata?.characterCoverUrl ? <CachedResourceImage src={node.metadata.characterCoverUrl} alt={node.metadata?.characterName || node.title} className="h-full w-full object-contain p-2" draggable={false} eager /> : <div className="grid h-full place-items-center text-foreground/22"><UserRound className="size-12" /></div>}
            <span className="absolute left-3 top-3 rounded bg-black/60 px-2 py-1 text-[var(--fs-tiny)] font-medium text-white">角色引用</span>
        </div>
        <div className="shrink-0 border-t border-border/70 px-3 py-2.5">
            <div className="truncate text-sm font-semibold">{node.metadata?.characterName || node.title}</div>
            <div className="mt-2 flex min-w-0 gap-1.5">
                <State icon={<ImageIcon className="size-3" />} ready={visualReady} label={visualReady ? "形象就绪" : "形象待完善"} />
                <State icon={<Volume2 className="size-3" />} ready={voiceReady} label={voiceReady ? node.metadata?.characterVoiceName || "声音已绑定" : "声音未绑定"} />
            </div>
            {onInfo ? <div className="mt-2 flex min-h-10 items-center justify-start border-t pt-1.5" style={{ borderColor: theme.node.stroke }} data-canvas-no-zoom><CanvasNodeActionButton theme={theme} label="详情" icon={<Info className="size-3.5" />} onClick={onInfo} /></div> : null}
        </div>
    </div>;
}

function State({ icon, ready, label }: { icon: ReactNode; ready: boolean; label: string }) {
    return <span className={`inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-1 text-[var(--fs-tiny)] ${ready ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-foreground/[.055] text-foreground/45"}`}>{icon}<span className="truncate">{label}</span></span>;
}
