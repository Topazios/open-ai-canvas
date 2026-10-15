import type { ProjectShot, ShotArtifact } from "@/services/api/projects";
import type { TimelineClip, TimelineProject } from "@/types/timeline";
import { getEditorCommandRegistry, type EditCommand } from "./editor-commands";

export type VoiceAssemblyMedia = {
    durationMs?: number;
    error?: string;
};

export type VoiceTiming = {
    dialogueId?: string;
    shotOffsetMs: number;
    durationMs: number;
    sourceStartMs?: number;
};

export type VoiceAssemblyInput = {
    projectId: string;
    unitId: string;
    shots: ProjectShot[];
    artifacts: ShotArtifact[];
    media: Record<string, VoiceAssemblyMedia>;
    timeline: TimelineProject;
};

export type VoiceAssemblyRow = {
    shot: ProjectShot;
    artifact?: ShotArtifact;
    timing?: VoiceTiming;
    status: "ready" | "blocked" | "added" | "changed";
    reason: string;
    durationMs?: number;
    clipId?: string;
};

function finiteMs(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
    return Math.round(value);
}

function metadataObject(raw: string): Record<string, unknown> | null {
    if (!raw.trim()) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * 只解析明确的镜头内区间：
 * - dialogueId + startMs/endMs；或
 * - shotOffsetMs + durationMs。
 * 没有区间时返回原因，调用方不得用镜头预计时长替代。
 */
export function parseVoiceTiming(metadataJson: string): { timing?: VoiceTiming; reason?: string } {
    const metadata = metadataObject(metadataJson);
    if (!metadata) return { reason: "音频产物缺少有效 metadataJson" };
    const dialogueId = typeof metadata.dialogueId === "string" && metadata.dialogueId.trim() ? metadata.dialogueId.trim() : undefined;
    const startMs = finiteMs(metadata.startMs);
    const endMs = finiteMs(metadata.endMs);
    if (startMs !== undefined || endMs !== undefined) {
        if (startMs === undefined || endMs === undefined || endMs <= startMs) return { reason: "音频对白区间无效" };
        const sourceStartMs = finiteMs(metadata.sourceStartMs);
        return { timing: { dialogueId, shotOffsetMs: startMs, durationMs: endMs - startMs, sourceStartMs } };
    }
    const shotOffsetMs = finiteMs(metadata.shotOffsetMs);
    const durationMs = finiteMs(metadata.durationMs);
    if (shotOffsetMs === undefined || durationMs === undefined || durationMs <= 0) return { reason: "音频产物未声明对白/镜头内时间区间" };
    const sourceStartMs = finiteMs(metadata.sourceStartMs);
    return { timing: { dialogueId, shotOffsetMs, durationMs, sourceStartMs } };
}

function scopedShots(input: Pick<VoiceAssemblyInput, "projectId" | "unitId" | "shots">) {
    return input.shots
        .filter((shot) => shot.projectId === input.projectId && shot.unitId === input.unitId)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

function selectedAudio(input: Pick<VoiceAssemblyInput, "projectId" | "unitId" | "artifacts">, shotId: string) {
    return input.artifacts
        .filter((artifact) => artifact.projectId === input.projectId && artifact.unitId === input.unitId && artifact.shotId === shotId && artifact.type === "audio" && artifact.selected)
        .sort((a, b) => a.id.localeCompare(b.id));
}

function videoAnchors(timeline: TimelineProject, projectId: string, unitId: string, shotId: string, revisionId: string) {
    return timeline.clips
        .filter((clip) => clip.kind === "video" && clip.shotSource?.projectId === projectId && clip.shotSource.unitId === unitId && clip.shotSource.shotId === shotId && clip.shotSource.revisionId === revisionId)
        .sort((a, b) => (a.sourceStartMs ?? 0) - (b.sourceStartMs ?? 0) || a.startMs - b.startMs || a.id.localeCompare(b.id));
}

function locateShotRange(anchors: TimelineClip[], timing: VoiceTiming): { startMs: number } | { reason: string } {
    const rangeEnd = timing.shotOffsetMs + timing.durationMs;
    const containing = anchors.find((clip) => {
        const sourceStart = clip.sourceStartMs ?? 0;
        return timing.shotOffsetMs >= sourceStart && rangeEnd <= sourceStart + clip.durationMs;
    });
    if (containing) return { startMs: containing.startMs + timing.shotOffsetMs - (containing.sourceStartMs ?? 0) };
    const covered = anchors.some((clip) => {
        const sourceStart = clip.sourceStartMs ?? 0;
        const sourceEnd = sourceStart + clip.durationMs;
        return timing.shotOffsetMs < sourceEnd && rangeEnd > sourceStart;
    });
    return { reason: covered ? "音频区间跨越视频剪辑断点，请手动定位" : "音频区间超出当前镜头视频范围" };
}

function existingVoiceClips(input: VoiceAssemblyInput, artifactId: string) {
    return input.timeline.clips.filter((clip) => clip.kind === "audio" && clip.voiceSource?.artifactId === artifactId && clip.voiceSource.projectId === input.projectId && clip.voiceSource.unitId === input.unitId);
}

export function getVoiceAssemblyRows(input: VoiceAssemblyInput): VoiceAssemblyRow[] {
    return scopedShots(input).flatMap((shot) => {
        const artifacts = selectedAudio(input, shot.id);
        if (!artifacts.length) return [{ shot, status: "blocked", reason: "尚未采用配音或声音产物" } satisfies VoiceAssemblyRow];
        const dialogueIds = new Set<string>();
        return artifacts.map((artifact): VoiceAssemblyRow => {
            const block = (reason: string, timing?: VoiceTiming): VoiceAssemblyRow => ({ shot, artifact, timing, status: "blocked", reason, clipId: existingVoiceClips(input, artifact.id)[0]?.id });
            if (!shot.currentRevisionId || artifact.revisionId !== shot.currentRevisionId) return block("音频来源版本已过期，需重新采用");
            if (artifact.status !== "ready" || !artifact.resourceId) return block("采用音频尚未就绪或缺少资源");
            const parsed = parseVoiceTiming(artifact.metadataJson);
            if (!parsed.timing) return block(parsed.reason || "音频区间不可用");
            if (parsed.timing.dialogueId) {
                if (dialogueIds.has(parsed.timing.dialogueId)) return block("同一对白存在多个采用音频，无法自动入轨", parsed.timing);
                dialogueIds.add(parsed.timing.dialogueId);
            }
            const media = input.media[artifact.resourceId];
            if (media?.error) return block(media.error, parsed.timing);
            if (!media || media.durationMs === undefined) return block("音频媒体时长未确认，请刷新声音素材", parsed.timing);
            if (!Number.isFinite(media.durationMs) || media.durationMs <= 0) return block("音频媒体时长无效", parsed.timing);
            const sourceStartMs = parsed.timing.sourceStartMs ?? 0;
            if (media?.durationMs !== undefined && sourceStartMs + parsed.timing.durationMs > media.durationMs) return block("音频区间超过源文件时长", parsed.timing);
            const anchors = videoAnchors(input.timeline, input.projectId, input.unitId, shot.id, shot.currentRevisionId);
            if (!anchors.length) return block("请先将对应镜头视频入轨，再按镜头区间追加声音", parsed.timing);
            const placement = locateShotRange(anchors, parsed.timing);
            if ("reason" in placement) return block(placement.reason, parsed.timing);
            const existing = existingVoiceClips(input, artifact.id);
            if (existing.length) {
                const same = existing.length === 1 && existing[0].startMs === placement.startMs && existing[0].durationMs === parsed.timing.durationMs && existing[0].voiceSource?.shotOffsetMs === parsed.timing.shotOffsetMs && existing[0].voiceSource?.sourceStartMs === parsed.timing.sourceStartMs;
                return { shot, artifact, timing: parsed.timing, status: same ? "added" : "changed", reason: same ? "已入轨" : "采用音频区间已变化，原片段保留，待重新检查", clipId: existing[0].id, durationMs: parsed.timing.durationMs };
            }
            return { shot, artifact, timing: parsed.timing, status: "ready", reason: "可按镜头区间追加", durationMs: parsed.timing.durationMs };
        });
    });
}

export function planVoiceAssembly(input: VoiceAssemblyInput) {
    const rows = getVoiceAssemblyRows(input);
    const ready = rows.filter((row) => row.status === "ready");
    const commands: EditCommand[] = [];
    let target = input.timeline;
    let track = target.tracks.filter((item) => item.kind === "audio" && !item.locked && item.visible !== false).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0];
    if (ready.length && !track) {
        const addTrack: EditCommand = { op: "addTrack", payload: { kind: "audio" } };
        target = getEditorCommandRegistry().apply(target, addTrack);
        track = target.tracks.find((item) => !input.timeline.tracks.some((old) => old.id === item.id))!;
        commands.push(addTrack);
    }
    for (const row of ready) {
        const artifact = row.artifact!;
        const timing = row.timing!;
        const source = { projectId: input.projectId, unitId: input.unitId, shotId: row.shot.id, revisionId: artifact.revisionId!, artifactId: artifact.id, resourceId: artifact.resourceId!, dialogueId: timing.dialogueId, shotOffsetMs: timing.shotOffsetMs, durationMs: timing.durationMs, sourceStartMs: timing.sourceStartMs };
        const id = `voice:${[input.projectId, input.unitId, row.shot.id, artifact.id].map(encodeURIComponent).join(":")}`;
        const media = input.media[artifact.resourceId!];
        const placement = locateShotRange(videoAnchors(input.timeline, input.projectId, input.unitId, row.shot.id, row.shot.currentRevisionId!), timing);
        if ("reason" in placement) throw new Error(placement.reason);
        const clip: TimelineClip = {
            id,
            kind: "audio",
            nodeId: id,
            trackId: track!.id,
            startMs: placement.startMs,
            durationMs: timing.durationMs,
            title: timing.dialogueId ? `对白 ${timing.dialogueId}` : `${row.shot.title} 配音`,
            sourceStartMs: timing.sourceStartMs ?? 0,
            sourceDurationMs: media?.durationMs,
            volume: 1,
            fadeInMs: 0,
            fadeOutMs: 0,
            voiceSource: source,
            directMedia: { id: artifact.id, kind: "audio", title: row.shot.title, storageKey: `resource:${artifact.resourceId}`, durationMs: media?.durationMs },
        };
        commands.push({ op: "addClip", payload: { clip } });
    }
    const signature = JSON.stringify({ rows: rows.map(({ shot, artifact, timing, status, durationMs, clipId }) => [shot.id, shot.currentRevisionId, artifact?.id, artifact?.revisionId, artifact?.resourceId, timing, status, durationMs, clipId]), commands });
    return { rows, commands, signature, count: ready.length };
}
