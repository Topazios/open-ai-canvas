import { describe, expect, test } from "bun:test";
import { getShotAssemblyRows, planShotAssembly, type ShotAssemblyInput } from "../src/lib/timeline/shot-assembly";
import { normalizeTimelineProject } from "../src/lib/timeline/timeline-tracks";
import { createEditorStore } from "../src/stores/editor/editor-store";
import type { ProjectShot, ShotArtifact } from "../src/services/api/projects";
import type { TimelineProject } from "../src/types/timeline";

function shot(id: string, position = 0, unitId = "u"): ProjectShot {
    return { id, projectId: "p", unitId, currentRevisionId: `rev-${id}`, title: id, description: "", position, durationMs: 10000, status: "ready", createdAt: "", updatedAt: "" };
}

function artifact(id: string, unitId = "u"): ShotArtifact {
    return { id: `artifact-${id}`, projectId: "p", unitId, shotId: id, revisionId: `rev-${id}`, type: "video", version: 1, resourceId: `resource-${id}`, status: "ready", selected: true, metadataJson: "{}", createdAt: "", updatedAt: "" };
}

function fixture(): ShotAssemblyInput {
    return {
        projectId: "p", unitId: "u",
        shots: [shot("second", 2), shot("first", 1)], artifacts: [artifact("second"), artifact("first")],
        media: { "resource-first": { durationMs: 4000 }, "resource-second": { durationMs: 6500 } },
        timeline: normalizeTimelineProject(null),
    };
}

describe("current episode shot assembly", () => {
    test("uses shot order and real media duration, commits and saves as one undo step", async () => {
        const input = fixture();
        const plan = planShotAssembly(input);
        const saves: TimelineProject[] = [];
        const store = createEditorStore({ saveTimeline: async (timeline) => { saves.push(timeline); } });
        store.getState().load(input.timeline);
        expect(plan.count).toBe(2);
        expect(store.getState().dispatchBatch(plan.commands, input.timeline)).toBe(true);
        const assembled = store.getState().project!;
        expect(assembled.clips.map((c) => [c.title, c.startMs, c.durationMs, c.sourceDurationMs])).toEqual([["first", 0, 4000, 4000], ["second", 4000, 6500, 6500]]);
        expect(assembled.clips[0].directMedia?.storageKey).toBe("resource:resource-first");
        expect(store.getState().history?.undoStack).toHaveLength(1);
        await store.getState().flushSave();
        expect(saves).toHaveLength(1);
        store.getState().undo();
        expect(store.getState().project).toEqual(input.timeline);
        store.getState().redo();
        expect(store.getState().project).toEqual(assembled);
        await store.getState().flushSave();
        const restored = normalizeTimelineProject(JSON.parse(JSON.stringify(saves.at(-1))));
        expect(planShotAssembly({ ...input, timeline: restored }).commands).toHaveLength(0);
    });

    test("appends after the entire existing edit and preserves manual clips by reference", () => {
        const input = fixture();
        const manual = { id: "manual", nodeId: "m", kind: "audio" as const, trackId: "audio-1", startMs: 6000, durationMs: 2000, volume: 0.3 };
        input.timeline.clips.push(manual);
        const store = createEditorStore();
        store.getState().load(input.timeline);
        const plan = planShotAssembly(input);
        expect(plan.startMs).toBe(8000);
        store.getState().dispatchBatch(plan.commands);
        expect(store.getState().project?.clips[0]).toBe(manual);
        expect(store.getState().project?.clips[1].startMs).toBe(8000);
    });

    test("filters other units/projects and audio candidates, including their selected artifacts", () => {
        const input = fixture();
        input.shots.push(shot("other-unit", 0, "other"), { ...shot("other-project"), projectId: "foreign" });
        input.artifacts.push(artifact("other-unit", "other"), { ...artifact("other-project"), projectId: "foreign" }, { ...artifact("first"), id: "audio", type: "audio" });
        expect(planShotAssembly(input).rows.map((r) => r.shot.id)).toEqual(["first", "second"]);
        expect(planShotAssembly(input).count).toBe(2);
    });

    test("missing, unselected, ambiguous, stale and unready videos cannot be assembled", () => {
        for (const change of [
            (input: ShotAssemblyInput) => { input.artifacts = []; },
            (input: ShotAssemblyInput) => { input.artifacts = input.artifacts.map((a) => ({ ...a, selected: false })); },
            (input: ShotAssemblyInput) => { input.artifacts = input.artifacts.flatMap((a) => [a, { ...a, id: `${a.id}-duplicate` }]); },
            (input: ShotAssemblyInput) => { input.artifacts = input.artifacts.map((a) => ({ ...a, revisionId: "old" })); },
            (input: ShotAssemblyInput) => { input.artifacts = input.artifacts.map((a) => ({ ...a, status: "stale" })); },
            (input: ShotAssemblyInput) => { input.artifacts = input.artifacts.map((a) => ({ ...a, status: "running" })); },
            (input: ShotAssemblyInput) => { input.artifacts = input.artifacts.map((a) => ({ ...a, resourceId: undefined })); },
        ]) {
            const input = fixture(); change(input);
            expect(planShotAssembly(input).count).toBe(0);
            expect(getShotAssemblyRows(input).every((r) => r.status === "blocked")).toBe(true);
        }
    });

    test("invalid media duration and resource errors never fall back to planned shot length", () => {
        for (const value of [undefined, 0, -1, NaN, Infinity, 0.5]) {
            const input = fixture();
            input.media = { "resource-first": { durationMs: value }, "resource-second": { error: "Resource missing" } };
            expect(planShotAssembly(input).commands).toHaveLength(0);
        }
    });

    test("split, moved and trimmed shots remain identified and are not added again", () => {
        const input = fixture();
        const store = createEditorStore();
        store.getState().load(input.timeline);
        store.getState().dispatchBatch(planShotAssembly(input).commands);
        const id = store.getState().project!.clips[0].id;
        store.getState().dispatch({ op: "splitClip", payload: { id, splitAtMs: 1500 } });
        store.getState().dispatch({ op: "trimClip", payload: { id, durationMs: 1000 } });
        store.getState().dispatch({ op: "moveClip", payload: { id, startMs: 500 } });
        const edited = store.getState().project!;
        const plan = planShotAssembly({ ...input, timeline: edited });
        expect(plan.commands).toHaveLength(0);
        expect(plan.rows.every((r) => r.status === "added")).toBe(true);
        expect(edited.clips[1].shotSource).toEqual(edited.clips[0].shotSource);
    });

    test("a newly selected artifact reports replacement pending without modifying the cut", () => {
        const input = fixture();
        const store = createEditorStore();
        store.getState().load(input.timeline);
        store.getState().dispatchBatch(planShotAssembly(input).commands);
        const edited = store.getState().project!;
        input.artifacts = input.artifacts.map((a) => ({ ...a, id: `${a.id}-new`, resourceId: "new" }));
        const plan = planShotAssembly({ ...input, timeline: edited });
        expect(plan.commands).toHaveLength(0);
        expect(plan.rows.every((r) => r.status === "changed")).toBe(true);
        expect(store.getState().project).toBe(edited);
    });

    test("legacy manual resource clips are recognized without attaching invented provenance", () => {
        const input = fixture();
        const manual = { id: "legacy", nodeId: "asset:a", kind: "video" as const, trackId: "video-1", startMs: 0, durationMs: 2000, directMedia: { id: "a", kind: "video" as const, title: "manual", storageKey: "resource:resource-first" } };
        input.timeline.clips.push(manual);
        const plan = planShotAssembly(input);
        expect(plan.count).toBe(1);
        expect(plan.rows[0].status).toBe("added");
        expect("shotSource" in manual).toBe(false);
    });

    test("different shots sharing a resource retain separate business identities", () => {
        const input = fixture();
        input.artifacts = input.artifacts.map((a) => ({ ...a, resourceId: "resource-first" }));
        const store = createEditorStore();
        store.getState().load(input.timeline);
        const initial = planShotAssembly({ ...input, shots: [input.shots[0]] });
        store.getState().dispatchBatch(initial.commands);
        expect(planShotAssembly({ ...input, timeline: store.getState().project! }).count).toBe(1);
    });

    test("locked or hidden tracks get a new visible unlocked track in the same transaction", () => {
        const input = fixture();
        input.timeline.tracks[0].locked = true;
        const plan = planShotAssembly(input);
        const store = createEditorStore();
        store.getState().load(input.timeline);
        expect(plan.commands[0].op).toBe("addTrack");
        store.getState().dispatchBatch(plan.commands);
        expect(store.getState().project?.clips.every((c) => c.trackId === "video-2")).toBe(true);
        store.getState().undo();
        expect(store.getState().project?.tracks).toHaveLength(3);
    });

    test("deleted shots and changed media or ordering invalidate a previously displayed plan", () => {
        for (const change of [
            (input: ShotAssemblyInput) => { input.shots = []; },
            (input: ShotAssemblyInput) => { input.artifacts[0].id = "new-candidate"; },
            (input: ShotAssemblyInput) => { input.media["resource-first"].durationMs = 5000; },
            (input: ShotAssemblyInput) => { input.shots[0].position = 0; },
        ]) {
            const input = fixture();
            const signature = planShotAssembly(input).signature;
            change(input);
            expect(planShotAssembly(input).signature).not.toBe(signature);
        }
    });

    test("empty unit remains empty and produces no commands or track creation", () => {
        const input = fixture(); input.shots = [];
        expect(planShotAssembly(input).commands).toEqual([]);
        expect(planShotAssembly(input).rows).toEqual([]);
    });
});
