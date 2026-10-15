import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Film, ListVideo, Loader2, LocateFixed, Music2, RefreshCw, Replace } from "lucide-react";
import type { StoreApi } from "zustand";

import { useEditorStoreContext } from "@/components/editor/editor-context";
import { probeMediaUrlDurationMs } from "@/lib/media-metadata";
import { planShotAssembly, selectedUnitVideos, type ShotAssemblyMedia } from "@/lib/timeline/shot-assembly";
import { planVoiceAssembly } from "@/lib/timeline/voice-assembly";
import { orphanedShotClips, planShotReplacement, type ShotReplacementPlan } from "@/lib/timeline/shot-replacement";
import { formatTimelineTime } from "@/lib/timeline/timeline-view";
import { getActiveUserScope } from "@/lib/user-scope";
import { getProjectUnitWorkspace, type ProjectAsset, type ProjectDetail } from "@/services/api/projects";
import { refreshResource } from "@/services/api/resources";
import { resolveMediaUrl } from "@/services/file-storage";
import type { EditorStore } from "@/stores/editor/editor-store";
import { EditorShotReplacementPreview } from "./editor-shot-replacement-preview";

type Props = {
    detail: ProjectDetail;
    unitId: string;
    assets: ProjectAsset[];
    store: Pick<StoreApi<EditorStore>, "getState">;
};

type AssemblyAction = { kind: "refresh" | "append" | "appendVoice" } | { kind: "preview" | "replace"; shotId: string };

export function EditorShotAssembly({ detail, unitId, assets, store }: Props) {
    const { project, inPreview, selectClip, setTransportMs } = useEditorStoreContext();
    const projectId = detail.project.id;
    const scope = getActiveUserScope();
    const [snapshot, setSnapshot] = useState({ shots: detail.shots, artifacts: detail.shotArtifacts });
    const [media, setMedia] = useState<Record<string, ShotAssemblyMedia>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [replacement, setReplacement] = useState<ShotReplacementPlan | null>(null);
    const requestRef = useRef<AbortController | null>(null);
    useEffect(() => {
        setSnapshot({ shots: detail.shots, artifacts: detail.shotArtifacts });
    }, [detail.shots, detail.shotArtifacts]);
    useEffect(() => () => requestRef.current?.abort(), []);

    const knownMedia = useMemo(() => {
        const initial: Record<string, ShotAssemblyMedia> = {};
        for (const asset of assets) {
            if ((asset.mediaType === "video" || asset.mediaType === "audio") && asset.storageKey?.startsWith("resource:")) {
                initial[asset.storageKey.slice("resource:".length)] = { durationMs: asset.durationMs };
            }
        }
        return { ...initial, ...media };
    }, [assets, media]);
    const input = project ? { projectId, unitId, ...snapshot, media: knownMedia, timeline: project } : null;
    const planResult = useMemo(() => {
        if (!input) return { plan: null, error: null };
        try { return { plan: planShotAssembly(input), error: null }; }
        catch (cause) { return { plan: null, error: cause instanceof Error ? cause.message : String(cause) }; }
    }, [project, projectId, unitId, snapshot, knownMedia]);
    const plan = planResult.plan;
    const voicePlanResult = useMemo(() => {
        if (!input) return { plan: null, error: null };
        try { return { plan: planVoiceAssembly(input), error: null }; }
        catch (cause) { return { plan: null, error: cause instanceof Error ? cause.message : String(cause) }; }
    }, [project, projectId, unitId, snapshot, knownMedia]);
    const voicePlan = voicePlanResult.plan;

    const refresh = async (action: AssemblyAction) => {
        if (requestRef.current || !project || (action.kind !== "appendVoice" && !plan) || (action.kind === "appendVoice" && !voicePlan)) return;
        const controller = new AbortController();
        requestRef.current = controller;
        setBusy(true);
        setError(null);
        setNote(null);
        const isCurrent = () => !controller.signal.aborted && getActiveUserScope() === scope;
        const previewTimeline = store.getState().project;
        try {
            const workspace = await getProjectUnitWorkspace(projectId, unitId);
            if (!isCurrent()) return;
            if (workspace.unit.id !== unitId || workspace.unit.projectId !== projectId) throw new Error("镜头响应与当前集不一致");
            const fresh = { shots: workspace.shots, artifacts: workspace.shotArtifacts };
            const nextMedia = { ...knownMedia };
            const videos = selectedUnitVideos({ projectId, unitId, ...fresh });
            const sounds = fresh.artifacts.filter((artifact) => artifact.projectId === projectId && artifact.unitId === unitId && artifact.type === "audio" && artifact.selected);
            const seen = new Set<string>();
            for (const mediaArtifact of [...videos, ...sounds]) {
                if (!isCurrent()) return;
                const resourceId = mediaArtifact.resourceId;
                if (!resourceId || mediaArtifact.status !== "ready" || seen.has(resourceId)) continue;
                seen.add(resourceId);
                try {
                    const resource = await refreshResource(resourceId);
                    if (!isCurrent()) return;
                    const mediaKind = mediaArtifact.type === "audio" ? "audio" : "video";
                    if (resource.kind !== mediaKind || resource.status !== "ready") throw new Error(`${mediaKind === "audio" ? "音频" : "视频"}资源不可用`);
                    let durationMs = resource.durationMs;
                    if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) {
                        const url = await resolveMediaUrl(`resource:${resourceId}`);
                        if (!isCurrent()) return;
                        durationMs = url ? await probeMediaUrlDurationMs(url, mediaKind, controller.signal) : undefined;
                    }
                    nextMedia[resourceId] = { durationMs };
                } catch (cause) {
                    nextMedia[resourceId] = { error: cause instanceof Error ? cause.message : `读取${mediaArtifact.type === "audio" ? "音频" : "视频"}资源失败` };
                }
            }
            if (!isCurrent()) return;
            // 元数据读取期间镜头可能被删除或改选，再读一次业务来源，拒绝迟到的入轨请求。
            const confirmed = action.kind !== "refresh" ? await getProjectUnitWorkspace(projectId, unitId) : workspace;
            if (!isCurrent()) return;
            if (confirmed.unit.id !== unitId || confirmed.unit.projectId !== projectId) throw new Error("镜头响应与当前集不一致");
            const confirmedSnapshot = { shots: confirmed.shots, artifacts: confirmed.shotArtifacts };
            setSnapshot(confirmedSnapshot);
            setMedia(nextMedia);
            if (action.kind === "refresh") return;
            const current = store.getState();
            if (!current.project || current.project !== previewTimeline || current.inPreview) {
                setError("时间线已变化，请重新检查镜头范围和剪辑区间");
                return;
            }
            const currentInput = { projectId, unitId, ...confirmedSnapshot, media: nextMedia, timeline: current.project };
            if (action.kind === "preview" || action.kind === "replace") {
                const next = planShotReplacement(currentInput, action.shotId);
                setReplacement(next);
                if (action.kind === "preview" || next.blockers.length) return;
                if (!replacement || replacement.signature !== next.signature) {
                    setError("采用版本或剪辑区间已变化，替换对照已更新，请重新检查");
                    return;
                }
                if (!current.dispatchBatch(next.commands, current.project)) {
                    setError(store.getState().saveError || "未能替换镜头");
                    return;
                }
                setReplacement(null);
                setNote(`已替换 ${next.clips.length} 个片段的素材来源`);
                return;
            }
            if (action.kind === "appendVoice") {
                const next = planVoiceAssembly(currentInput);
                if (next.signature !== voicePlan?.signature) {
                    setError("声音来源、对白区间或媒体时长已变化，请刷新后再次追加");
                    return;
                }
                if (!next.count) return;
                if (!current.dispatchBatch(next.commands, current.project)) {
                    setError(store.getState().saveError || "未能追加声音");
                    return;
                }
                setNote(`本次按镜头区间追加 ${next.count} 段声音`);
                return;
            }
            if (!plan) {
                setError("当前集镜头计划不可用，请刷新后重试");
                return;
            }
            const next = planShotAssembly(currentInput);
            if (next.signature !== plan.signature) {
                setError("镜头来源、可用范围或时长已变化，请核对列表后再次追加");
                return;
            }
            if (!next.count) return;
            if (!current.dispatchBatch(next.commands, current.project)) {
                setError(store.getState().saveError || "未能追加镜头");
                return;
            }
            setNote(`本次追加 ${next.count} 个镜头`);
        } catch (cause) {
            if (isCurrent()) setError(cause instanceof Error ? cause.message : "读取当前集镜头失败");
        } finally {
            if (requestRef.current === controller) requestRef.current = null;
            if (!controller.signal.aborted) setBusy(false);
        }
    };

    const orphans = input ? orphanedShotClips(input) : [];
    const blockedCount = (plan?.rows.filter((row) => row.status === "blocked" || row.status === "changed").length ?? 0) + orphans.length;
    const voiceBlockedCount = voicePlan?.rows.filter((row) => row.status === "blocked" || row.status === "changed").length ?? 0;
    const locateClip = (id: string) => {
        const clip = store.getState().project?.clips.find((item) => item.id === id);
        if (clip) { selectClip(id); setTransportMs(clip.startMs); }
    };
    if (replacement) return <EditorShotReplacementPreview plan={replacement} artifacts={snapshot.artifacts} busy={busy || inPreview}
        error={error} onClose={() => { requestRef.current?.abort(); requestRef.current = null; setBusy(false); setReplacement(null); setError(null); }}
        onRefresh={() => void refresh({ kind: "preview", shotId: replacement.shotId })}
        onReplace={() => void refresh({ kind: "replace", shotId: replacement.shotId })} onLocate={locateClip} />;
    return (
        <section className="flex min-h-0 flex-1 flex-col text-xs text-[var(--director-dock-fg)]" aria-label="当前集镜头入轨">
            <div className="flex shrink-0 items-center gap-2 border-b border-[var(--director-sequencer-border)] px-3 py-2">
                <span className="min-w-0 flex-1">镜头 {plan?.rows.length ?? 0} · 可追加 {plan?.count ?? 0} · 待处理 {blockedCount}</span>
                <button type="button" title="刷新镜头及媒体时长" aria-label="刷新镜头及媒体时长" disabled={busy || !project}
                    onClick={() => void refresh({ kind: "refresh" })} className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-[var(--director-control-hover)] disabled:opacity-40">
                    {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={busy}>
                {!project ? <p className="p-3">时间线尚未加载</p> : !plan?.rows.length ? <p className="p-3">当前集还没有镜头</p> : null}
                {plan?.rows.map((row, index) => (
                    <div key={row.shot.id} className="flex items-start gap-2 border-b border-[var(--director-sequencer-border)] px-3 py-2.5">
                        <span className="pt-0.5 text-[var(--director-dock-fg)]/60">{index + 1}</span>
                        <div className="min-w-0 flex-1">
                            <div className="break-words font-medium text-[var(--director-dock-fg-strong)]">{row.shot.title || `镜头 ${index + 1}`}</div>
                            <div className="mt-1 flex items-start gap-1 text-[11px]">
                                {row.status === "added" ? <Check className="mt-0.5 size-3 shrink-0 text-[var(--director-success)]" /> : row.status === "ready" ? <Film className="mt-0.5 size-3 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3 shrink-0 text-[var(--director-warning)]" />}
                                <span className="break-words">{row.reason}{row.durationMs ? ` · ${(row.durationMs / 1000).toFixed(2)} 秒` : ""}</span>
                            </div>
                            {row.artifact ? <div className="mt-1 text-[10px] opacity-60">采用视频 v{row.artifact.version}</div> : null}
                            {row.status === "changed" ? <button type="button" disabled={busy || inPreview} onClick={() => void refresh({ kind: "preview", shotId: row.shot.id })}
                                className="mt-2 flex min-h-7 items-center gap-1.5 rounded-md px-2 text-[var(--director-dock-fg-strong)] hover:bg-[var(--director-control-hover)] disabled:opacity-40">
                                <Replace className="size-3.5" />查看替换
                            </button> : null}
                        </div>
                        {row.clipId ? <button type="button" title="定位已有片段" aria-label={`定位 ${row.shot.title} 已有片段`}
                            className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-[var(--director-control-hover)]"
                            onClick={() => locateClip(row.clipId!)}>
                            <LocateFixed className="size-3.5" />
                        </button> : null}
                    </div>
                ))}
                {orphans.map((clip) => <div key={`orphan:${clip.id}`} className="flex items-start gap-2 border-b border-[var(--director-sequencer-border)] px-3 py-2.5">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--director-warning)]" />
                    <div className="min-w-0 flex-1 break-words"><div>{clip.title || "历史片段"}</div><p className="mt-1 text-[11px]">来源镜头已删除，已有片段待处理</p></div>
                    <button type="button" title="定位缺失来源片段" aria-label={`定位 ${clip.title || "历史片段"}`} onClick={() => locateClip(clip.id)} className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-[var(--director-control-hover)]"><LocateFixed className="size-3.5" /></button>
                </div>)}
                <div className="border-t border-[var(--director-sequencer-border)]">
                    <div className="flex items-center gap-2 px-3 py-2">
                        <Music2 className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 font-medium text-[var(--director-dock-fg-strong)]">配音与声音</span>
                        <span className="text-[10px] opacity-60">可追加 {voicePlan?.count ?? 0} · 待处理 {voiceBlockedCount}</span>
                    </div>
                    {voicePlan?.rows.map((row, index) => (
                        <div key={`${row.shot.id}:${row.artifact?.id || index}`} className="flex items-start gap-2 border-t border-[var(--director-sequencer-border)] px-3 py-2.5">
                            <span className="pt-0.5 text-[var(--director-dock-fg)]/60">{index + 1}</span>
                            <div className="min-w-0 flex-1">
                                <div className="break-words font-medium text-[var(--director-dock-fg-strong)]">{row.timing?.dialogueId ? `对白 ${row.timing.dialogueId}` : `${row.shot.title} 配音`}</div>
                                <div className="mt-1 flex items-start gap-1 text-[11px]">
                                    {row.status === "added" ? <Check className="mt-0.5 size-3 shrink-0 text-[var(--director-success)]" /> : row.status === "ready" ? <Music2 className="mt-0.5 size-3 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3 shrink-0 text-[var(--director-warning)]" />}
                                    <span className="break-words">{row.reason}{row.durationMs ? ` · ${(row.durationMs / 1000).toFixed(2)} 秒` : ""}</span>
                                </div>
                                {row.artifact ? <div className="mt-1 text-[10px] opacity-60">采用音频 v{row.artifact.version}{row.timing?.dialogueId ? ` · ${row.timing.dialogueId}` : ""}</div> : null}
                            </div>
                            {row.clipId ? <button type="button" title="定位已有声音片段" aria-label={`定位 ${row.shot.title} 已有声音片段`} className="grid size-7 shrink-0 place-items-center rounded-md hover:bg-[var(--director-control-hover)]" onClick={() => locateClip(row.clipId!)}><LocateFixed className="size-3.5" /></button> : null}
                        </div>
                    ))}
                    {!voicePlan?.rows.length ? <p className="px-3 py-2 text-[11px] opacity-60">当前集没有采用音频产物。</p> : null}
                </div>
            </div>
            <div className="shrink-0 space-y-2 border-t border-[var(--director-sequencer-border)] p-3">
                {plan?.count ? <p className="text-[11px]">追加位置 {formatTimelineTime(plan.startMs)} · 合计 {formatTimelineTime(plan.durationMs)}</p> : null}
                {error || planResult.error || voicePlanResult.error ? <p role="alert" className="break-words text-[var(--director-danger)]">{error || planResult.error || voicePlanResult.error}</p> : null}
                {note ? <p role="status" className="break-words">{note}</p> : null}
                <button type="button" disabled={busy || inPreview || !plan?.count} onClick={() => void refresh({ kind: "append" })}
                    className="flex min-h-8 w-full items-center justify-center gap-2 rounded-md bg-[var(--director-control-hover)] px-2 py-1.5 text-[var(--director-dock-fg-strong)] disabled:opacity-40">
                    <ListVideo className="size-4 shrink-0" />
                    <span>追加 {plan?.count ?? 0} 个可用镜头</span>
                </button>
                <button type="button" disabled={busy || inPreview || !voicePlan?.count} onClick={() => void refresh({ kind: "appendVoice" })}
                    className="flex min-h-8 w-full items-center justify-center gap-2 rounded-md border border-[var(--director-sequencer-border)] px-2 py-1.5 text-[var(--director-dock-fg-strong)] disabled:opacity-40">
                    <Music2 className="size-4 shrink-0" />
                    <span>按镜头区间追加 {voicePlan?.count ?? 0} 段声音</span>
                </button>
            </div>
        </section>
    );
}
