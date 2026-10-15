import type { ProjectShot, ShotArtifact } from "@/services/api/projects";
import type { TimelineClip, TimelineProject } from "@/types/timeline";
import { getEditorCommandRegistry, type EditCommand } from "./editor-commands";

export type ShotAssemblyMedia = {
    durationMs?: number;
    error?: string;
};

export type ShotAssemblyInput = {
    projectId: string;
    unitId: string;
    shots: ProjectShot[];
    artifacts: ShotArtifact[];
    media: Record<string, ShotAssemblyMedia>;
    timeline: TimelineProject;
};

export type ShotAssemblyRow = {
    shot: ProjectShot;
    artifact?: ShotArtifact;
    status: "ready" | "blocked" | "added" | "changed";
    reason: string;
    durationMs?: number;
    clipId?: string;
};

export function selectedUnitVideos(input: Pick<ShotAssemblyInput, "projectId" | "unitId" | "shots" | "artifacts">): ShotArtifact[] {
    const ids = new Set(input.shots.filter((s) => s.projectId === input.projectId && s.unitId === input.unitId).map((s) => s.id));
    return input.artifacts.filter((a) => a.projectId === input.projectId && a.unitId === input.unitId && ids.has(a.shotId) && a.type === "video" && a.selected);
}

export function getShotAssemblyRows(input: ShotAssemblyInput): ShotAssemblyRow[] {
    const videos = selectedUnitVideos(input);
    return input.shots
        .filter((shot) => shot.projectId === input.projectId && shot.unitId === input.unitId)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
        .map((shot): ShotAssemblyRow => {
            const selected = videos.filter((a) => a.shotId === shot.id);
            const linked = input.timeline.clips.filter((clip) => clip.shotSource?.projectId === input.projectId && clip.shotSource.unitId === input.unitId && clip.shotSource.shotId === shot.id);
            const block = (reason: string, artifact?: ShotArtifact): ShotAssemblyRow => ({ shot, artifact, status: "blocked", reason, clipId: linked[0]?.id });
            if (selected.length !== 1) return block(selected.length ? "采用视频不唯一，请重新选择" : "尚未采用视频");
            const artifact = selected[0];
            if (!shot.currentRevisionId || artifact.revisionId !== shot.currentRevisionId || artifact.status === "stale") return block("视频来源已过期，需重新采用", artifact);
            if (artifact.status !== "ready" || !artifact.resourceId) return block("采用视频尚未就绪或缺少资源", artifact);
            if (linked.length) {
                const current = linked.every((clip) => clip.shotSource?.artifactId === artifact.id && clip.shotSource.revisionId === artifact.revisionId && clip.shotSource.resourceId === artifact.resourceId);
                return { shot, artifact, status: current ? "added" : "changed", reason: current ? "已入轨" : "采用版本已变更，原剪辑保留，待替换", clipId: linked[0].id };
            }
            // 旧素材库入轨没有镜头来源；只匹配未绑定镜头的真实资源，不误合并不同镜头共用的素材。
            const legacy = input.timeline.clips.find((clip) => !clip.shotSource && clip.kind === "video" && clip.directMedia?.storageKey === `resource:${artifact.resourceId}`);
            if (legacy) return { shot, artifact, status: "added", reason: "相同资源已手工入轨", clipId: legacy.id };
            const media = input.media[artifact.resourceId];
            if (media?.error) return block(media.error, artifact);
            const durationMs = Math.floor(media?.durationMs ?? 0);
            if (!Number.isFinite(durationMs) || durationMs <= 0) return block("媒体时长未确认，请刷新镜头", artifact);
            return { shot, artifact, status: "ready", reason: "可追加", durationMs };
        });
}

export function planShotAssembly(input: ShotAssemblyInput) {
    const rows = getShotAssemblyRows(input);
    const ready = rows.filter((row) => row.status === "ready");
    const commands: EditCommand[] = [];
    let target = input.timeline;
    let track = target.tracks.filter((t) => t.kind === "video" && !t.locked && t.visible !== false).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0];
    if (ready.length && !track) {
        const addTrack: EditCommand = { op: "addTrack", payload: { kind: "video" } };
        target = getEditorCommandRegistry().apply(target, addTrack);
        track = target.tracks.find((t) => !input.timeline.tracks.some((old) => old.id === t.id))!;
        commands.push(addTrack);
    }
    let cursorMs = input.timeline.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
    const startMs = cursorMs;
    for (const row of ready) {
        const artifact = row.artifact!;
        const resourceId = artifact.resourceId!;
        const source = { projectId: input.projectId, unitId: input.unitId, shotId: row.shot.id, revisionId: artifact.revisionId!, artifactId: artifact.id, resourceId };
        const id = `shot:${[input.projectId, input.unitId, row.shot.id, artifact.id].map(encodeURIComponent).join(":")}`;
        if (input.timeline.clips.some((clip) => clip.id === id)) throw new Error("片段标识冲突，请检查已有镜头来源");
        const clip: TimelineClip = {
            id, kind: "video", nodeId: id, trackId: track!.id,
            startMs: cursorMs, durationMs: row.durationMs!, sourceStartMs: 0, sourceDurationMs: row.durationMs,
            title: row.shot.title, shotSource: source,
            directMedia: { id: artifact.id, kind: "video", title: row.shot.title, storageKey: `resource:${resourceId}`, durationMs: row.durationMs },
        };
        commands.push({ op: "addClip", payload: { clip } });
        cursorMs += clip.durationMs;
    }
    // 校验期间若来源、范围、时长或追加位置改变，必须回到列表复核，不静默使用新计划。
    const signature = JSON.stringify({ rows: rows.map(({ shot, artifact, status, durationMs }) => [shot.id, shot.currentRevisionId, artifact?.id, artifact?.resourceId, status, durationMs]), commands });
    return { rows, commands, signature, count: ready.length, startMs, durationMs: cursorMs - startMs };
}
