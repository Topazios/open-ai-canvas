import { describe, expect, test } from "bun:test";

import { normalizeTimelineProject } from "../src/lib/timeline/timeline-tracks";
import { getVoiceAssemblyRows, parseVoiceTiming, planVoiceAssembly, type VoiceAssemblyInput } from "../src/lib/timeline/voice-assembly";
import type { ProjectShot, ShotArtifact } from "../src/services/api/projects";

function shot(id = "shot-1"): ProjectShot {
    return { id, projectId: "p", unitId: "u", currentRevisionId: `rev-${id}`, title: id, description: "", position: 0, durationMs: 8_000, status: "ready", createdAt: "", updatedAt: "" };
}

function videoArtifact(id = "video-1"): ShotArtifact {
    return { id, projectId: "p", unitId: "u", shotId: "shot-1", revisionId: "rev-shot-1", type: "video", version: 1, resourceId: "video-resource", status: "ready", selected: true, metadataJson: "{}", createdAt: "", updatedAt: "" };
}

function audioArtifact(metadataJson: string, id = "audio-1"): ShotArtifact {
    return { id, projectId: "p", unitId: "u", shotId: "shot-1", revisionId: "rev-shot-1", type: "audio", version: 1, resourceId: "audio-resource", status: "ready", selected: true, metadataJson, createdAt: "", updatedAt: "" };
}

function fixture(): VoiceAssemblyInput {
    const timeline = normalizeTimelineProject(null);
    timeline.clips.push({ id: "video-clip", kind: "video", nodeId: "video-node", trackId: "video-1", startMs: 5_000, durationMs: 8_000, sourceStartMs: 0, sourceDurationMs: 8_000, shotSource: { projectId: "p", unitId: "u", shotId: "shot-1", revisionId: "rev-shot-1", artifactId: "video-1", resourceId: "video-resource" } });
    return { projectId: "p", unitId: "u", shots: [shot()], artifacts: [videoArtifact(), audioArtifact(JSON.stringify({ dialogueId: "d1", startMs: 1_200, endMs: 2_800 }))], media: { "audio-resource": { durationMs: 4_000 } }, timeline };
}

describe("voice assembly", () => {
    test("parses only explicit dialogue or shot timing", () => {
        expect(parseVoiceTiming(JSON.stringify({ dialogueId: "d1", startMs: 100, endMs: 900 })).timing).toEqual({ dialogueId: "d1", shotOffsetMs: 100, durationMs: 800, sourceStartMs: undefined });
        expect(parseVoiceTiming(JSON.stringify({ shotOffsetMs: 300, durationMs: 700 })).timing).toEqual({ shotOffsetMs: 300, durationMs: 700, sourceStartMs: undefined });
        expect(parseVoiceTiming("{}").timing).toBeUndefined();
        expect(parseVoiceTiming(JSON.stringify({ startMs: 900, endMs: 100 })).reason).toContain("无效");
    });

    test("places audio relative to the actual shot video clip", () => {
        const input = fixture();
        const plan = planVoiceAssembly(input);
        expect(plan.count).toBe(1);
        const clip = (plan.commands[0].payload as { clip: { startMs: number; durationMs: number; voiceSource?: unknown; directMedia?: { storageKey?: string } } }).clip;
        expect(clip.startMs).toBe(6_200);
        expect(clip.durationMs).toBe(1_600);
        expect(clip.directMedia?.storageKey).toBe("resource:audio-resource");
        expect(clip.voiceSource).toBeTruthy();
    });

    test("does not guess when timing, source version, video anchor or duration is missing", () => {
        for (const change of [
            (input: VoiceAssemblyInput) => { input.artifacts[1].metadataJson = "{}"; },
            (input: VoiceAssemblyInput) => { input.artifacts[1].revisionId = "old"; },
            (input: VoiceAssemblyInput) => { input.timeline.clips = []; },
            (input: VoiceAssemblyInput) => { input.media["audio-resource"] = { error: "音频不存在" }; },
        ]) {
            const input = fixture();
            change(input);
            expect(planVoiceAssembly(input).commands).toEqual([]);
            expect(getVoiceAssemblyRows(input).every((row) => row.status === "blocked")).toBe(true);
        }
    });

    test("blocks audio when its media duration has not been confirmed", () => {
        const input = fixture();
        input.media["audio-resource"] = {};
        const plan = planVoiceAssembly(input);
        expect(plan.commands).toEqual([]);
        expect(plan.rows[0].status).toBe("blocked");
        expect(plan.rows[0].reason).toContain("时长未确认");
    });

    test("rejects source range beyond media and ranges crossing a video edit boundary", () => {
        const overlong = fixture();
        overlong.artifacts[1].metadataJson = JSON.stringify({ startMs: 1_000, endMs: 4_500, sourceStartMs: 1_000 });
        expect(planVoiceAssembly(overlong).commands).toEqual([]);
        const split = fixture();
        split.timeline.clips[0].durationMs = 2_000;
        split.timeline.clips.push({ ...split.timeline.clips[0], id: "video-clip-2", startMs: 8_000, sourceStartMs: 4_000, durationMs: 4_000 });
        split.artifacts[1].metadataJson = JSON.stringify({ startMs: 1_500, endMs: 4_500 });
        expect(getVoiceAssemblyRows(split)[0].reason).toContain("断点");
    });

    test("same artifact is idempotent and a changed interval stays visible for review", () => {
        const input = fixture();
        const first = planVoiceAssembly(input);
        input.timeline.clips.push((first.commands[0].payload as { clip: any }).clip);
        expect(planVoiceAssembly(input).commands).toEqual([]);
        input.artifacts[1].metadataJson = JSON.stringify({ dialogueId: "d1", startMs: 1_400, endMs: 2_800 });
        expect(planVoiceAssembly(input).commands).toEqual([]);
        expect(getVoiceAssemblyRows(input)[0].status).toBe("changed");
    });
});
