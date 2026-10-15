import localforage from "localforage";
import type { TimelineProject } from "../../src/types/timeline";

self.onmessage = async (event: MessageEvent<string>) => {
    const values = new Map<string, string>();
    let failKey = "";
    let loseAcknowledgement = false;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => "owner" } } });
    localforage.getItem = (async (key: string) => values.get(key) ?? null) as typeof localforage.getItem;
    localforage.setItem = (async (key: string, value: string) => {
        if (failKey && key.includes(failKey)) throw new Error("Synthetic storage failure");
        values.set(key, value);
        if (loseAcknowledgement && !key.includes(":drafts")) throw new Error("Synthetic lost acknowledgement");
        return value;
    }) as typeof localforage.setItem;
    try {
        const service = await import("../../src/services/project-editor-timeline");
        const { createEditorStore } = await import("../../src/stores/editor/editor-store");
        const initial: TimelineProject = { version: 2, tracks: [{ id: "t", kind: "text", label: "Text", order: 0 }], clips: [{ id: "c", nodeId: "n", trackId: "t", kind: "text", startMs: 0, durationMs: 1000, text: "Original" }], durationMs: 1000 };
        const local: TimelineProject = { ...initial, clips: [{ ...initial.clips[0], text: "Local changes" }] };
        const remote: TimelineProject = { ...initial, clips: [{ ...initial.clips[0], text: "Other page" }] };
        const errorOf = async (promise: Promise<unknown>) => { try { await promise; return ""; } catch (error) { return String(error); } };
        const save = (snapshot: TimelineProject, draftId = "tab-a", expected = initial) => service.saveProjectEditorTimeline("p", "u", snapshot, "owner", { draftId, expectedVersion: service.projectTimelineVersion(expected) });
        const read = () => service.loadProjectEditorTimeline("p", "u", "owner");
        const drafts = () => service.loadProjectTimelineDrafts("p", "u", "owner");
        await service.saveProjectEditorTimeline("p", "u", initial, "owner");
        if (!["failed-save", "lost-ack", "store-preview"].includes(event.data)) await service.saveProjectEditorTimeline("p", "u", remote, "owner");
        let result: unknown;
        switch (event.data) {
            case "conflict": {
                const error = await errorOf(save(local));
                result = { error, drafts: await drafts(), current: await read() };
                break;
            }
            case "sessions": {
                await Promise.all([errorOf(save(local)), errorOf(save(initial, "tab-b"))]);
                const before = await drafts();
                await errorOf(save({ ...local, durationMs: 5000 }));
                result = { before, after: await drafts() };
                break;
            }
            case "restore": {
                await errorOf(save(local));
                const draft = (await drafts())[0];
                const restored = await service.restoreProjectTimelineDraft("p", "u", draft, service.projectTimelineVersion(remote), "owner");
                result = { restored, current: await read(), drafts: await drafts() };
                break;
            }
            case "stale-current": {
                await errorOf(save(local));
                const error = await errorOf(service.restoreProjectTimelineDraft("p", "u", (await drafts())[0], service.projectTimelineVersion(initial), "owner"));
                result = { error, current: await read(), drafts: await drafts() };
                break;
            }
            case "stale-draft": {
                await errorOf(save(local));
                const preview = (await drafts())[0];
                await errorOf(save(initial));
                const error = await errorOf(service.restoreProjectTimelineDraft("p", "u", preview, service.projectTimelineVersion(remote), "owner"));
                result = { error, current: await read(), drafts: await drafts() };
                break;
            }
            case "failed-save": {
                failKey = "editor-timeline:p:unit:u:user:";
                const error = await errorOf(save(local));
                failKey = "";
                const recovered = await drafts();
                await save(local);
                result = { error, recovered, drafts: await drafts(), current: await read() };
                break;
            }
            case "failed-draft": {
                failKey = ":drafts";
                const error = await errorOf(save(local));
                result = { error, current: await read(), drafts: await drafts() };
                break;
            }
            case "failed-backup": {
                await errorOf(save(local));
                failKey = ":drafts";
                const error = await errorOf(service.restoreProjectTimelineDraft("p", "u", (await drafts())[0], service.projectTimelineVersion(remote), "owner"));
                result = { error, current: await read(), drafts: await drafts() };
                break;
            }
            case "retry-cleanup": {
                await errorOf(save(local));
                await errorOf(save(initial, "tab-b"));
                await save(local, "tab-a", remote);
                result = { current: await read(), drafts: await drafts() };
                break;
            }
            case "lost-ack": {
                loseAcknowledgement = true;
                const error = await errorOf(save(local));
                loseAcknowledgement = false;
                await save(local);
                result = { error, current: await read(), drafts: await drafts() };
                break;
            }
            case "scope": {
                await errorOf(save(local));
                const draft = (await drafts())[0];
                result = { otherUser: await service.loadProjectTimelineDrafts("p", "u", "other"), otherProject: await service.loadProjectTimelineDrafts("q", "u", "owner"), otherUnit: await service.loadProjectTimelineDrafts("p", "v", "owner"), error: await errorOf(service.restoreProjectTimelineDraft("p", "v", draft, null, "owner")), current: await read() };
                break;
            }
            case "store-preview": {
                const store = createEditorStore({ saveTimeline: (snapshot) => save(snapshot) });
                store.getState().load(initial);
                store.getState().dispatch({ op: "moveClip", payload: { id: "c", startMs: 100 } });
                store.getState().previewGesture({ op: "moveClip", payload: { id: "c", startMs: 900 } });
                await service.saveProjectEditorTimeline("p", "u", remote, "owner");
                await store.getState().flushSave();
                result = { draft: (await drafts())[0], dirty: store.getState().isDirty, error: store.getState().saveError, preview: store.getState().project?.clips[0].startMs, current: await read() };
                break;
            }
            case "corrupt": {
                values.set("editor-timeline:p:unit:u:drafts:user:owner", JSON.stringify([{ version: 1, projectId: "another-project" }]));
                const error = await errorOf(save(local));
                result = { error, raw: JSON.parse(values.get("editor-timeline:p:unit:u:drafts:user:owner")!), current: await read() };
                break;
            }
            default: throw new Error(`Unknown scenario ${event.data}`);
        }
        self.postMessage({ ok: true, result });
    } catch (error) { self.postMessage({ ok: false, error: String(error) }); }
};
