import localforage from "localforage";
import type { TimelineProject } from "../../src/types/timeline";

function gate() {
    let resolve!: () => void;
    return { promise: new Promise<void>((done) => { resolve = done; }), release: () => resolve() };
}

self.onmessage = async (event: MessageEvent<string>) => {
    const values = new Map<string, string>();
    let activeScope = "owner-a";
    let failWrite = false;
    let readGate: ReturnType<typeof gate> | undefined;
    let writeGate: ReturnType<typeof gate> | undefined;
    const entered = gate();
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => activeScope } } });
    localforage.getItem = (async (key: string) => {
        const result = values.get(key) ?? null;
        if (readGate) { const pending = readGate; readGate = undefined; entered.release(); await pending.promise; }
        return result;
    }) as typeof localforage.getItem;
    localforage.setItem = (async (key: string, value: string) => {
        if (writeGate) { const pending = writeGate; writeGate = undefined; entered.release(); await pending.promise; }
        if (failWrite) throw new Error("Synthetic quota failure");
        values.set(key, value);
        return value;
    }) as typeof localforage.setItem;
    try {
        const delivery = await import("../../src/services/short-drama-delivery-store");
        const storage = await import("../../src/services/project-editor-timeline");
        const timeline: TimelineProject = { version: 2, tracks: [{ id: "v", kind: "video", label: "Video", order: 0 }], clips: [{ id: "c", nodeId: "n", trackId: "v", kind: "video", startMs: 0, durationMs: 1000, directMedia: { id: "r", kind: "video", title: "Local fixture", storageKey: "resource:fixture" } }], durationMs: 1000 };
        const changed = { ...timeline, clips: timeline.clips.map((clip) => ({ ...clip, volume: 0.5 })) };
        const readiness = { readyShotCount: 1, totalShotCount: 1, staleArtifactCount: 0, currentTimelineFingerprint: delivery.timelineFingerprint(timeline) };
        await storage.saveProjectEditorTimeline("p", "u", timeline);
        const original = await delivery.recordLocalDeliveryRender({ projectId: "p", unitId: "u", timeline, result: { resourceId: "render-a" } });
        let result: unknown;
        const errorOf = async (operation: Promise<unknown>) => { try { await operation; return ""; } catch (error) { return String(error); } };
        switch (event.data) {
            case "position-roundtrip": {
                const { captureDeliveryIssuePosition, locateDeliveryIssuePosition } = await import("../../src/lib/timeline/review-position");
                const position = captureDeliveryIssuePosition(original, 500, "c");
                await delivery.addLocalDeliveryIssue("p", "u", "major", "Frame note", original, "owner-a", position);
                const restored = (await delivery.loadLocalDeliveryRecord("p", "u"))!;
                const moved = { ...timeline, clips: timeline.clips.map((clip) => ({ ...clip, startMs: 1000 })), durationMs: 2000 };
                await storage.saveProjectEditorTimeline("p", "u", moved);
                const rendered = await delivery.recordLocalDeliveryRender({ projectId: "p", unitId: "u", timeline: moved, result: { resourceId: "render-b" } });
                result = { restored, rendered, location: locateDeliveryIssuePosition(rendered.issues[0].position!, rendered) };
                break;
            }
            case "position-stale": {
                const { captureDeliveryIssuePosition } = await import("../../src/lib/timeline/review-position");
                const position = captureDeliveryIssuePosition(original, 500, "c");
                const replacement = await delivery.recordLocalDeliveryRender({ projectId: "p", unitId: "u", timeline, result: { resourceId: "render-b" } });
                const error = await errorOf(delivery.addLocalDeliveryIssue("p", "u", "major", "Old file draft", replacement, "owner-a", position));
                result = { error, current: await delivery.loadLocalDeliveryRecord("p", "u") };
                break;
            }
            case "position-invalid": {
                const { captureDeliveryIssuePosition } = await import("../../src/lib/timeline/review-position");
                const position = captureDeliveryIssuePosition(original, 500, "c");
                const error = await errorOf(delivery.addLocalDeliveryIssue("p", "u", "major", "Invalid offset", original, "owner-a", { ...position, sourceTimeMs: 900 }));
                result = { error, current: await delivery.loadLocalDeliveryRecord("p", "u") };
                break;
            }
            case "saved-edit": {
                await delivery.updateLocalDeliveryReview("p", "u", "verified", original, readiness);
                await storage.saveProjectEditorTimeline("p", "u", changed);
                const snapshot = await delivery.loadLocalDeliverySnapshot("p", "u");
                result = { historical: snapshot.record!.reviewStatus, canVerify: delivery.canVerifyLocalDelivery(snapshot.record, { ...readiness, currentTimelineFingerprint: snapshot.currentTimelineFingerprint }), error: await errorOf(delivery.updateLocalDeliveryReview("p", "u", "verified", snapshot.record!, readiness)) };
                break;
            }
            case "new-render": {
                await delivery.recordLocalDeliveryRender({ projectId: "p", unitId: "u", timeline, result: { resourceId: "render-b" } });
                const error = await errorOf(delivery.updateLocalDeliveryReview("p", "u", "verified", original, readiness));
                result = { error, current: await delivery.loadLocalDeliveryRecord("p", "u") };
                break;
            }
            case "parallel-issues": {
                const outcomes = await Promise.allSettled([
                    delivery.addLocalDeliveryIssue("p", "u", "major", "First note", original),
                    delivery.addLocalDeliveryIssue("p", "u", "minor", "Second note", original),
                ]);
                const saved = (await delivery.loadLocalDeliveryRecord("p", "u"))!;
                await delivery.addLocalDeliveryIssue("p", "u", "minor", "Retry note", saved);
                result = { outcomes: outcomes.map((item) => item.status), current: await delivery.loadLocalDeliveryRecord("p", "u") };
                break;
            }
            case "save-failure": {
                failWrite = true;
                const error = await errorOf(delivery.addLocalDeliveryIssue("p", "u", "major", "Retained draft", original));
                const afterFailure = await delivery.loadLocalDeliveryRecord("p", "u");
                failWrite = false;
                const retried = await delivery.addLocalDeliveryIssue("p", "u", "major", "Retained draft", original);
                result = { error, afterFailure, retried };
                break;
            }
            case "scope-switch": {
                const waiting = gate(); readGate = waiting;
                const operation = delivery.addLocalDeliveryIssue("p", "u", "major", "Owner A note", original);
                await entered.promise;
                activeScope = "owner-b";
                waiting.release();
                await operation;
                result = { a: await delivery.loadLocalDeliveryRecord("p", "u", "owner-a"), b: await delivery.loadLocalDeliveryRecord("p", "u", "owner-b") };
                break;
            }
            case "late-render": {
                await storage.saveProjectEditorTimeline("p", "u", changed);
                await delivery.recordLocalDeliveryRender({ projectId: "p", unitId: "u", timeline: changed, result: { resourceId: "render-b" } });
                const error = await errorOf(delivery.recordLocalDeliveryRender({ projectId: "p", unitId: "u", timeline, result: { resourceId: "late-render-a" } }));
                result = { error, current: await delivery.loadLocalDeliveryRecord("p", "u") };
                break;
            }
            case "corrupt-storage": {
                values.set(`${storage.projectEditorTimelineKey("p", "u")}:user:owner-a`, "{broken");
                const error = await errorOf(delivery.loadLocalDeliverySnapshot("p", "u"));
                result = { error, current: await delivery.loadLocalDeliveryRecord("p", "u") };
                break;
            }
            case "save-during-approval": {
                const waiting = gate(); writeGate = waiting;
                const save = storage.saveProjectEditorTimeline("p", "u", changed);
                await entered.promise;
                const confirmation = errorOf(delivery.updateLocalDeliveryReview("p", "u", "verified", original, readiness));
                waiting.release();
                await save;
                result = { error: await confirmation, current: await delivery.loadLocalDeliveryRecord("p", "u") };
                break;
            }
            case "unit-isolation": {
                await storage.saveProjectEditorTimeline("p", undefined, changed);
                const error = await errorOf(delivery.recordLocalDeliveryRender({ projectId: "p", unitId: "other-unit", timeline, result: { resourceId: "other-render" } }));
                result = { error, current: await delivery.loadLocalDeliveryRecord("p", "u"), other: await delivery.loadLocalDeliverySnapshot("p", "other-unit"), legacy: await storage.loadProjectEditorTimeline("p", undefined) };
                break;
            }
            default: throw new Error("Unknown scenario");
        }
        self.postMessage({ ok: true, result });
    } catch (error) { self.postMessage({ ok: false, error: String(error) }); }
};
