import type { ProjectShot, ShotArtifact } from "@/services/api/projects";
import type { TimelineProject } from "@/types/timeline";

export type ShotDependencyInput = {
    projectId: string;
    unitId: string;
    shots: ProjectShot[];
    artifacts: ShotArtifact[];
    timeline: TimelineProject;
};

export type ShotTimelineDependencyReport = {
    ok: boolean;
    blockers: string[];
    currentFingerprint: string;
};

function scopedShots(input: Pick<ShotDependencyInput, "projectId" | "unitId" | "shots">) {
    return input.shots
        .filter((shot) => shot.projectId === input.projectId && shot.unitId === input.unitId)
        .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

function selectedVideos(input: Pick<ShotDependencyInput, "projectId" | "unitId" | "shots" | "artifacts">, shotId: string) {
    return input.artifacts
        .filter((artifact) => artifact.projectId === input.projectId && artifact.unitId === input.unitId && artifact.shotId === shotId && artifact.type === "video" && artifact.selected)
        .sort((a, b) => a.id.localeCompare(b.id));
}

/** 当前集上游镜头/采用视频的稳定快照；不包含时间线位置，专门用于发现上游改选。 */
export function shotDependencyFingerprint(input: Pick<ShotDependencyInput, "projectId" | "unitId" | "shots" | "artifacts">) {
    return JSON.stringify(scopedShots(input).map((shot) => [
        shot.id,
        shot.currentRevisionId || null,
        selectedVideos(input, shot.id).map((artifact) => [artifact.id, artifact.revisionId || null, artifact.resourceId || null, artifact.status, artifact.version]),
    ]));
}

export function assessShotTimelineDependencies(input: ShotDependencyInput): ShotTimelineDependencyReport {
    const shots = scopedShots(input);
    const blockers: string[] = [];
    const shotIds = new Set(shots.map((shot) => shot.id));
    const bound = input.timeline.clips.filter((clip) => clip.kind === "video" && clip.shotSource?.projectId === input.projectId && clip.shotSource.unitId === input.unitId);

    if (shots.length === 0) blockers.push("当前集没有可核对的镜头");
    for (const shot of shots) {
        const candidates = selectedVideos(input, shot.id);
        const clips = bound.filter((clip) => clip.shotSource?.shotId === shot.id);
        if (candidates.length !== 1) {
            blockers.push(`${shot.title || shot.id} 的采用视频不是唯一有效版本`);
            continue;
        }
        const artifact = candidates[0];
        if (artifact.status !== "ready" || !artifact.resourceId || artifact.revisionId !== shot.currentRevisionId) {
            blockers.push(`${shot.title || shot.id} 的采用视频已过期或未就绪`);
            continue;
        }
        if (!clips.length) {
            blockers.push(`${shot.title || shot.id} 尚未进入当前时间线`);
            continue;
        }
        for (const clip of clips) {
            const source = clip.shotSource!;
            if (source.revisionId !== artifact.revisionId || source.artifactId !== artifact.id || source.resourceId !== artifact.resourceId) {
                blockers.push(`${shot.title || shot.id} 已改选视频，但时间线仍引用旧版本`);
            }
        }
    }
    for (const clip of bound) {
        if (!shotIds.has(clip.shotSource!.shotId)) blockers.push(`${clip.title || "历史片段"} 的来源镜头已删除`);
    }
    return { ok: blockers.length === 0, blockers: [...new Set(blockers)], currentFingerprint: shotDependencyFingerprint(input) };
}
