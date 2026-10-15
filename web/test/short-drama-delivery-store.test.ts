import { describe, expect, test } from "bun:test";

import { buildLocalDeliveryRecord, canVerifyLocalDelivery, timelineFingerprint, type LocalDeliveryRecord } from "../src/services/short-drama-delivery-store";
import type { TimelineProject } from "../src/types/timeline";

const timeline: TimelineProject = {
    version: 2,
    tracks: [{ id: "video-1", kind: "video", label: "视频 1", order: 0 }],
    clips: [{ id: "clip-1", kind: "video", nodeId: "node-1", trackId: "video-1", startMs: 0, durationMs: 1200, sourceStartMs: 0, sourceDurationMs: 1200 }],
    durationMs: 1200,
};

describe("short drama delivery record", () => {
    test("binds a render result to the exact project, unit and timeline snapshot", () => {
        const record = buildLocalDeliveryRecord({
            projectId: "project-1",
            unitId: "unit-2",
            timeline,
            result: { resourceId: "resource-1", fileName: "episode-2.mp4", durationMs: 1200 },
            now: "2026-10-12T12:00:00.000Z",
        });
        expect(record.projectId).toBe("project-1");
        expect(record.unitId).toBe("unit-2");
        expect(record.resourceId).toBe("resource-1");
        expect(record.reviewStatus).toBe("pending");
        expect(record.timelineFingerprint).toBe(timelineFingerprint(timeline));
    });

    test("a new render keeps history of issues but requires a new review", () => {
        const previous: LocalDeliveryRecord = {
            projectId: "project-1",
            unitId: "unit-1",
            resourceId: "old-resource",
            timelineFingerprint: "old",
            renderedAt: "2026-10-11T12:00:00.000Z",
            updatedAt: "2026-10-11T12:00:00.000Z",
            reviewStatus: "verified",
            issues: [{ id: "issue-1", severity: "major", note: "字幕超出安全区", createdAt: "2026-10-11T12:01:00.000Z" }],
        };
        const record = buildLocalDeliveryRecord({
            projectId: "project-1",
            unitId: "unit-1",
            timeline,
            result: { resourceId: "new-resource" },
            previous,
            now: "2026-10-12T12:00:00.000Z",
        });
        expect(record.resourceId).toBe("new-resource");
        expect(record.reviewStatus).toBe("pending");
        expect(record.issues).toEqual(previous.issues);
    });

    test("review approval requires a non-empty complete shot set with no stale artifacts or open issues", () => {
        const record = buildLocalDeliveryRecord({
            projectId: "project-1",
            unitId: "unit-1",
            timeline,
            result: { resourceId: "resource-1" },
        });
        const currentTimelineFingerprint = timelineFingerprint(timeline);
        expect(canVerifyLocalDelivery(record, { readyShotCount: 0, totalShotCount: 0, staleArtifactCount: 0, currentTimelineFingerprint })).toBe(false);
        expect(canVerifyLocalDelivery(record, { readyShotCount: 1, totalShotCount: 2, staleArtifactCount: 0, currentTimelineFingerprint })).toBe(false);
        expect(canVerifyLocalDelivery(record, { readyShotCount: 2, totalShotCount: 2, staleArtifactCount: 1, currentTimelineFingerprint })).toBe(false);
        expect(canVerifyLocalDelivery(record, { readyShotCount: 2, totalShotCount: 2, staleArtifactCount: 0, currentTimelineFingerprint })).toBe(true);
        expect(canVerifyLocalDelivery({ ...record, issues: [{ id: "issue-1", severity: "blocker", note: "缺字幕", createdAt: "2026-10-12T12:00:00.000Z" }] }, { readyShotCount: 2, totalShotCount: 2, staleArtifactCount: 0, currentTimelineFingerprint })).toBe(false);
    });

    test("timeline edits and missing saved timelines cannot reuse an approval", () => {
        const record = buildLocalDeliveryRecord({ projectId: "p", unitId: "u", timeline, result: { resourceId: "r" } });
        const input = { readyShotCount: 1, totalShotCount: 1, staleArtifactCount: 0 };
        expect(canVerifyLocalDelivery(record, { ...input, currentTimelineFingerprint: null })).toBe(false);
        for (const changed of [
            { ...timeline, clips: timeline.clips.map((clip) => ({ ...clip, startMs: 100 })) },
            { ...timeline, clips: timeline.clips.map((clip) => ({ ...clip, volume: 0.5 })) },
            { ...timeline, clips: [...timeline.clips, { ...timeline.clips[0], id: "subtitle", kind: "subtitle" as const, text: "Revised dialogue" }] },
            { ...timeline, tracks: timeline.tracks.map((track) => ({ ...track, visible: false })) },
        ]) {
            expect(canVerifyLocalDelivery(record, { ...input, currentTimelineFingerprint: timelineFingerprint(changed) })).toBe(false);
        }
        expect(canVerifyLocalDelivery(record, { ...input, currentTimelineFingerprint: timelineFingerprint({ ...timeline, updatedAt: "2030-01-01" }) })).toBe(true);
    });

    test("an upstream shot dependency change invalidates an otherwise unchanged timeline approval", () => {
        const record = buildLocalDeliveryRecord({ projectId: "p", unitId: "u", timeline, result: { resourceId: "r" }, shotDependencyFingerprint: "old-source" });
        const base = { readyShotCount: 1, totalShotCount: 1, staleArtifactCount: 0, currentTimelineFingerprint: timelineFingerprint(timeline) };
        expect(canVerifyLocalDelivery(record, { ...base, currentShotDependencyFingerprint: "old-source" })).toBe(true);
        expect(canVerifyLocalDelivery(record, { ...base, currentShotDependencyFingerprint: "new-source" })).toBe(false);
        expect(canVerifyLocalDelivery(record, { ...base, currentShotDependencyFingerprint: null })).toBe(false);
    });

    test("legacy records without a source dependency fingerprint require a new render when current dependencies are supplied", () => {
        const record = buildLocalDeliveryRecord({ projectId: "p", unitId: "u", timeline, result: { resourceId: "r" } });
        expect(canVerifyLocalDelivery(record, { readyShotCount: 1, totalShotCount: 1, staleArtifactCount: 0, currentTimelineFingerprint: timelineFingerprint(timeline), currentShotDependencyFingerprint: "current" })).toBe(false);
    });
});
