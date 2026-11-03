import { afterEach, beforeEach, expect, test } from "bun:test";
import localforage from "localforage";
import { MAX_CANVAS_SYNC_DRAFTS_PER_PROJECT, preserveCanvasSyncDraftLocked, readCanvasSyncDrafts } from "../src/services/canvas-sync-draft-storage";
import type { CanvasProject } from "../src/stores/canvas/use-canvas-store";
import { CanvasNodeType } from "../src/types/canvas";

const originalWindow = globalThis.window;
const originalGet = localforage.getItem;
const originalSet = localforage.setItem;
const indexed = new Map<string, string>();
const scope = "draft-storage-test";

function canvas(title: string): CanvasProject {
    return {
        id: "canvas",
        revision: 1,
        title,
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
        nodes: [{ id: "n1", type: CanvasNodeType.Image, title, position: { x: 0, y: 0 }, width: 100, height: 100 }],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "dots",
        showImageInfo: false,
        viewport: { x: 0, y: 0, k: 1 },
        directorScenes: [],
    };
}

beforeEach(() => {
    indexed.clear();
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { setTimeout, clearTimeout, localStorage: { getItem: () => scope, setItem: () => undefined } },
    });
    localforage.getItem = (async (key: string) => indexed.get(key) ?? null) as typeof localforage.getItem;
    localforage.setItem = (async (key: string, value: string) => {
        indexed.set(key, value);
        return value;
    }) as typeof localforage.setItem;
});

afterEach(() => {
    localforage.getItem = originalGet;
    localforage.setItem = originalSet;
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

test("drafts with new content are appended and identical content is not duplicated", async () => {
    expect(await preserveCanvasSyncDraftLocked(canvas("a"), scope)).toBe(1);
    expect(await preserveCanvasSyncDraftLocked(canvas("b"), scope)).toBe(2);
    expect(await preserveCanvasSyncDraftLocked(canvas("a"), scope)).toBe(2);
    expect((await readCanvasSyncDrafts("canvas", scope)).map((draft) => draft.project.title)).toEqual(["a", "b"]);
});

test("a project keeps only the most recent drafts once the cap is exceeded", async () => {
    const total = MAX_CANVAS_SYNC_DRAFTS_PER_PROJECT + 5;
    for (let index = 0; index < total; index++) await preserveCanvasSyncDraftLocked(canvas(`draft-${index}`), scope);
    const drafts = await readCanvasSyncDrafts("canvas", scope);
    expect(drafts).toHaveLength(MAX_CANVAS_SYNC_DRAFTS_PER_PROJECT);
    expect(drafts[0].project.title).toBe(`draft-${total - MAX_CANVAS_SYNC_DRAFTS_PER_PROJECT}`);
    expect(drafts.at(-1)!.project.title).toBe(`draft-${total - 1}`);
});

test("an already oversized backlog is trimmed even when the content is already saved", async () => {
    const key = [...indexed.keys()].find((name) => name.includes("sync-drafts")) ?? "";
    expect(key).toBe("");
    await preserveCanvasSyncDraftLocked(canvas("latest"), scope);
    const storageKey = [...indexed.keys()].find((name) => name.includes("infinite-canvas:sync-drafts:canvas"))!;
    const stored = JSON.parse(indexed.get(storageKey)!);
    const backlog = Array.from({ length: 178 }, (_, index) => ({ id: `old-${index}`, savedAt: "2026-09-01T00:00:00Z", project: canvas(`old-${index}`) }));
    backlog.push(stored[0]);
    indexed.set(storageKey, JSON.stringify(backlog));
    expect(await preserveCanvasSyncDraftLocked(canvas("latest"), scope)).toBe(MAX_CANVAS_SYNC_DRAFTS_PER_PROJECT);
    const drafts = await readCanvasSyncDrafts("canvas", scope);
    expect(drafts).toHaveLength(MAX_CANVAS_SYNC_DRAFTS_PER_PROJECT);
    expect(drafts.at(-1)!.project.title).toBe("latest");
});
