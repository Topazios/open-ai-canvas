import { describe, expect, test } from "bun:test";

import { createEditorStore } from "../src/stores/editor/editor-store";
import type { SaveTimeline } from "../src/stores/editor/editor-store";
import type { TimelineProject } from "../src/types/timeline";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeProject(): TimelineProject {
    return {
        version: 2,
        tracks: [
            { id: "video-1", kind: "video", label: "视频 1", order: 0 },
            { id: "subtitle-1", kind: "subtitle", label: "字幕 1", order: 1 },
        ],
        clips: [
            { id: "clip-a", kind: "video", nodeId: "node-a", trackId: "video-1", startMs: 0, durationMs: 5000, sourceStartMs: 0, sourceDurationMs: 10000 },
            { id: "sub-1", kind: "subtitle", nodeId: "node-a", trackId: "subtitle-1", startMs: 500, durationMs: 2000, subtitleEntryIndex: 0, text: "你好" },
        ],
        durationMs: 5000,
    };
}

describe("editor store (command dispatch)", () => {
    test("a failed batch commits no partial commands, history or saves", async () => {
        const saves: TimelineProject[] = [];
        const store = createEditorStore({ saveTimeline: async (project) => { saves.push(project); } });
        const original = makeProject();
        store.getState().load(original);
        expect(store.getState().dispatchBatch([
            { op: "moveClip", payload: { id: "clip-a", startMs: 1000 } },
            { op: "trimClip", payload: { id: "clip-a", durationMs: 20000 } },
        ])).toBe(false);
        expect(store.getState().project).toBe(original);
        expect(store.getState().history?.undoStack).toHaveLength(0);
        expect(store.getState().isDirty).toBe(false);
        expect(store.getState().saveError).toContain("sourceDurationMs");
        await store.getState().flushSave();
        expect(saves).toHaveLength(0);
    });

    test("a batch rejects a stale preview snapshot and an active gesture", () => {
        const store = createEditorStore();
        const original = makeProject();
        store.getState().load(original);
        const command = { op: "moveClip", payload: { id: "clip-a", startMs: 1000 } };
        store.getState().dispatch(command);
        const edited = store.getState().project;
        expect(store.getState().dispatchBatch([command], original)).toBe(false);
        expect(store.getState().project).toBe(edited);
        store.getState().previewGesture(command);
        expect(store.getState().dispatchBatch([command])).toBe(false);
        store.getState().cancelGesture();
        expect(store.getState().history?.undoStack).toHaveLength(1);
    });

    test("an empty batch does not add history or mark the project dirty", () => {
        const store = createEditorStore();
        store.getState().load(makeProject());
        expect(store.getState().dispatchBatch([])).toBe(true);
        expect(store.getState().history?.undoStack).toHaveLength(0);
        expect(store.getState().isDirty).toBe(false);
    });

    test("batch save failure keeps the assembled timeline for retry", async () => {
        let fail = true;
        const saves: TimelineProject[] = [];
        const store = createEditorStore({ saveTimeline: async (project) => {
            if (fail) throw new Error("Storage full");
            saves.push(project);
        } });
        store.getState().load(makeProject());
        store.getState().dispatchBatch([
            { op: "moveClip", payload: { id: "clip-a", startMs: 1000 } },
            { op: "setClipProperty", payload: { id: "clip-a", patch: { volume: 0.2 } } },
        ]);
        const edited = store.getState().project!;
        await store.getState().flushSave();
        expect(store.getState().isDirty).toBe(true);
        expect(store.getState().saveError).toBe("Storage full");
        fail = false;
        await store.getState().retrySave();
        expect(saves).toEqual([edited]);
        expect(store.getState().isDirty).toBe(false);
        expect(store.getState().history?.undoStack).toHaveLength(1);
    });

    test("a debounce save during dragging persists the committed edit, not the preview", async () => {
        const saves: TimelineProject[] = [];
        const store = createEditorStore({ debounceMs: 20, saveTimeline: async (project) => { saves.push(project); } });
        store.getState().load(makeProject());
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 1000 } });
        store.getState().previewGesture({ op: "moveClip", payload: { id: "clip-a", startMs: 2000 } });
        await sleep(50);
        expect(saves[0].clips[0].startMs).toBe(1000);
        store.getState().cancelGesture();
        expect(store.getState().project?.clips[0].startMs).toBe(1000);
        expect(store.getState().isDirty).toBe(false);
    });

    test("a previous load's failed save cannot mark a new loaded project dirty", async () => {
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const store = createEditorStore({ debounceMs: 0, saveTimeline: async () => { entered(); await pending; throw new Error("old failure"); } });
        store.getState().load(makeProject());
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 1000 } });
        await started;
        store.getState().load(makeProject());
        release();
        await sleep(10);
        expect(store.getState().saveError).toBeNull();
        expect(store.getState().isDirty).toBe(false);
    });

    test("an earlier save does not clear edits waiting for the next debounce", async () => {
        const saves: TimelineProject[] = [];
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const firstSave = new Promise<void>((resolve) => { release = resolve; });
        const store = createEditorStore({ debounceMs: 20, saveTimeline: async (project) => {
            saves.push(project);
            if (saves.length === 1) { entered(); await firstSave; }
        } });
        store.getState().load(makeProject());
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 1000 } });
        await started;
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 2000 } });
        release();
        await sleep(50);
        expect(saves.map((project) => project.clips[0].startMs)).toEqual([1000, 2000]);
        expect(store.getState().isDirty).toBe(false);
    });

    test("load initializes project and history without saving", async () => {
        const saves: TimelineProject[] = [];
        const store = createEditorStore({ saveTimeline: async (p) => void saves.push(p) });
        store.getState().load(makeProject());
        expect(store.getState().project?.durationMs).toBe(5000);
        expect(store.getState().isDirty).toBe(false);
        expect(store.getState().history?.undoStack).toHaveLength(0);
        await sleep(10);
        expect(saves).toHaveLength(0);
    });

    test("dispatch applies the command, marks dirty, and debounce-saves the latest state", async () => {
        const saves: TimelineProject[] = [];
        const store = createEditorStore({ saveTimeline: async (p) => void saves.push(p), debounceMs: 0 });
        store.getState().load(makeProject());

        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 2000 } });
        expect(store.getState().project?.clips.find((c) => c.id === "clip-a")?.startMs).toBe(2000);
        expect(store.getState().isDirty).toBe(true);
        expect(store.getState().history?.undoStack).toHaveLength(1);

        await sleep(10);
        expect(saves).toHaveLength(1);
        expect(saves[0].clips.find((c) => c.id === "clip-a")?.startMs).toBe(2000);
        expect(store.getState().isDirty).toBe(false);
        expect(store.getState().saveError).toBeNull();
    });

    test("rejected command keeps state and history, surfaces saveError", async () => {
        const store = createEditorStore({ saveTimeline: async () => undefined, debounceMs: 0 });
        store.getState().load(makeProject());
        const before = store.getState().project;

        store.getState().dispatch({ op: "unknownOp", payload: {} });
        expect(store.getState().project).toBe(before);
        expect(store.getState().history?.undoStack).toHaveLength(0);
        expect(store.getState().saveError).toMatch(/unknown edit command op "unknownOp"/);
        expect(store.getState().isDirty).toBe(false);
    });

    test("undo/redo walk the history and each trigger a save", async () => {
        const saves: TimelineProject[] = [];
        const store = createEditorStore({ saveTimeline: async (p) => void saves.push(p), debounceMs: 0 });
        store.getState().load(makeProject());
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 2000 } });
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 3000 } });
        await sleep(10);

        store.getState().undo();
        expect(store.getState().project?.clips.find((c) => c.id === "clip-a")?.startMs).toBe(2000);
        store.getState().undo();
        expect(store.getState().project?.clips.find((c) => c.id === "clip-a")?.startMs).toBe(0);
        store.getState().undo(); // 栈底，无操作
        expect(store.getState().project?.clips.find((c) => c.id === "clip-a")?.startMs).toBe(0);

        store.getState().redo();
        expect(store.getState().project?.clips.find((c) => c.id === "clip-a")?.startMs).toBe(2000);
        await sleep(10);
        // 两次 dispatch 合并 1 次保存；undo/undo/redo 同步执行合并 1 次保存
        expect(saves).toHaveLength(2);
        expect(saves.at(-1)?.clips.find((c) => c.id === "clip-a")?.startMs).toBe(2000);
    });

    test("multiple dispatches within debounce window collapse into one save", async () => {
        const saves: TimelineProject[] = [];
        const store = createEditorStore({ saveTimeline: async (p) => void saves.push(p), debounceMs: 60 });
        store.getState().load(makeProject());

        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 1000 } });
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 2000 } });
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 3000 } });
        expect(saves).toHaveLength(0); // 防抖窗口内不保存

        await sleep(120);
        expect(saves).toHaveLength(1);
        expect(saves[0].clips.find((c) => c.id === "clip-a")?.startMs).toBe(3000);

        // 新一轮变更再次触发一次保存
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 4000 } });
        await sleep(120);
        expect(saves).toHaveLength(2);
        expect(saves[1].clips.find((c) => c.id === "clip-a")?.startMs).toBe(4000);
    });

    test("save failure marks saveError and keeps dirty; next successful save clears it", async () => {
        let fail = true;
        const store = createEditorStore({
            saveTimeline: async () => {
                if (fail) throw new Error("backend unreachable");
            },
            debounceMs: 0,
        });
        store.getState().load(makeProject());
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 1000 } });
        await sleep(10);
        expect(store.getState().saveError).toBe("backend unreachable");
        expect(store.getState().isDirty).toBe(true);

        fail = false;
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 2000 } });
        await sleep(10);
        expect(store.getState().saveError).toBeNull();
        expect(store.getState().isDirty).toBe(false);
    });

    test("retrySave retries a failed dirty snapshot without another edit", async () => {
        let attempts = 0;
        const store = createEditorStore({
            saveTimeline: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error("temporary storage failure");
            },
            debounceMs: 10_000,
        });
        store.getState().load(makeProject());
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 1200 } });
        await expect(store.getState().flushSave()).resolves.toBeUndefined();
        expect(store.getState().isDirty).toBe(true);
        await expect(store.getState().retrySave()).resolves.toBeUndefined();
        expect(store.getState().isDirty).toBe(false);
        expect(store.getState().saveError).toBeNull();
        expect(attempts).toBe(2);
    });

    test("flushSave persists immediately and clears pending debounce", async () => {
        const saves: TimelineProject[] = [];
        const store = createEditorStore({ saveTimeline: async (p) => void saves.push(p), debounceMs: 10_000 });
        store.getState().load(makeProject());
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 1000 } });

        await store.getState().flushSave();
        expect(saves).toHaveLength(1);
        expect(store.getState().isDirty).toBe(false);
        // 防抖 timer 已清：再等也不会有第二次
        await sleep(20);
        expect(saves).toHaveLength(1);
    });

    test("load resets history and dirty state", async () => {
        const store = createEditorStore({ saveTimeline: async () => undefined, debounceMs: 0 });
        store.getState().load(makeProject());
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 1000 } });
        expect(store.getState().history?.undoStack).toHaveLength(1);

        store.getState().load(makeProject());
        expect(store.getState().history?.undoStack).toHaveLength(0);
        expect(store.getState().isDirty).toBe(false);
    });
});

describe("editor store (gesture preview)", () => {
    test("preview applies without history; commit pushes once; cancel restores", async () => {
        const store = createEditorStore({ saveTimeline: async () => undefined, debounceMs: 0 });
        store.getState().load(makeProject());
        const committed = store.getState().project;

        // 预览：连续两次手势调用（模拟拖拽中），不入历史
        store.getState().previewGesture({ op: "moveClip", payload: { id: "clip-a", startMs: 1000 } });
        store.getState().previewGesture({ op: "moveClip", payload: { id: "clip-a", startMs: 2000 } });
        expect(store.getState().inPreview).toBe(true);
        expect(store.getState().project?.clips.find((c) => c.id === "clip-a")?.startMs).toBe(2000);
        expect(store.getState().history?.undoStack).toHaveLength(0);

        // 预览期间 dispatch 被拒绝
        store.getState().dispatch({ op: "moveClip", payload: { id: "clip-a", startMs: 5000 } });
        expect(store.getState().project?.clips.find((c) => c.id === "clip-a")?.startMs).toBe(2000);
        expect(store.getState().saveError).toMatch(/gesture preview/);

        // 提交：一次性入历史，可一次 undo 回到手势前
        store.getState().commitGesture();
        expect(store.getState().inPreview).toBe(false);
        expect(store.getState().history?.undoStack).toHaveLength(1);
        store.getState().undo();
        expect(store.getState().project).toBe(committed);
        expect(store.getState().project?.clips.find((c) => c.id === "clip-a")?.startMs).toBe(0);
    });

    test("cancel discards preview changes", async () => {
        const store = createEditorStore({ saveTimeline: async () => undefined, debounceMs: 0 });
        store.getState().load(makeProject());
        const committed = store.getState().project;

        store.getState().previewGesture({ op: "moveClip", payload: { id: "clip-a", startMs: 1000 } });
        expect(store.getState().project?.clips.find((c) => c.id === "clip-a")?.startMs).toBe(1000);
        store.getState().cancelGesture();
        expect(store.getState().inPreview).toBe(false);
        expect(store.getState().project).toBe(committed);
        expect(store.getState().history?.undoStack).toHaveLength(0);
    });

    test("rejected preview command does not enter preview", async () => {
        const store = createEditorStore({ saveTimeline: async () => undefined, debounceMs: 0 });
        store.getState().load(makeProject());
        const before = store.getState().project;

        store.getState().previewGesture({ op: "unknownOp", payload: {} });
        expect(store.getState().inPreview).toBe(false);
        expect(store.getState().project).toBe(before);
        expect(store.getState().saveError).toMatch(/unknown edit command op/);
    });

    test("selectClip toggles selection without touching history or dirty state", async () => {
        const store = createEditorStore({ saveTimeline: async () => undefined, debounceMs: 0 });
        store.getState().load(makeProject());
        expect(store.getState().selectedClipId).toBeNull();

        store.getState().selectClip("clip-a");
        expect(store.getState().selectedClipId).toBe("clip-a");
        expect(store.getState().isDirty).toBe(false);
        expect(store.getState().history?.undoStack).toHaveLength(0);

        store.getState().selectClip(null);
        expect(store.getState().selectedClipId).toBeNull();
    });

    test("load resets selection", async () => {
        const store = createEditorStore({ saveTimeline: async () => undefined, debounceMs: 0 });
        store.getState().load(makeProject());
        store.getState().selectClip("clip-a");
        store.getState().load(makeProject());
        expect(store.getState().selectedClipId).toBeNull();
    });
});
