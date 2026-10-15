import { describe, expect, test } from "bun:test";
import { captureDeliveryIssuePosition, isDeliveryIssuePosition, locateDeliveryIssuePosition, reviewClipsAt } from "../src/lib/timeline/review-position";
import { buildLocalDeliveryRecord } from "../src/services/short-drama-delivery-store";
import type { TimelineProject } from "../src/types/timeline";

const timeline: TimelineProject = {
    version: 2,
    tracks: [{ id: "v", kind: "video", label: "Video", order: 0 }],
    clips: [{ id: "clip", kind: "video", nodeId: "node", trackId: "v", startMs: 1000, durationMs: 3000, sourceStartMs: 500, directMedia: { id: "asset", kind: "video", title: "Shot", storageKey: "resource:video-a" } }],
    durationMs: 4000,
};
const record = (value = timeline, resourceId = "render-a") => buildLocalDeliveryRecord({ projectId: "p", unitId: "u", timeline: value, result: { resourceId, durationMs: value.durationMs } });
const position = captureDeliveryIssuePosition(record(), 2500, "clip");
const edited = (patch: Partial<TimelineProject["clips"][number]>) => ({ ...timeline, clips: [{ ...timeline.clips[0], ...patch }], durationMs: 10000 });

describe("version-bound review positions", () => {
    test("captures source offset from rendered snapshot and locates exact frame", () => {
        expect(position.sourceTimeMs).toBe(2000);
        expect(locateDeliveryIssuePosition(position, record())).toEqual({ timeMs: 2500, remapped: false, clipId: "clip" });
        expect(reviewClipsAt(record(), 4000)).toEqual([]);
    });
    test("rejects invalid, infinite, negative and out-of-duration positions", () => {
        for (const time of [-1, Infinity, NaN, 4001]) expect(() => captureDeliveryIssuePosition(record(), time)).toThrow();
        expect(() => captureDeliveryIssuePosition(record(), 500, "clip")).toThrow();
        expect(() => captureDeliveryIssuePosition(record(), 2500, "missing")).toThrow();
        expect(isDeliveryIssuePosition({ ...position, sourceTimeMs: undefined })).toBe(false);
    });
    test("reordering preserves the exact source frame", () => {
        expect(locateDeliveryIssuePosition(position, record(edited({ startMs: 5000 }), "render-b"))).toEqual({ timeMs: 6500, remapped: true, clipId: "clip" });
    });
    test("trimming remaps using source time rather than the old clip offset", () => {
        expect(locateDeliveryIssuePosition(position, record(edited({ startMs: 5000, sourceStartMs: 1500, durationMs: 1500 }), "render-b"))).toEqual({ timeMs: 5500, remapped: true, clipId: "clip" });
    });
    test("split clips can map to a single matching source range", () => {
        const split = { ...timeline, clips: [
            { ...timeline.clips[0], durationMs: 1000 },
            { ...timeline.clips[0], id: "split", startMs: 6000, sourceStartMs: 1500, durationMs: 2000 },
        ], durationMs: 8000 };
        expect(locateDeliveryIssuePosition(position, record(split, "render-b"))).toEqual({ timeMs: 6500, remapped: true, clipId: "split" });
    });
    test("deleted, clipped-out and replaced sources cannot silently reuse timestamps", () => {
        for (const changed of [
            { ...timeline, clips: [] },
            edited({ sourceStartMs: 2500 }),
            edited({ nodeId: "new-node" }),
            edited({ directMedia: { ...timeline.clips[0].directMedia!, storageKey: "resource:video-b" } }),
        ]) expect(locateDeliveryIssuePosition(position, record(changed, "render-b"))).toHaveProperty("reason");
    });
    test("overlapping copies without the original id are ambiguous", () => {
        const copies = { ...timeline, clips: ["copy-a", "copy-b"].map((id) => ({ ...timeline.clips[0], id })) };
        expect(locateDeliveryIssuePosition(position, record(copies, "render-b"))).toEqual({ reason: "片段来源对应多个位置，需重新定位" });
    });
    test("a bare canvas node id is not proof of unchanged media after re-editing", () => {
        const bare = edited({ directMedia: undefined });
        const point = captureDeliveryIssuePosition(record(bare), 2500, "clip");
        const moved = { ...bare, clips: bare.clips.map((clip) => ({ ...clip, startMs: 3000 })) };
        expect(locateDeliveryIssuePosition(point, record(moved, "render-b"))).toHaveProperty("reason");
    });
    test("hidden clips and muted audio cannot become position targets", () => {
        const hidden = { ...timeline, tracks: timeline.tracks.map((track) => ({ ...track, visible: false })) };
        expect(reviewClipsAt(record(hidden), 2500)).toEqual([]);
        expect(locateDeliveryIssuePosition(position, record(hidden, "render-b"))).toHaveProperty("reason");
        const muted: TimelineProject = { ...timeline, tracks: [{ id: "v", kind: "audio", label: "Audio", order: 0, muted: true }], clips: [{ ...timeline.clips[0], kind: "audio" }] };
        expect(reviewClipsAt(record(muted), 2500)).toEqual([]);
    });
    test("whole-frame timestamps survive identical re-renders but require relocation after edits", () => {
        const frame = captureDeliveryIssuePosition(record(), 2500);
        expect(locateDeliveryIssuePosition(frame, record(timeline, "render-b"))).toHaveProperty("timeMs", 2500);
        expect(locateDeliveryIssuePosition(frame, record(edited({ startMs: 2000 }), "render-b"))).toHaveProperty("reason");
    });
    test("missing legacy snapshots support timestamps only when duration is known", () => {
        const legacy = { resourceId: "old", timelineFingerprint: "opaque-old-value", durationMs: 4000 };
        const point = captureDeliveryIssuePosition(legacy, 2000);
        expect(locateDeliveryIssuePosition(point, legacy)).toHaveProperty("timeMs", 2000);
        expect(locateDeliveryIssuePosition(point, record())).toHaveProperty("reason");
        expect(() => captureDeliveryIssuePosition({ ...legacy, durationMs: undefined }, 0)).toThrow();
    });
});
