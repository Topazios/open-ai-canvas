import { afterEach, beforeEach, expect, test } from "bun:test";
import { apiClient } from "../src/services/api/request";
import { clearResourceAccessCache, getResourceBlob } from "../src/services/api/resources";
import { invalidateRuntimeLimits } from "../src/services/runtime-limits";
import { installRuntimeLimits } from "./fixtures/runtime-limits";

const adapter = apiClient.defaults.adapter, originalFetch = globalThis.fetch;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let requests: Array<{ url: string; signal: AbortSignal; resolve: (response: Response) => void; reject: (error: Error) => void }>;
beforeEach(() => {
    invalidateRuntimeLimits(); installRuntimeLimits({ resourceDownload: 1 }); clearResourceAccessCache(); requests = [];
    apiClient.defaults.adapter = async (config) => {
        const id = JSON.parse(config.data)[0].resourceId;
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { items: [{ resourceId: id, access: { resourceId: id, url: `https://cdn.example/${id}`, delivery: "cdn", refreshAt: new Date(Date.now() + 60_000).toISOString() } }] } } };
    };
    globalThis.fetch = ((url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
        const signal = options.signal!;
        requests.push({ url, signal, resolve, reject });
        const abort = () => reject(new DOMException("cancelled", "AbortError"));
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    })) as typeof fetch;
});
afterEach(async () => { clearResourceAccessCache(); await tick(); globalThis.fetch = originalFetch; apiClient.defaults.adapter = adapter; installRuntimeLimits(); });

test("same resource has independent consumers and uses only one network slot", async () => {
    const controller = new AbortController();
    const first = getResourceBlob("resource:shared", controller.signal).catch((e) => e);
    const second = getResourceBlob("resource:shared");
    await tick(); expect(requests).toHaveLength(1);
    controller.abort(); expect((await first).name).toBe("AbortError");
    expect(requests[0].signal.aborted).toBe(false);
    requests[0].resolve(new Response("shared"));
    expect(await (await second)!.text()).toBe("shared");
});

test("last cancellation releases the download slot and a failed source can be retried", async () => {
    const a = new AbortController(), b = new AbortController();
    const first = getResourceBlob("resource:cancel", a.signal).catch((e) => e);
    const second = getResourceBlob("resource:cancel", b.signal).catch((e) => e);
    const next = getResourceBlob("resource:next").catch((e) => e);
    await tick(); a.abort(); b.abort(); await Promise.all([first, second]); await tick();
    expect(requests).toHaveLength(2);
    requests[1].resolve(new Response("failure", { status: 503 }));
    expect((await next).message).toContain("503");
    const retry = getResourceBlob("resource:next");
    await tick(); expect(requests).toHaveLength(3);
    requests[2].resolve(new Response("retry")); expect(await (await retry)!.text()).toBe("retry");
});

test("all queued consumers can cancel without starting a network request", async () => {
    const active = getResourceBlob("resource:active");
    const a = new AbortController(), b = new AbortController();
    const queued = [getResourceBlob("resource:queued", a.signal).catch((e) => e), getResourceBlob("resource:queued", b.signal).catch((e) => e)];
    await tick(); a.abort(); b.abort();
    expect((await Promise.all(queued)).every((e) => e.name === "AbortError")).toBe(true);
    requests[0].resolve(new Response("done")); await active; await tick(); expect(requests).toHaveLength(1);
    const retry = getResourceBlob("resource:queued"); await tick();
    requests[1].resolve(new Response("done")); await retry;
});

test("shared policy failure rejects consumers without network fallback and recovers", async () => {
    apiClient.defaults.adapter = async () => { throw new Error("offline"); };
    invalidateRuntimeLimits();
    const first = getResourceBlob("resource:policy").catch((e) => e);
    const second = getResourceBlob("resource:policy").catch((e) => e);
    expect((await first).message).toContain("系统并发策略"); expect((await second).message).toContain("系统并发策略");
    expect(requests).toHaveLength(0);
    installRuntimeLimits();
});

test("cancellation during access URL lookup cannot hold a slot forever", async () => {
    const originalAdapter = apiClient.defaults.adapter;
    let finish!: () => void;
    apiClient.defaults.adapter = (config) => new Promise((resolve) => { finish = () => resolve({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { items: [] } } }); });
    const a = new AbortController();
    const blocked = getResourceBlob("resource:lookup", a.signal).catch((e) => e);
    await tick(); a.abort(); expect((await blocked).name).toBe("AbortError");
    apiClient.defaults.adapter = originalAdapter;
    const next = getResourceBlob("resource:after-lookup"); await tick();
    expect(requests).toHaveLength(1); requests[0].resolve(new Response("ok")); await next; finish(); await tick();
});
