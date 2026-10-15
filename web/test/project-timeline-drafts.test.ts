import { expect, test } from "bun:test";

function run(scenario: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./helpers/project-timeline-drafts.worker.ts", import.meta.url).href, { type: "module" });
        const timeout = setTimeout(() => { worker.terminate(); reject(new Error(`Timed out: ${scenario}`)); }, 5000);
        worker.onmessage = (event) => { clearTimeout(timeout); worker.terminate(); event.data.ok ? resolve(event.data.result) : reject(new Error(event.data.error)); };
        worker.onerror = (event) => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
        worker.postMessage(scenario);
    });
}

test("conflict persists the rejected local snapshot without replacing the saved version", async () => {
    const result = await run("conflict");
    expect(result.error).toContain("本机草稿");
    expect(result.current.clips[0].text).toBe("Other page");
    expect(result.drafts[0].snapshot.clips[0].text).toBe("Local changes");
});
test("concurrent sessions retain separate drafts and only replace their own revision", async () => {
    const result = await run("sessions");
    expect(result.after).toHaveLength(2);
    expect(result.after.find((draft: any) => draft.id === "tab-a").snapshot.durationMs).toBe(5000);
    expect(result.after.find((draft: any) => draft.id === "tab-a").revision).not.toBe(result.before[0].revision);
    expect(result.after.find((draft: any) => draft.id === "tab-b")).toEqual(result.before[1]);
});
test("explicit restore saves the chosen draft and preserves the displaced saved version", async () => {
    const result = await run("restore");
    expect(result.current).toEqual(result.restored);
    expect(result.current.clips[0].text).toBe("Local changes");
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].reason).toBe("before-recovery");
    expect(result.drafts[0].snapshot.clips[0].text).toBe("Other page");
});
test("changed current version invalidates the recovery preview", async () => {
    const result = await run("stale-current");
    expect(result.error).toContain("当前剪辑已变化");
    expect(result.current.clips[0].text).toBe("Other page");
    expect(result.drafts).toHaveLength(1);
});
test("changed draft revision invalidates the recovery preview", async () => {
    const result = await run("stale-draft");
    expect(result.error).toContain("所选草稿已变化");
    expect(result.current.clips[0].text).toBe("Other page");
    expect(result.drafts[0].snapshot.clips[0].text).toBe("Original");
});
test("failed canonical write preserves a draft and successful retry removes it", async () => {
    const result = await run("failed-save");
    expect(result.error).toContain("本机草稿");
    expect(result.recovered[0].snapshot.clips[0].text).toBe("Local changes");
    expect(result.drafts).toHaveLength(0);
    expect(result.current.clips[0].text).toBe("Local changes");
});
test("draft write failure never claims refresh recovery succeeded", async () => {
    const result = await run("failed-draft");
    expect(result.error).toContain("草稿写入也失败");
    expect(result.error).not.toContain("修改已保留为本机草稿");
    expect(result.drafts).toHaveLength(0);
    expect(result.current.clips[0].text).toBe("Other page");
});
test("failed backup blocks recovery before replacing current content", async () => {
    const result = await run("failed-backup");
    expect(result.error).toContain("storage failure");
    expect(result.current.clips[0].text).toBe("Other page");
    expect(result.drafts).toHaveLength(1);
});
test("successful save only removes the saving session's draft", async () => {
    const result = await run("retry-cleanup");
    expect(result.current.clips[0].text).toBe("Local changes");
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0].id).toBe("tab-b");
});
test("lost write acknowledgement can retry the exact committed version", async () => {
    const result = await run("lost-ack");
    expect(result.error).toContain("lost acknowledgement");
    expect(result.current.clips[0].text).toBe("Local changes");
    expect(result.drafts).toHaveLength(0);
});
test("draft reads and recovery remain isolated by user, project and episode", async () => {
    const result = await run("scope");
    expect(result.otherUser).toHaveLength(0);
    expect(result.otherProject).toHaveLength(0);
    expect(result.otherUnit).toHaveLength(0);
    expect(result.error).toContain("所选草稿已变化");
    expect(result.current.clips[0].text).toBe("Other page");
});
test("editor conflict keeps dirty state and persists committed edits, excluding drag preview", async () => {
    const result = await run("store-preview");
    expect(result.dirty).toBe(true);
    expect(result.error).toContain("本机草稿");
    expect(result.preview).toBe(900);
    expect(result.draft.snapshot.clips[0].startMs).toBe(100);
    expect(result.current.clips[0].text).toBe("Other page");
});
test("malformed draft storage is preserved and cannot be silently replaced", async () => {
    const result = await run("corrupt");
    expect(result.error).toContain("草稿记录无效");
    expect(result.raw).toEqual([{ version: 1, projectId: "another-project" }]);
    expect(result.current.clips[0].text).toBe("Other page");
});
