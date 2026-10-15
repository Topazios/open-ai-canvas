import type { TimelineClip, TimelineProject } from "@/types/timeline";

export type ReviewRenderSnapshot = { resourceId: string; timelineFingerprint: string; durationMs?: number };
export type DeliveryIssuePosition = {
    resourceId: string;
    timelineFingerprint: string;
    timeMs: number;
    clipId?: string;
    sourceTimeMs?: number;
};

const finiteTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function isDeliveryIssuePosition(value: unknown): value is DeliveryIssuePosition {
    if (!value || typeof value !== "object") return false;
    const position = value as Partial<DeliveryIssuePosition>;
    return typeof position.resourceId === "string" && !!position.resourceId && typeof position.timelineFingerprint === "string" && !!position.timelineFingerprint && finiteTime(position.timeMs)
        && (position.clipId === undefined ? position.sourceTimeMs === undefined : typeof position.clipId === "string" && !!position.clipId && finiteTime(position.sourceTimeMs));
}

// The existing fingerprint contains the exact rendered timeline JSON, not a hash.
// Read that snapshot so a newer saved edit cannot move a note on the old render.
export function renderedReviewTimeline(render: ReviewRenderSnapshot): TimelineProject | null {
    try {
        const value = JSON.parse(render.timelineFingerprint) as TimelineProject;
        if (!value || value.version !== 2 || !finiteTime(value.durationMs) || !Array.isArray(value.tracks) || !Array.isArray(value.clips)) return null;
        if (value.tracks.some((track) => !track || typeof track.id !== "string") || value.clips.some((clip) => !clip || typeof clip.id !== "string" || typeof clip.trackId !== "string" || typeof clip.nodeId !== "string" || !finiteTime(clip.startMs) || !finiteTime(clip.durationMs) || (clip.sourceStartMs !== undefined && !finiteTime(clip.sourceStartMs)))) return null;
        return value;
    } catch { return null; }
}

function reviewDuration(render: ReviewRenderSnapshot) {
    return finiteTime(render.durationMs) && render.durationMs > 0 ? render.durationMs : renderedReviewTimeline(render)?.durationMs ?? 0;
}

function visibleClips(timeline: TimelineProject) {
    return timeline.clips.filter((clip) => timeline.tracks.some((track) => track.id === clip.trackId && track.visible !== false && !(clip.kind === "audio" && track.muted)));
}

export function reviewClipsAt(render: ReviewRenderSnapshot, timeMs: number) {
    const timeline = renderedReviewTimeline(render);
    return timeline ? visibleClips(timeline).filter((clip) => timeMs >= clip.startMs && timeMs < clip.startMs + clip.durationMs) : [];
}

export function captureDeliveryIssuePosition(render: ReviewRenderSnapshot, timeMs: number, clipId?: string): DeliveryIssuePosition {
    if (!render.resourceId || !finiteTime(timeMs) || reviewDuration(render) <= 0 || timeMs > reviewDuration(render)) throw new Error("审片时间点无效或超出成片时长");
    const position: DeliveryIssuePosition = { resourceId: render.resourceId, timelineFingerprint: render.timelineFingerprint, timeMs };
    if (!clipId) return position;
    const matches = reviewClipsAt(render, timeMs).filter((clip) => clip.id === clipId);
    if (matches.length !== 1) throw new Error("所选片段不在此审片时间点，请重新定位");
    return { ...position, clipId, sourceTimeMs: (matches[0].sourceStartMs ?? 0) + timeMs - matches[0].startMs };
}

function sameSource(a: TimelineClip, b: TimelineClip) {
    // Candidate changes, node replacements and edited text require manual re-location.
    const hasSource = Boolean(a.shotSource?.resourceId || a.voiceSource?.resourceId || a.directMedia?.storageKey || a.directMedia?.url || a.directMedia?.dataUrl || ((a.kind === "text" || a.kind === "subtitle") && a.text));
    return hasSource && a.kind === b.kind && a.nodeId === b.nodeId && JSON.stringify(a.shotSource) === JSON.stringify(b.shotSource)
        && JSON.stringify(a.voiceSource) === JSON.stringify(b.voiceSource) && JSON.stringify(a.directMedia) === JSON.stringify(b.directMedia) && a.text === b.text;
}

export function locateDeliveryIssuePosition(position: DeliveryIssuePosition, render: ReviewRenderSnapshot): { timeMs: number; remapped: boolean; clipId?: string } | { reason: string } {
    if (!isDeliveryIssuePosition(position)) return { reason: "时间点记录无效" };
    if (position.timelineFingerprint === render.timelineFingerprint) {
        return position.timeMs <= reviewDuration(render) ? { timeMs: position.timeMs, remapped: false, clipId: position.clipId } : { reason: "时间点超出当前成片时长" };
    }
    if (!position.clipId || position.sourceTimeMs === undefined) return { reason: "原审片版本已变更，此问题未绑定片段，需重新定位" };
    const original = renderedReviewTimeline(position)?.clips.find((clip) => clip.id === position.clipId);
    const current = renderedReviewTimeline(render);
    if (!original || !current) return { reason: "缺少原片段或当前渲染快照，需重新定位" };
    const candidates = visibleClips(current).filter((clip) => sameSource(original, clip)
        && position.sourceTimeMs! >= (clip.sourceStartMs ?? 0) && position.sourceTimeMs! < (clip.sourceStartMs ?? 0) + clip.durationMs);
    const sameId = candidates.filter((clip) => clip.id === position.clipId);
    const matches = sameId.length ? sameId : candidates;
    if (matches.length !== 1) return { reason: matches.length ? "片段来源对应多个位置，需重新定位" : "原片段已删除、裁去或替换素材，需重新定位" };
    const timeMs = matches[0].startMs + position.sourceTimeMs - (matches[0].sourceStartMs ?? 0);
    return timeMs <= reviewDuration(render) ? { timeMs, remapped: true, clipId: matches[0].id } : { reason: "对应片段超出当前成片时长" };
}

export function formatReviewTime(timeMs: number) {
    const ms = Math.max(0, Math.round(timeMs));
    const seconds = Math.floor(ms / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
