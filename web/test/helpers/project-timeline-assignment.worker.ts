import localforage from "localforage";
import type { TimelineProject } from "../../src/types/timeline";

self.onmessage = async (event: MessageEvent<string>) => {
    const values = new Map<string, string>();
    let failWrite = false;
    let failAfterWrite = false;
    let writes = 0;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => "owner" } } });
    localforage.getItem = (async (key: string) => values.get(key) ?? null) as typeof localforage.getItem;
    localforage.setItem = (async (key: string, value: string) => {
        writes++;
        if (failWrite) throw new Error("Synthetic quota failure");
        values.set(key, value);
        if (failAfterWrite) throw new Error("Synthetic lost acknowledgement");
        return value;
    }) as typeof localforage.setItem;
    try {
        const storage = await import("../../src/services/project-editor-timeline");
        const timeline: TimelineProject = {
            version: 2, durationMs: 2000,
            tracks: [{ id: "v", kind: "video", label: "Video", order: 0, locked: true }, { id: "s", kind: "subtitle", label: "Subtitles", order: 1 }],
            clips: [
                { id: "c", nodeId: "n", trackId: "v", kind: "video", startMs: 200, durationMs: 1800, sourceStartMs: 300, volume: 0.7, directMedia: { id: "r", kind: "video", title: "Local fixture", storageKey: "resource:fixture" } },
                { id: "s", nodeId: "n", trackId: "s", kind: "subtitle", startMs: 400, durationMs: 900, text: "Original subtitle" },
            ],
        };
        const changed = { ...timeline, clips: timeline.clips.map((clip) => ({ ...clip, title: "Edited" })) };
        await storage.saveProjectEditorTimeline("p", undefined, timeline);
        const sourceKey = "editor-timeline:p:user:owner";
        const originalRaw = values.get(sourceKey);
        const errorOf = async (promise: Promise<unknown>) => { try { await promise; return ""; } catch (error) { return String(error); } };
        let result: unknown;
        switch (event.data) {
            case "preview": {
                const before = writes;
                result = { preview: await storage.previewLegacyProjectTimeline("p"), target: await storage.loadProjectEditorTimeline("p", "u"), writes: writes - before };
                break;
            }
            case "assign": {
                const before = writes;
                const assigned = await storage.assignLegacyProjectTimeline("p", "u", timeline);
                result = { assigned, restored: await storage.loadProjectEditorTimeline("p", "u"), other: await storage.loadProjectEditorTimeline("p", "other"), unchanged: values.get(sourceKey) === originalRaw, writes: writes - before };
                break;
            }
            case "idempotent": {
                await storage.assignLegacyProjectTimeline("p", "u", timeline);
                await storage.saveProjectEditorTimeline("p", "u", changed, "owner", { expectedVersion: storage.projectTimelineVersion(timeline) });
                const again = await storage.assignLegacyProjectTimeline("p", "u", timeline);
                const error = await errorOf(storage.assignLegacyProjectTimeline("p", "other", timeline));
                result = { again, error, other: await storage.loadProjectEditorTimeline("p", "other"), unchanged: values.get(sourceKey) === originalRaw };
                break;
            }
            case "existing": {
                await storage.saveProjectEditorTimeline("p", "u", { version: 2, tracks: [], clips: [], durationMs: 0 });
                const error = await errorOf(storage.assignLegacyProjectTimeline("p", "u", timeline));
                result = { error, target: await storage.loadProjectEditorTimeline("p", "u"), preview: await storage.previewLegacyProjectTimeline("p") };
                break;
            }
            case "stale-source": {
                await storage.saveProjectEditorTimeline("p", undefined, changed);
                result = { error: await errorOf(storage.assignLegacyProjectTimeline("p", "u", timeline)), target: await storage.loadProjectEditorTimeline("p", "u") };
                break;
            }
            case "failed-write": {
                failWrite = true;
                const error = await errorOf(storage.assignLegacyProjectTimeline("p", "u", timeline));
                const afterFailure = await storage.loadProjectEditorTimeline("p", "u");
                failWrite = false;
                await storage.assignLegacyProjectTimeline("p", "u", timeline);
                result = { error, afterFailure, restored: await storage.loadProjectEditorTimeline("p", "u"), unchanged: values.get(sourceKey) === originalRaw };
                break;
            }
            case "lost-ack": {
                failAfterWrite = true;
                const error = await errorOf(storage.assignLegacyProjectTimeline("p", "u", timeline));
                failAfterWrite = false;
                const before = writes;
                const recovered = await storage.assignLegacyProjectTimeline("p", "u", timeline);
                result = { error, recovered, writes: writes - before, other: await errorOf(storage.assignLegacyProjectTimeline("p", "other", timeline)) };
                break;
            }
            case "parallel": {
                const results = await Promise.allSettled([storage.assignLegacyProjectTimeline("p", "u", timeline), storage.assignLegacyProjectTimeline("p", "other", timeline)]);
                result = { results: results.map((item) => item.status), preview: await storage.previewLegacyProjectTimeline("p"), other: await storage.loadProjectEditorTimeline("p", "other") };
                break;
            }
            case "stale-editor": {
                await storage.assignLegacyProjectTimeline("p", "u", timeline);
                const error = await errorOf(storage.saveProjectEditorTimeline("p", "u", changed, "owner", { expectedVersion: null }));
                result = { error, target: await storage.loadProjectEditorTimeline("p", "u") };
                break;
            }
            case "parallel-editors": {
                await storage.assignLegacyProjectTimeline("p", "u", timeline);
                const expectedVersion = storage.projectTimelineVersion(timeline);
                const results = await Promise.allSettled([
                    storage.saveProjectEditorTimeline("p", "u", changed, "owner", { expectedVersion }),
                    storage.saveProjectEditorTimeline("p", "u", { ...timeline, durationMs: 3000 }, "owner", { expectedVersion }),
                ]);
                result = { results: results.map((item) => item.status), target: await storage.loadProjectEditorTimeline("p", "u") };
                break;
            }
            case "scope": {
                await storage.assignLegacyProjectTimeline("p", "u", timeline);
                result = { otherUser: await storage.loadProjectEditorTimeline("p", "u", "other-owner"), otherProject: await storage.loadProjectEditorTimeline("other-project", "u"), own: await storage.loadProjectEditorTimeline("p", "u") };
                break;
            }
            case "conflicting-reference": {
                const bound = { ...timeline, clips: [{ ...timeline.clips[0], shotSource: { projectId: "p", unitId: "other", shotId: "s", revisionId: "r", artifactId: "a", resourceId: "video" } }] };
                await storage.saveProjectEditorTimeline("p", undefined, bound);
                result = { error: await errorOf(storage.assignLegacyProjectTimeline("p", "u", bound)), target: await storage.loadProjectEditorTimeline("p", "u"), valid: await storage.assignLegacyProjectTimeline("p", "other", bound) };
                break;
            }
            default: throw new Error(`Unknown scenario ${event.data}`);
        }
        self.postMessage({ ok: true, result });
    } catch (error) { self.postMessage({ ok: false, error: String(error) }); }
};
