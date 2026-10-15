import { expect, test } from "bun:test";

function run(scenario: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./helpers/canvas-local-media.worker.ts", import.meta.url).href, { type: "module" });
        worker.onmessage = (event) => {
            worker.terminate();
            if (event.data.ok) resolve(event.data.result);
            else reject(new Error(event.data.error));
        };
        worker.onerror = (event) => { worker.terminate(); reject(event.error ?? new Error(event.message)); };
        worker.postMessage(scenario);
    });
}

for (const type of ["image", "media"]) {
    for (const action of ["delete", "clear"]) {
        test(`${type} ${action} invalidates a pending read without resurrecting its URL`, async () => {
            const result = await run(`${type}-read-${action}`);
            expect(result.resolved).toBe("missing");
            expect(result.created).toHaveLength(0);
        });
    }
    test(`${type} pending read resolves to the replacement rather than allocating a stale URL`, async () => {
        const result = await run(`${type}-read-replace`);
        expect(result.resolved).toBe(result.latest);
        expect(result.created).toHaveLength(1);
    });
    for (const action of ["write", "upload"]) {
        test(`${type} session reset during ${action} cannot republish an old preview`, async () => {
            const result = await run(`${type}-${action}-clear`);
            expect(result.outcome).toBe("AbortError");
            expect(result.revoked).toEqual(result.created);
            if (action === "upload") expect(result.operations).toEqual([]);
        });
    }
    test(`${type} deletion and subsequent replacement commit in order`, async () => {
        const result = await run(`${type}-delete-write`);
        expect(result.beforeRelease).toEqual([]);
        expect(result.operations).toEqual(["delete", "write"]);
        expect(result.stored).toBe("new");
        expect(result.resolved).toBe(result.latest);
        expect(result.revoked).not.toContain(result.latest);
    });
    test(`${type} failed deletion keeps the persisted file and its usable URL`, async () => {
        const result = await run(`${type}-delete-failure`);
        expect(result.error).toContain("delete failure");
        expect(result.stored).toBe(true);
        expect(result.resolved).toBe(result.url);
        expect(result.revoked).toEqual([]);
    });
    test(`${type} read failures and cache misses can retry with independent fallbacks`, async () => {
        const result = await run(`${type}-read-retry`);
        expect(result.error).toContain("read failure");
        expect(result.missing).toEqual(["fallback-A", "fallback-B"]);
        expect(result.resolved).toBe(result.created[0]);
        expect(result.created).toHaveLength(1);
    });
    test(`${type} ten create/replace/cleanup cycles release all tracked URLs`, async () => {
        const result = await run(`${type}-ten-cycles`);
        expect(result.retained).toEqual(Array(10).fill(0));
        expect(result.stored).toBe(0);
        expect(result.created).toHaveLength(20);
    });
    test(`${type} parallel local resolution shares one storage read and one object URL`, async () => {
        const result = await run(`parallel-${type}`);
        expect(result.distinctUrls).toBe(1);
        expect(result.reads).toBe(1);
        expect(result.created).toHaveLength(1);
    });
    test(`${type} replacement preserves existing consumers until explicit deletion releases every URL`, async () => {
        const result = await run(`${type}-replace-delete`);
        expect(result.beforeDelete).toEqual([]);
        expect(result.revoked.sort()).toEqual([result.oldUrl, result.newUrl].sort());
    });
}

test("unused local media cleanup releases its URL and cannot return a deleted cached file", async () => {
    const result = await run("media-cleanup");
    expect(result.stored).toBe(false);
    expect(result.afterCleanup).toBe("missing");
    expect(result.revoked).toEqual([result.url]);
});

for (const scenario of ["image-permanent-failure", "image-storage-failure", "image-metadata-failure"]) {
    test(`${scenario} releases the unowned preview URL`, async () => {
        const result = await run(scenario);
        expect(result.error).toBeString();
        expect(result.revoked).toEqual(result.created);
        expect(result.created).toHaveLength(1);
    });
}

test("failed image fetch is not uploaded or represented as a local success", async () => {
    const result = await run("image-fetch-failure");
    expect(result.error).toContain("404");
    expect(result.created).toHaveLength(0);
    expect(result.uploads).toBe(0);
});

test("a transient image upload failure retains a usable locally persisted preview", async () => {
    const result = await run("image-local-fallback");
    expect(result.image.pendingRemoteUpload).toBe(true);
    expect(result.image.url).toBe(result.created[0]);
    expect(result.revoked).toHaveLength(0);
});
