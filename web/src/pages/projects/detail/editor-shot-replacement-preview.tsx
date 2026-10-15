import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Loader2, LocateFixed, RefreshCw, Replace } from "lucide-react";
import type { ShotArtifact } from "@/services/api/projects";
import { resourceFileUrl } from "@/services/api/resources";
import type { ShotReplacementPlan } from "@/lib/timeline/shot-replacement";
import { formatTimelineTime } from "@/lib/timeline/timeline-view";

export function EditorShotReplacementPreview({ plan, artifacts, busy, error, onClose, onRefresh, onReplace, onLocate }: {
    plan: ShotReplacementPlan;
    artifacts: ShotArtifact[];
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onRefresh: () => void;
    onReplace: () => void;
    onLocate: (id: string) => void;
}) {
    const [mode, setMode] = useState<"before" | "after">("after");
    const [clipIndex, setClipIndex] = useState(0);
    const [mediaError, setMediaError] = useState(false);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const clip = plan.clips[clipIndex] || plan.clips[0];
    const previous = artifacts.find((item) => item.id === clip?.shotSource?.artifactId);
    const resourceId = mode === "after" ? plan.resourceId : clip?.shotSource?.resourceId;
    useEffect(() => setMediaError(false), [resourceId, mode]);
    useEffect(() => {
        const video = videoRef.current;
        return () => { if (video) { video.pause(); video.removeAttribute("src"); video.load(); } };
    }, [resourceId, mode, clip?.id]);
    const oldDuration = clip?.sourceDurationMs;
    const seconds = (ms?: number) => ms && Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} 秒` : "未知";
    return <section className="flex min-h-0 flex-1 flex-col text-xs text-[var(--director-dock-fg)]" aria-label="镜头素材替换对照">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--director-sequencer-border)] px-2 py-2">
            <button type="button" title="返回镜头列表" aria-label="返回镜头列表" onClick={onClose} className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-[var(--director-control-hover)]"><ArrowLeft className="size-4" /></button>
            <span className="min-w-0 flex-1 break-words font-medium text-[var(--director-dock-fg-strong)]">{plan.title}</span>
            <button type="button" title="刷新替换对照" aria-label="刷新替换对照" disabled={busy} onClick={onRefresh} className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-[var(--director-control-hover)] disabled:opacity-40">{busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}</button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            <div className="flex items-center gap-2 text-[11px]"><span>原视频 {previous ? `v${previous.version}` : "版本未知"}</span><ArrowRight className="size-3.5 shrink-0" /><span>采用 {plan.version ? `v${plan.version}` : "版本未知"}</span></div>
            <div role="group" aria-label="素材对照" className="flex border-b border-[var(--director-sequencer-border)]">
                {(["before", "after"] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}
                    className={`min-h-8 flex-1 px-2 ${mode === value ? "border-b-2 border-[var(--director-accent)] text-[var(--director-dock-fg-strong)]" : "opacity-60"}`}>{value === "before" ? "原素材" : "采用素材"}</button>)}
            </div>
            {resourceId ? <video ref={videoRef} key={`${mode}:${resourceId}:${clip?.id}`} src={resourceFileUrl(resourceId)} controls preload="metadata" playsInline
                className="aspect-video w-full bg-black object-contain" onError={() => setMediaError(true)}
                onLoadedMetadata={(event) => { const target = event.currentTarget; const offset = (clip?.sourceStartMs ?? 0) / 1000; if (Number.isFinite(target.duration) && offset < target.duration) target.currentTime = offset; }} /> : <p>没有可预览的素材</p>}
            {mediaError ? <p role="alert" className="text-[var(--director-warning)]">素材预览失败，请检查资源后重试</p> : null}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[11px]">
                <dt>原素材时长</dt><dd>{seconds(oldDuration)}</dd>
                <dt>新素材时长</dt><dd>{seconds(plan.durationMs)}</dd>
                <dt>影响片段</dt><dd>{plan.clips.length}</dd>
            </dl>
            {plan.clips.length > 1 ? <select aria-label="对照片段" value={clipIndex < plan.clips.length ? clipIndex : 0} onChange={(event) => setClipIndex(Number(event.target.value))}
                className="min-h-8 w-full rounded-md border border-[var(--director-sequencer-border)] bg-[var(--director-sequencer-surface)] px-2">
                {plan.clips.map((item, index) => <option key={item.id} value={index}>{index + 1}. {item.title || "片段"}</option>)}
            </select> : null}
            {plan.clips.map((item, index) => <div key={item.id} className="border-t border-[var(--director-sequencer-border)] pt-2">
                <div className="flex items-start gap-2"><span className="min-w-0 flex-1 break-words">{index + 1}. {item.title || "片段"}</span><button type="button" title="定位片段" aria-label={`定位片段 ${index + 1}`} onClick={() => onLocate(item.id)} className="grid size-6 shrink-0 place-items-center rounded-md hover:bg-[var(--director-control-hover)]"><LocateFixed className="size-3.5" /></button></div>
                <p className="mt-1 text-[11px]">时间线 {formatTimelineTime(item.startMs)} · 时长 {seconds(item.durationMs)}</p>
                <p className="mt-1 text-[11px]">保留源区间 {formatTimelineTime(item.sourceStartMs ?? 0)} 至 {formatTimelineTime((item.sourceStartMs ?? 0) + item.durationMs)}</p>
            </div>)}
            {plan.blockers.length ? <ul role="alert" className="space-y-2 break-words text-[var(--director-warning)]">{plan.blockers.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}
        </div>
        <div className="shrink-0 space-y-2 border-t border-[var(--director-sequencer-border)] p-3">
            {error ? <p role="alert" className="break-words text-[var(--director-danger)]">{error}</p> : null}
            <button type="button" disabled={busy || !!plan.blockers.length || !plan.commands.length} onClick={onReplace}
                className="flex min-h-8 w-full items-center justify-center gap-2 rounded-md bg-[var(--director-control-hover)] px-2 py-1.5 text-[var(--director-dock-fg-strong)] disabled:opacity-40"><Replace className="size-4 shrink-0" /><span>替换 {plan.clips.length} 个片段</span></button>
        </div>
    </section>;
}
