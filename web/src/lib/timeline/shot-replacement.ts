import type { TimelineClip } from "@/types/timeline";
import { getEditorCommandRegistry, type EditCommand, type ReplaceShotMediaPayload } from "./editor-commands";
import { getShotAssemblyRows, type ShotAssemblyInput } from "./shot-assembly";

export type ShotReplacementPlan = {
    shotId: string;
    title: string;
    version?: number;
    clips: TimelineClip[];
    resourceId?: string;
    durationMs?: number;
    blockers: string[];
    commands: EditCommand[];
    signature: string;
};

export function planShotReplacement(input: ShotAssemblyInput, shotId: string): ShotReplacementPlan {
    const row = getShotAssemblyRows(input).find((item) => item.shot.id === shotId);
    const clips = input.timeline.clips.filter((clip) => clip.shotSource?.projectId === input.projectId && clip.shotSource.unitId === input.unitId && clip.shotSource.shotId === shotId);
    const blockers: string[] = [];
    if (!row) blockers.push("来源镜头已删除或不属于当前集");
    else if (row.status !== "changed") blockers.push(row.status === "added" ? "当前片段已使用此采用版本" : row.reason);
    if (!clips.length) blockers.push("没有可替换的已绑定镜头片段");
    const artifact = row?.artifact;
    const resourceId = artifact?.resourceId;
    const media = resourceId ? input.media[resourceId] : undefined;
    const durationMs = Math.floor(media?.durationMs ?? 0);
    if (media?.error) blockers.push(media.error);
    else if (!Number.isSafeInteger(durationMs) || durationMs <= 0) blockers.push("新素材时长未确认，请刷新镜头");
    for (const clip of clips) {
        const requiredMs = (clip.sourceStartMs ?? 0) + clip.durationMs;
        if (durationMs > 0 && requiredMs > durationMs) blockers.push(`${clip.title || "片段"} 需读取到 ${(requiredMs / 1000).toFixed(2)} 秒，新素材仅 ${(durationMs / 1000).toFixed(2)} 秒；请先裁短片段或采用更长的视频`);
    }
    const commands: EditCommand[] = [];
    if (!blockers.length && artifact?.revisionId && resourceId) {
        const payload: ReplaceShotMediaPayload = {
            expectedClips: clips,
            source: { projectId: input.projectId, unitId: input.unitId, shotId, revisionId: artifact.revisionId, artifactId: artifact.id, resourceId },
            durationMs, title: row!.shot.title,
        };
        const command = { op: "replaceShotMedia", payload };
        try {
            getEditorCommandRegistry().apply(input.timeline, command);
            commands.push(command);
        } catch (cause) {
            blockers.push(cause instanceof Error ? cause.message : "无法替换当前片段");
        }
    }
    return {
        shotId, title: row?.shot.title || clips[0]?.title || "镜头", version: artifact?.version,
        clips, resourceId, durationMs: durationMs > 0 && Number.isFinite(durationMs) ? durationMs : undefined,
        blockers, commands,
        signature: JSON.stringify({ clips, artifact, durationMs, blockers, commands }),
    };
}

export function orphanedShotClips(input: Pick<ShotAssemblyInput, "projectId" | "unitId" | "shots" | "timeline">): TimelineClip[] {
    const ids = new Set(input.shots.filter((shot) => shot.projectId === input.projectId && shot.unitId === input.unitId).map((shot) => shot.id));
    return input.timeline.clips.filter((clip) => clip.shotSource?.projectId === input.projectId && clip.shotSource.unitId === input.unitId && !ids.has(clip.shotSource.shotId));
}
