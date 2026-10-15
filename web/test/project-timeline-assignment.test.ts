import { expect, test } from "bun:test";

function run(scenario: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./helpers/project-timeline-assignment.worker.ts", import.meta.url).href, { type: "module" });
        const timeout = setTimeout(() => { worker.terminate(); reject(new Error(`Scenario timed out: ${scenario}`)); }, 5000);
        worker.onmessage = (event) => { clearTimeout(timeout); worker.terminate(); if (event.data.ok) resolve(event.data.result); else reject(new Error(event.data.error)); };
        worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
        worker.postMessage(scenario);
    });
}

test("preview is read-only and never borrows the legacy timeline implicitly", async () => {
    const result = await run("preview");
    expect(result.preview.source.clips).toHaveLength(2);
    expect(result.preview.assignedUnitId).toBeUndefined();
    expect(result.target).toBeNull();
    expect(result.writes).toBe(0);
});
test("explicit assignment commits once and restores all editing data without modifying the source", async () => {
    const result = await run("assign");
    expect(result.restored).toEqual(result.assigned);
    expect(result.restored.tracks[0].locked).toBe(true);
    expect(result.restored.clips[0]).toMatchObject({ sourceStartMs: 300, volume: 0.7 });
    expect(result.restored.clips[1].text).toBe("Original subtitle");
    expect(result.other).toBeNull();
    expect(result.unchanged).toBe(true);
    expect(result.writes).toBe(1);
});
test("repeat confirmation preserves newer unit edits and cannot assign another episode", async () => {
    const result = await run("idempotent");
    expect(result.again.clips[0].title).toBe("Edited");
    expect(result.error).toContain("已归属其他集");
    expect(result.other).toBeNull();
    expect(result.unchanged).toBe(true);
});
test("even an explicitly saved empty unit cannot be overwritten by assignment", async () => {
    const result = await run("existing");
    expect(result.error).toContain("目标集已有剪辑");
    expect(result.target.clips).toHaveLength(0);
    expect(result.preview.assignedUnitId).toBeUndefined();
});
test("an edited legacy source invalidates its old preview", async () => {
    const result = await run("stale-source");
    expect(result.error).toContain("已变化");
    expect(result.target).toBeNull();
});
test("storage failure cannot leave half an assignment and can be retried", async () => {
    const result = await run("failed-write");
    expect(result.error).toContain("quota failure");
    expect(result.afterFailure).toBeNull();
    expect(result.restored.clips).toHaveLength(2);
    expect(result.unchanged).toBe(true);
});
test("lost commit acknowledgement retries without writing or duplicating", async () => {
    const result = await run("lost-ack");
    expect(result.error).toContain("lost acknowledgement");
    expect(result.recovered.clips).toHaveLength(2);
    expect(result.writes).toBe(0);
    expect(result.other).toContain("已归属其他集");
});
test("concurrent episode confirmations have one winner", async () => {
    const result = await run("parallel");
    expect(result.results).toEqual(["fulfilled", "rejected"]);
    expect(result.preview.assignedUnitId).toBe("u");
    expect(result.other).toBeNull();
});
test("a preexisting empty editor cannot overwrite a newly assigned timeline", async () => {
    const result = await run("stale-editor");
    expect(result.error).toContain("其他页面更新");
    expect(result.target.clips[0].title).toBeUndefined();
});
test("concurrent editor saves reject a stale snapshot", async () => {
    const result = await run("parallel-editors");
    expect(result.results).toEqual(["fulfilled", "rejected"]);
    expect(result.target.clips[0].title).toBe("Edited");
    expect(result.target.durationMs).toBe(2000);
});
test("assignment is isolated by account, project and episode", async () => {
    const result = await run("scope");
    expect(result.otherUser).toBeNull();
    expect(result.otherProject).toBeNull();
    expect(result.own.clips).toHaveLength(2);
});
test("existing shot references cannot silently be rebound to a different episode", async () => {
    const result = await run("conflicting-reference");
    expect(result.error).toContain("其他项目或集数");
    expect(result.target).toBeNull();
    expect(result.valid.clips[0].shotSource.unitId).toBe("other");
});
