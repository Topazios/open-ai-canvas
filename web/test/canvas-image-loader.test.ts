import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { prepareCanvasImage, canvasImagePreparationStats } from "../src/services/canvas-image-loader";
import { installRuntimeLimits } from "./fixtures/runtime-limits";
import { apiClient } from "../src/services/api/request";
import { invalidateRuntimeLimits, RUNTIME_LIMITS_TTL_MS, withRuntimeConcurrency } from "../src/services/runtime-limits";
import { useUserStore } from "../src/stores/use-user-store";

const originalImage = globalThis.Image;
let images: TestImage[];
const controllers: AbortController[] = [];
class TestImage {
    src = "";
    decoding = "";
    complete = false;
    naturalWidth = 640;
    onload: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    decodeCalls = 0;
    decodeResult: Promise<void> = Promise.resolve();
    constructor() { images.push(this); }
    decode() { this.decodeCalls++; return this.decodeResult; }
    removeAttribute() { this.src = ""; }
    load() { this.onload?.(new Event("load")); }
    fail() { this.onerror?.(new Event("error")); }
}
const controller = () => { const value = new AbortController(); controllers.push(value); return value; };
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => { installRuntimeLimits(); images = []; globalThis.Image = TestImage as unknown as typeof Image; });
afterEach(async () => {
    controllers.splice(0).forEach((value) => value.abort());
    await tick();
    globalThis.Image = originalImage;
    installRuntimeLimits();
    expect(canvasImagePreparationStats()).toEqual({ active: 0, queued: 0, limit: 4, consumers: 0 });
});

describe("canvas image preparation lifetime", () => {
    test("anonymous share image loads with the public session policy, including after expiry", async () => {
        const adapter = apiClient.defaults.adapter;
        const limits = structuredClone(useUserStore.getState().runtimeLimits);
        let reads = 0;
        try {
            apiClient.defaults.adapter = async (config) => {
                expect(config.url).toBe("/auth/session"); reads++;
                return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { user: null, runtimeLimits: limits } } };
            };
            useUserStore.getState().setUser(null);
            invalidateRuntimeLimits();
            const first = prepareCanvasImage("anonymous-share", controller().signal);
            await tick(); expect(images).toHaveLength(1); images[0].load(); await first;
            useUserStore.setState({ runtimeLimitsUpdatedAt: Date.now() - 60_000 });
            limits.concurrency!.imagePreparation = 1;
            const second = prepareCanvasImage("anonymous-share-next", controller().signal);
            await tick(); expect(images).toHaveLength(2); images[1].load(); await second;
            expect(reads).toBe(2); expect(canvasImagePreparationStats().limit).toBe(1);
        } finally { apiClient.defaults.adapter = adapter; }
    });
    test("policy changes resize the shared preparation queue while active decodes finish", async () => {
        installRuntimeLimits({ imagePreparation: 1 });
        const pending = Array.from({ length: 4 }, (_, i) => prepareCanvasImage(`dynamic-${i}`, controller().signal).catch((error) => error));
        expect(images).toHaveLength(1);
        installRuntimeLimits({ imagePreparation: 2 });
        expect(images).toHaveLength(2);
        installRuntimeLimits({ imagePreparation: 1 });
        images[0].load(); await tick(); expect(images).toHaveLength(2);
        images[1].load(); await tick(); expect(images).toHaveLength(3);
        images[2].load(); await tick(); images[3].load();
        await Promise.all(pending);
    });
    test("slow image and upload queues share one timer that discovers a remote increase", async () => {
        installRuntimeLimits({ imagePreparation: 1, upload: 1 });
        const originalTimeout = globalThis.setTimeout, adapter = apiClient.defaults.adapter;
        const timers: Array<{ callback: () => Promise<void>; timer: ReturnType<typeof setTimeout> }> = [];
        const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => Promise<void>, delay: number) => {
            const timer = originalTimeout(callback, delay);
            if (delay === RUNTIME_LIMITS_TTL_MS) timers.push({ callback, timer });
            return timer;
        }) as typeof setTimeout);
        let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
        const uploads: Array<() => void> = [];
        const upload = () => withRuntimeConcurrency("upload", () => new Promise<void>((resolve) => uploads.push(resolve)), controller().signal);
        const jobs = [upload(), upload(), prepareCanvasImage("slow-a", controller().signal), prepareCanvasImage("slow-b", controller().signal)].map((job) => job.catch((error) => error));
        try {
            await tick(); expect(images).toHaveLength(1); expect(uploads).toHaveLength(1); expect(timers).toHaveLength(1);
            const limits = structuredClone(useUserStore.getState().runtimeLimits);
            limits.concurrency!.imagePreparation = 4; limits.concurrency!.upload = 4;
            apiClient.defaults.adapter = async (config) => {
                expect(config.url).toBe("/auth/session");
                return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { user: null, runtimeLimits: limits } } };
            };
            now += RUNTIME_LIMITS_TTL_MS;
            clearTimeout(timers[0].timer); await timers[0].callback(); await tick();
            expect(images).toHaveLength(2); expect(uploads).toHaveLength(2);
            images.forEach((image) => image.load()); uploads.forEach((finish) => finish()); await Promise.all(jobs);
        } finally {
            controllers.forEach((value) => value.abort()); uploads.forEach((finish) => finish()); await Promise.all(jobs);
            timers.forEach(({ timer }) => clearTimeout(timer)); timeout.mockRestore(); clock.mockRestore(); apiClient.defaults.adapter = adapter;
        }
    });
    test("account switch cancels active and waiting image consumers without sharing their result", async () => {
        installRuntimeLimits({ imagePreparation: 1 });
        const adapter = apiClient.defaults.adapter;
        apiClient.defaults.adapter = async () => { throw new Error("switching"); };
        try {
            const a = prepareCanvasImage("account-src", controller().signal).catch((e) => e);
            const b = prepareCanvasImage("account-src", controller().signal).catch((e) => e);
            const queued = prepareCanvasImage("account-queued", controller().signal).catch((e) => e);
            useUserStore.getState().setUser({ id: "next-account", username: "next", displayName: "next", role: "user", status: "active" });
            expect((await a).name).toBe("AbortError"); expect((await b).name).toBe("AbortError"); expect((await queued).name).toBe("AbortError");
            await tick();
            installRuntimeLimits();
            const next = prepareCanvasImage("account-src", controller().signal);
            expect(images).toHaveLength(2); expect(images[0].src).toBe(""); images[1].load(); await next;
        } finally { useUserStore.getState().setUser(null); apiClient.defaults.adapter = adapter; }
    });
    test("a policy failure rejects every waiting consumer and a fresh policy unblocks retries", async () => {
        const adapter = apiClient.defaults.adapter;
        try {
            apiClient.defaults.adapter = async () => { throw new Error("offline"); };
            invalidateRuntimeLimits();
            const a = prepareCanvasImage("policy-failure", controller().signal).catch((e) => e);
            const b = prepareCanvasImage("policy-failure", controller().signal).catch((e) => e);
            expect((await a).message).toContain("系统并发策略");
            expect((await b).message).toContain("系统并发策略");
            expect(images).toHaveLength(0);
            installRuntimeLimits();
            const retry = prepareCanvasImage("policy-failure", controller().signal);
            images[0].load(); expect(await retry).toBe(images[0]);
        } finally { apiClient.defaults.adapter = adapter; }
    });
    test("shared source decodes once; cancelling one consumer does not interrupt another", async () => {
        const a = controller(), b = controller();
        const first = prepareCanvasImage("same", a.signal).catch((error) => error);
        const second = prepareCanvasImage("same", b.signal);
        expect(images).toHaveLength(1);
        a.abort();
        expect(images[0].src).toBe("same");
        images[0].load(); images[0].load();
        expect((await first).name).toBe("AbortError");
        expect(await second).toBe(images[0]);
        expect(images[0].decodeCalls).toBe(1);
        expect(images[0].onload).toBeNull();
        expect(images[0].onerror).toBeNull();
    });
    test("last consumer abort releases active network and ignores late decode", async () => {
        const a = controller();
        let finish!: () => void;
        const result = prepareCanvasImage("late", a.signal).catch((error) => error);
        images[0].decodeResult = new Promise((resolve) => { finish = resolve; });
        images[0].load(); a.abort(); finish();
        expect((await result).name).toBe("AbortError");
        expect(images[0].src).toBe("");
        await tick();
        expect(canvasImagePreparationStats().active).toBe(0);
    });
    test("queued cancellation never creates an Image and four-job budget is respected", async () => {
        const pending = Array.from({ length: 4 }, (_, i) => prepareCanvasImage(`active-${i}`, controller().signal).catch((error) => error));
        const queued = controller();
        const cancelled = prepareCanvasImage("queued", queued.signal).catch((error) => error);
        expect(canvasImagePreparationStats().queued).toBe(1);
        queued.abort();
        expect(images).toHaveLength(4);
        images.forEach((image) => image.load());
        await Promise.all(pending);
        expect((await cancelled).name).toBe("AbortError");
    });
    test("queued caller retains its own timeout after a slot opens", async () => {
        const pending = Array.from({ length: 4 }, (_, i) => prepareCanvasImage(`slot-${i}`, controller().signal).catch((error) => error));
        const timeout = prepareCanvasImage("short", controller().signal, 10).catch((error) => error);
        await tick(20);
        expect(images).toHaveLength(4);
        images[0].load();
        await tick(30);
        expect((await timeout).message).toContain("超时");
        expect(images[4].src).toBe("");
        images.slice(1, 4).forEach((image) => image.load());
        await Promise.all(pending);
    });
    test("consumer deadlines are independent for shared work", async () => {
        const short = prepareCanvasImage("deadlines", controller().signal, 10).catch((error) => error);
        const long = prepareCanvasImage("deadlines", controller().signal, 1000);
        await tick(30);
        expect((await short).message).toContain("超时");
        expect(images).toHaveLength(1);
        images[0].load();
        expect(await long).toBe(images[0]);
    });
    test("failed source can be retried without a poisoned in-flight entry", async () => {
        const first = prepareCanvasImage("retry", controller().signal).catch((error) => error);
        images[0].fail();
        expect((await first).message).toContain("失败");
        const retry = prepareCanvasImage("retry", controller().signal);
        expect(images).toHaveLength(2);
        images[1].load();
        expect(await retry).toBe(images[1]);
    });
    test("already aborted request consumes no slot", async () => {
        const a = controller(); a.abort();
        await expect(prepareCanvasImage("aborted", a.signal)).rejects.toHaveProperty("name", "AbortError");
        expect(images).toHaveLength(0);
    });
});
