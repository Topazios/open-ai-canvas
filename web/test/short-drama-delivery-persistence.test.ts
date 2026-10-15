import { expect, test } from "bun:test";

function run(scenario: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./helpers/short-drama-delivery.worker.ts", import.meta.url).href, { type: "module" });
        const timeout = setTimeout(() => { worker.terminate(); reject(new Error(`Scenario timed out: ${scenario}`)); }, 5000);
        worker.onmessage = (event) => { clearTimeout(timeout); worker.terminate(); if (event.data.ok) resolve(event.data.result); else reject(new Error(event.data.error)); };
        worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
        worker.postMessage(scenario);
    });
}

test("time annotations restore and follow a uniquely matching clip in a new render", async () => {
    const result = await run("position-roundtrip");
    expect(result.restored.issues[0].position).toMatchObject({ resourceId: "render-a", timeMs: 500, clipId: "c", sourceTimeMs: 500 });
    expect(result.rendered.issues[0]).toEqual(result.restored.issues[0]);
    expect(result.location).toEqual({ timeMs: 1500, remapped: true, clipId: "c" });
    expect(result.rendered.reviewStatus).toBe("pending");
});

test("a refreshed record cannot rebind an old video annotation draft to the new file", async () => {
    const result = await run("position-stale");
    expect(result.error).toContain("旧审片文件");
    expect(result.current.issues).toHaveLength(0);
});

test("annotation writes validate the source offset against the rendered clip", async () => {
    const result = await run("position-invalid");
    expect(result.error).toContain("片段时间点与审片快照不一致");
    expect(result.current.issues).toHaveLength(0);
});

test("saved timeline edits invalidate effective approval and stale verification requests", async () => {
    const result = await run("saved-edit");
    expect(result.historical).toBe("verified");
    expect(result.canVerify).toBe(false);
    expect(result.error).toContain("当前成片与时间线不一致");
});

test("a stale review cannot approve the replacement render", async () => {
    const result = await run("new-render");
    expect(result.error).toContain("审片版本已更新");
    expect(result.current.resourceId).toBe("render-b");
    expect(result.current.reviewStatus).toBe("pending");
});

test("concurrent issue writes surface a version conflict and retry preserves both notes", async () => {
    const result = await run("parallel-issues");
    expect(result.outcomes).toEqual(["fulfilled", "rejected"]);
    expect(result.current.issues.map((issue: { note: string }) => issue.note)).toEqual(["First note", "Retry note"]);
});

test("failed writes retain the original record and permit a retry", async () => {
    const result = await run("save-failure");
    expect(result.error).toContain("Synthetic quota failure");
    expect(result.afterFailure.issues).toHaveLength(0);
    expect(result.retried.issues).toHaveLength(1);
});

test("an in-flight write stays in its captured account scope", async () => {
    const result = await run("scope-switch");
    expect(result.a.issues).toHaveLength(1);
    expect(result.b).toBeNull();
});

test("late obsolete render callbacks cannot replace a current delivery record", async () => {
    const result = await run("late-render");
    expect(result.error).toContain("时间线已修改");
    expect(result.current.resourceId).toBe("render-b");
});

test("corrupt saved timelines produce errors while preserving the delivery record", async () => {
    const result = await run("corrupt-storage");
    expect(result.error).not.toBe("");
    expect(result.current.resourceId).toBe("render-a");
});

test("review confirmation waits for a concurrent timeline save and rejects its stale snapshot", async () => {
    const result = await run("save-during-approval");
    expect(result.error).toContain("当前成片与时间线不一致");
    expect(result.current.reviewStatus).toBe("pending");
});

test("missing unit timelines cannot borrow another unit or the legacy project timeline", async () => {
    const result = await run("unit-isolation");
    expect(result.error).toContain("尚未保存");
    expect(result.current.resourceId).toBe("render-a");
    expect(result.other).toEqual({ record: null, currentTimelineFingerprint: null });
    expect(result.legacy.clips[0].volume).toBe(0.5);
});
