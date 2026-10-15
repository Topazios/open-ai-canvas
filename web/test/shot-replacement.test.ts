import { describe, expect, test } from "bun:test";
import { planShotAssembly, type ShotAssemblyInput } from "../src/lib/timeline/shot-assembly";
import { orphanedShotClips, planShotReplacement } from "../src/lib/timeline/shot-replacement";
import { createEditorCommandRegistry, type ReplaceShotMediaPayload } from "../src/lib/timeline/editor-commands";
import { normalizeTimelineProject } from "../src/lib/timeline/timeline-tracks";
import { createEditorStore } from "../src/stores/editor/editor-store";
import { buildLocalDeliveryRecord, canVerifyLocalDelivery, timelineFingerprint } from "../src/services/short-drama-delivery-store";
import type { TimelineProject } from "../src/types/timeline";

function fixture() {
    const input: ShotAssemblyInput = {
        projectId: "p", unitId: "u",
        shots: [{ id: "shot", projectId: "p", unitId: "u", currentRevisionId: "revision", title: "Scene", description: "", position: 0, durationMs: 10000, status: "ready", createdAt: "", updatedAt: "" }],
        artifacts: [{ id: "old", projectId: "p", unitId: "u", shotId: "shot", revisionId: "revision", type: "video", selected: true, status: "ready", version: 1, resourceId: "old-video", metadataJson: "{}", createdAt: "", updatedAt: "" }],
        media: { "old-video": { durationMs: 8000 }, "new-video": { durationMs: 10000 } },
        timeline: normalizeTimelineProject(null),
    };
    const store = createEditorStore();
    store.getState().load(input.timeline);
    store.getState().dispatchBatch(planShotAssembly(input).commands);
    const id = store.getState().project!.clips[0].id;
    store.getState().dispatch({ op: "splitClip", payload: { id, splitAtMs: 3000 } });
    const secondId = store.getState().project!.clips[1].id;
    store.getState().dispatchBatch([
        { op: "trimClip", payload: { id, durationMs: 2000, sourceStartMs: 500 } },
        { op: "moveClip", payload: { id, startMs: 600 } },
        { op: "trimClip", payload: { id: secondId, durationMs: 4000 } },
        { op: "setClipProperty", payload: { id: secondId, patch: { title: "Manual title", volume: 0.25, fadeInMs: 200, fadeOutMs: 300 } } },
        { op: "addClip", payload: { clip: { id: "music", kind: "audio", nodeId: "music-node", trackId: "audio-1", startMs: 0, durationMs: 9000, volume: 0.5 } } },
    ]);
    input.timeline = store.getState().project!;
    input.artifacts = [{ ...input.artifacts[0], selected: false }, { ...input.artifacts[0], id: "new", version: 2, resourceId: "new-video" }];
    return { input, store, id, secondId };
}

describe("shot media replacement", () => {
    test("replaces the full split group, preserving clip order, cuts, names, audio and unaffected objects", () => {
        const { input, store } = fixture();
        const plan = planShotReplacement(input, "shot");
        expect(plan.blockers).toEqual([]);
        expect(plan.clips).toHaveLength(2);
        expect(plan.commands).toHaveLength(1);
        const before = input.timeline;
        expect(store.getState().dispatchBatch(plan.commands, before)).toBe(true);
        const after = store.getState().project!;
        expect(after.durationMs).toBe(before.durationMs);
        expect(after.clips.map((clip) => clip.id)).toEqual(before.clips.map((clip) => clip.id));
        for (let index = 0; index < 2; index += 1) {
            const { directMedia, shotSource, sourceDurationMs, nodeId, ...kept } = after.clips[index];
            const { directMedia: _media, shotSource: _source, sourceDurationMs: _duration, nodeId: _node, ...expected } = before.clips[index];
            expect(kept).toEqual(expected);
            expect(directMedia?.storageKey).toBe("resource:new-video");
            expect(directMedia?.durationMs).toBe(10000);
            expect(shotSource?.artifactId).toBe("new");
            expect(sourceDurationMs).toBe(10000);
            expect(nodeId).not.toBe(before.clips[index].nodeId);
        }
        expect(after.clips[0].nodeId).toBe(after.clips[1].nodeId);
        expect(after.clips[2]).toBe(before.clips[2]);
        expect(after.tracks).toBe(before.tracks);
        expect(planShotAssembly({ ...input, timeline: after }).count).toBe(0);
    });

    test("one undo restores all old sources, and redo/restoration retains new sources and cuts", async () => {
        const { input } = fixture();
        const saved: TimelineProject[] = [];
        const store = createEditorStore({ saveTimeline: async (project) => { saved.push(project); } });
        store.getState().load(input.timeline);
        const plan = planShotReplacement(input, "shot");
        store.getState().dispatchBatch(plan.commands, input.timeline);
        const after = store.getState().project!;
        expect(store.getState().history?.undoStack).toHaveLength(1);
        store.getState().undo();
        expect(store.getState().project).toBe(input.timeline);
        store.getState().redo();
        expect(store.getState().project).toBe(after);
        await store.getState().flushSave();
        const restored = normalizeTimelineProject(JSON.parse(JSON.stringify(saved[0])));
        expect(restored.clips).toEqual(after.clips);
        expect(planShotReplacement({ ...input, timeline: restored }, "shot").commands).toHaveLength(0);
    });

    test("a source shorter than any retained source interval refuses the entire replacement", () => {
        const { input, store } = fixture();
        const valid = planShotReplacement(input, "shot");
        input.media["new-video"].durationMs = 6000;
        const short = planShotReplacement(input, "shot");
        expect(short.commands).toHaveLength(0);
        expect(short.blockers.join(" ")).toContain("7.00 秒");
        expect(short.blockers.join(" ")).toContain("6.00 秒");
        const command = structuredClone(valid.commands[0]);
        (command.payload as ReplaceShotMediaPayload).durationMs = 6000;
        expect(store.getState().dispatchBatch([command])).toBe(false);
        expect(store.getState().project).toBe(input.timeline);
        expect(store.getState().saveError).toContain("过短");
    });

    test("an exactly long enough replacement is allowed without stretching", () => {
        const { input, store } = fixture();
        input.media["new-video"].durationMs = 7000;
        const plan = planShotReplacement(input, "shot");
        expect(plan.blockers).toEqual([]);
        store.getState().dispatchBatch(plan.commands);
        expect(store.getState().project!.clips.map((clip) => clip.durationMs)).toEqual(input.timeline.clips.map((clip) => clip.durationMs));
    });

    test("locked tracks prevent a replacement even when the preview was prepared before the lock", () => {
        const { input, store } = fixture();
        const plan = planShotReplacement(input, "shot");
        store.getState().load({ ...input.timeline, tracks: input.timeline.tracks.map((track) => track.kind === "video" ? { ...track, locked: true } : track) });
        expect(store.getState().dispatchBatch(plan.commands)).toBe(false);
        expect(store.getState().saveError).toContain("锁定");
        expect(planShotReplacement({ ...input, timeline: store.getState().project! }, "shot").commands).toHaveLength(0);
    });

    test("restoring a saved timeline preserves default-track locks, visibility, mute and ordering", () => {
        const { input } = fixture();
        const timeline = { ...input.timeline, tracks: input.timeline.tracks.map((track) => track.kind === "video"
            ? { ...track, locked: true, visible: false, label: "Main picture", order: 5 }
            : track.kind === "audio" ? { ...track, muted: true } : track) };
        const restored = normalizeTimelineProject(JSON.parse(JSON.stringify(timeline)));
        expect(restored.tracks).toEqual(timeline.tracks);
        expect(planShotReplacement({ ...input, timeline: restored }, "shot").blockers.join(" ")).toContain("锁定");
    });

    test("edits after preview reject the expected clip snapshot without losing the new edit", () => {
        const { input, store, id } = fixture();
        const plan = planShotReplacement(input, "shot");
        store.getState().dispatch({ op: "moveClip", payload: { id, startMs: 2000 } });
        const moved = store.getState().project;
        expect(store.getState().dispatchBatch(plan.commands)).toBe(false);
        expect(store.getState().project).toBe(moved);
        expect(store.getState().saveError).toContain("已编辑");
    });

    test("removing or splitting a clip after preview rejects the whole old range", () => {
        for (const op of ["removeClip", "splitClip"]) {
            const { input, store, id } = fixture();
            const plan = planShotReplacement(input, "shot");
            store.getState().dispatch({ op, payload: { id, splitAtMs: 1600 } });
            const edited = store.getState().project;
            expect(store.getState().dispatchBatch(plan.commands)).toBe(false);
            expect(store.getState().project).toBe(edited);
            expect(store.getState().saveError).toContain("范围已变化");
        }
    });

    test("stale, unready or nonunique selected candidates never produce replacement commands", () => {
        for (const change of [
            (input: ShotAssemblyInput) => { input.artifacts[1].revisionId = "old-revision"; },
            (input: ShotAssemblyInput) => { input.artifacts[1].status = "stale"; },
            (input: ShotAssemblyInput) => { input.artifacts[1].status = "running"; },
            (input: ShotAssemblyInput) => { input.artifacts[0].selected = true; },
            (input: ShotAssemblyInput) => { input.artifacts[1].selected = false; },
        ]) {
            const { input } = fixture(); change(input);
            expect(planShotReplacement(input, "shot").commands).toHaveLength(0);
        }
    });

    test("source identity changes invalidate the confirmation signature", () => {
        const { input } = fixture();
        const before = planShotReplacement(input, "shot");
        input.artifacts[1].id = "another-adopted-version";
        expect(planShotReplacement(input, "shot").signature).not.toBe(before.signature);
    });

    test("a new shot revision can replace an old one only with its matching current selected artifact", () => {
        const { input, store } = fixture();
        input.shots[0].currentRevisionId = "new-revision";
        expect(planShotReplacement(input, "shot").commands).toHaveLength(0);
        input.artifacts[1].revisionId = "new-revision";
        store.getState().dispatchBatch(planShotReplacement(input, "shot").commands);
        expect(store.getState().project!.clips[0].shotSource?.revisionId).toBe("new-revision");
    });

    test("cross-unit or project source replacement is rejected by the command itself", () => {
        for (const field of ["projectId", "unitId", "shotId"] as const) {
            const { input, store } = fixture();
            const command = structuredClone(planShotReplacement(input, "shot").commands[0]);
            (command.payload as ReplaceShotMediaPayload).source[field] = "foreign";
            expect(store.getState().dispatchBatch([command])).toBe(false);
            expect(store.getState().project).toBe(input.timeline);
        }
    });

    test("invalid duration and incomplete source identifiers are rejected before changing any clip", () => {
        const { input } = fixture();
        const original = planShotReplacement(input, "shot").commands[0];
        const registry = createEditorCommandRegistry();
        for (const durationMs of [0, -10, Infinity, NaN, 12000.5, Number.MAX_SAFE_INTEGER + 1]) {
            const command = structuredClone(original);
            (command.payload as ReplaceShotMediaPayload).durationMs = durationMs;
            expect(() => registry.apply(input.timeline, command)).toThrow();
        }
        for (const field of ["projectId", "unitId", "shotId", "revisionId", "artifactId", "resourceId"] as const) {
            const command = structuredClone(original);
            (command.payload as ReplaceShotMediaPayload).source[field] = "";
            expect(() => registry.apply(input.timeline, command)).toThrow("来源不能为空");
        }
    });

    test("manual media conflicting with stored provenance cannot be silently rebound", () => {
        const { input } = fixture();
        input.timeline.clips[0] = { ...input.timeline.clips[0], directMedia: { ...input.timeline.clips[0].directMedia!, storageKey: "resource:manual-other" } };
        const plan = planShotReplacement(input, "shot");
        expect(plan.commands).toHaveLength(0);
        expect(plan.blockers.join(" ")).toContain("来源不一致");
    });

    test("duplicate IDs cannot cause replacement of an unrelated clip", () => {
        const { input } = fixture();
        input.timeline.clips[2] = { ...input.timeline.clips[2], id: input.timeline.clips[0].id };
        expect(planShotReplacement(input, "shot").blockers.join(" ")).toContain("标识重复");
    });

    test("deleting a source shot preserves historical clips and exposes each orphan", () => {
        const { input } = fixture();
        input.shots = [];
        const before = JSON.stringify(input.timeline);
        expect(orphanedShotClips(input)).toHaveLength(2);
        expect(orphanedShotClips({ ...input, unitId: "other" })).toHaveLength(0);
        const plan = planShotReplacement(input, "shot");
        expect(plan.commands).toHaveLength(0);
        expect(plan.blockers.join(" ")).toContain("已删除");
        expect(JSON.stringify(input.timeline)).toBe(before);
    });

    test("replacing media invalidates the old rendered timeline approval", () => {
        const { input, store } = fixture();
        const record = { ...buildLocalDeliveryRecord({ projectId: "p", unitId: "u", timeline: input.timeline, result: { resourceId: "render" } }), reviewStatus: "verified" as const };
        const readiness = { totalShotCount: 1, readyShotCount: 1, staleArtifactCount: 0, currentTimelineFingerprint: timelineFingerprint(input.timeline) };
        expect(canVerifyLocalDelivery(record, readiness)).toBe(true);
        store.getState().dispatchBatch(planShotReplacement(input, "shot").commands);
        expect(canVerifyLocalDelivery(record, { ...readiness, currentTimelineFingerprint: timelineFingerprint(store.getState().project!) })).toBe(false);
    });
});
