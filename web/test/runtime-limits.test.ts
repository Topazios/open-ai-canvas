import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../src/services/api/request";
import { freshRuntimeLimits, invalidateRuntimeLimits, readRuntimeLimits, RUNTIME_LIMITS_TTL_MS, withRuntimeConcurrency } from "../src/services/runtime-limits";
import { useUserStore } from "../src/stores/use-user-store";
import { installRuntimeLimits } from "./fixtures/runtime-limits";

const adapter = apiClient.defaults.adapter;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => { invalidateRuntimeLimits(); useUserStore.getState().setUser(null); installRuntimeLimits(); });
afterEach(() => { apiClient.defaults.adapter = adapter; invalidateRuntimeLimits(); installRuntimeLimits(); });

test("expired policy requests coalesce and refresh the existing user store", async () => {
    const limits = structuredClone(useUserStore.getState().runtimeLimits);
    limits.concurrency!.image = 9;
    let reads = 0;
    apiClient.defaults.adapter = async (config) => {
        expect(config.url).toBe("/auth/session"); reads++;
        return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { user: null, runtimeLimits: limits } } };
    };
    useUserStore.setState({ runtimeLimitsUpdatedAt: Date.now() - RUNTIME_LIMITS_TTL_MS });
    await Promise.all([readRuntimeLimits(), readRuntimeLimits(), readRuntimeLimits()]);
    expect(reads).toBe(1);
    expect(useUserStore.getState().runtimeLimits.concurrency?.image).toBe(9);
    await readRuntimeLimits();
    expect(reads).toBe(1);
});

test("failed refresh blocks stale slots; a later refresh resumes work", async () => {
    let calls = 0;
    apiClient.defaults.adapter = async () => { throw new Error("offline"); };
    invalidateRuntimeLimits();
    await expect(withRuntimeConcurrency("upload", async () => ++calls)).rejects.toThrow("系统并发策略读取失败");
    expect(calls).toBe(0);
    expect(freshRuntimeLimits()).toBeUndefined();
    expect(useUserStore.getState().runtimeLimitsError).not.toBe("");
    installRuntimeLimits({ upload: 1 });
    expect(await withRuntimeConcurrency("upload", async () => ++calls)).toBe(1);
});

test("missing, fractional and zero concurrency are rejected without a default", async () => {
    for (const value of [undefined, 0, 1.5, -1, NaN]) {
        const limits = structuredClone(useUserStore.getState().runtimeLimits);
        limits.concurrency!.video = value as number;
        apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { user: null, runtimeLimits: limits } } });
        await expect(readRuntimeLimits(true)).rejects.toThrow("缺失或无效");
    }
});

test("old account response cannot publish into the new session", async () => {
    const limits = useUserStore.getState().runtimeLimits;
    let finish!: () => void;
    apiClient.defaults.adapter = (config) => new Promise((resolve) => { finish = () => resolve({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { user: null, runtimeLimits: limits } } }); });
    const result = readRuntimeLimits(true).catch((error) => error);
    await tick();
    useUserStore.getState().setUser({ id: "next", username: "next", displayName: "next", role: "user", status: "active" });
    finish();
    expect((await result).message).toContain("账号");
    expect(freshRuntimeLimits()).toBeUndefined();
});

test("shared slots grow and shrink dynamically without cancelling active work", async () => {
    installRuntimeLimits({ upload: 1 });
    const release: Array<() => void> = [];
    const work = () => withRuntimeConcurrency("upload", () => new Promise<void>((resolve) => release.push(resolve)));
    const jobs = [work(), work(), work(), work()];
    await tick(); expect(release).toHaveLength(1);
    installRuntimeLimits({ upload: 2 });
    await tick(); expect(release).toHaveLength(2);
    installRuntimeLimits({ upload: 1 });
    release[0](); await tick(); expect(release).toHaveLength(2);
    release[1](); await tick(); expect(release).toHaveLength(3);
    release[2](); await tick(); expect(release).toHaveLength(4);
    release[3](); await Promise.all(jobs);
});

test("cancelled queued consumers and failed jobs release their slots", async () => {
    installRuntimeLimits({ resourceDownload: 1 });
    let fail!: (reason: unknown) => void;
    const first = withRuntimeConcurrency("resourceDownload", () => new Promise((_, reject) => { fail = reject; })).catch((e) => e);
    const controller = new AbortController();
    let cancelledRan = false;
    const cancelled = withRuntimeConcurrency("resourceDownload", async () => { cancelledRan = true; }, controller.signal).catch((e) => e);
    const next = withRuntimeConcurrency("resourceDownload", async () => "recovered");
    await tick(); controller.abort(); fail(new Error("download failed"));
    expect((await first).message).toBe("download failed");
    expect((await cancelled).name).toBe("AbortError");
    expect(await next).toBe("recovered"); expect(cancelledRan).toBe(false);
});

test("text and image pools do not consume each other's capacity", async () => {
    installRuntimeLimits({ text: 1, image: 1 });
    let release!: () => void;
    const text = withRuntimeConcurrency("text", () => new Promise<void>((resolve) => { release = resolve; }));
    expect(await withRuntimeConcurrency("image", async () => "image")).toBe("image");
    release(); await text;
});

test("one disposable expiry timer refreshes slow queues without completion or new arrivals", async () => {
    const originalTimeout = globalThis.setTimeout;
    const timers: Array<{ callback: () => Promise<void>; timer: ReturnType<typeof setTimeout> }> = [];
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => Promise<void>, delay: number) => {
        const timer = originalTimeout(callback, delay);
        if (delay === RUNTIME_LIMITS_TTL_MS) timers.push({ callback, timer });
        return timer;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout");
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    installRuntimeLimits({ upload: 1, text: 1 });
    const release: Array<() => void> = [];
    const work = (kind: "upload" | "text") => withRuntimeConcurrency(kind, () => new Promise<void>((resolve) => release.push(resolve)));
    const jobs = [work("upload"), work("upload"), work("text"), work("text")];
    try {
        await tick(); expect(release).toHaveLength(2); expect(timers).toHaveLength(1);
        const limits = structuredClone(useUserStore.getState().runtimeLimits);
        limits.concurrency!.upload = 4; limits.concurrency!.text = 4;
        let reads = 0;
        apiClient.defaults.adapter = async (config) => {
            expect(config.url).toBe("/auth/session"); reads++;
            return { config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { user: null, runtimeLimits: limits } } };
        };
        now += RUNTIME_LIMITS_TTL_MS;
        clearTimeout(timers[0].timer); await timers[0].callback(); await tick();
        expect(reads).toBe(1); expect(release).toHaveLength(4);
        // Both queues are now empty even though all four tasks are still running.
        for (const timer of timers.slice(1)) expect(clear).toHaveBeenCalledWith(timer.timer);
        release.forEach((finish) => finish()); await Promise.all(jobs);
    } finally {
        timers.forEach(({ timer }) => clearTimeout(timer)); timeout.mockRestore(); clear.mockRestore(); clock.mockRestore();
    }
});

test("expiry refresh failure rejects waiting jobs and clears the timer instead of polling in a loop", async () => {
    const originalTimeout = globalThis.setTimeout;
    const timers: Array<{ callback: () => Promise<void>; timer: ReturnType<typeof setTimeout> }> = [];
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => Promise<void>, delay: number) => {
        const timer = originalTimeout(callback, delay);
        if (delay === RUNTIME_LIMITS_TTL_MS) timers.push({ callback, timer });
        return timer;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout"), warning = spyOn(console, "warn").mockImplementation(() => {});
    let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
    installRuntimeLimits({ upload: 1 });
    let finish!: () => void;
    const active = withRuntimeConcurrency("upload", () => new Promise<void>((resolve) => { finish = resolve; }));
    let started = false;
    const waiting = withRuntimeConcurrency("upload", async () => { started = true; }).catch((e) => e);
    try {
        await tick(); expect(timers).toHaveLength(1);
        let reads = 0;
        apiClient.defaults.adapter = async (config) => { expect(config.url).toBe("/auth/session"); reads++; throw new Error("offline"); };
        now += RUNTIME_LIMITS_TTL_MS;
        clearTimeout(timers[0].timer); await timers[0].callback();
        expect((await waiting).message).toContain("系统并发策略");
        expect(useUserStore.getState().runtimeLimitsError).toContain("系统并发策略");
        expect(started).toBe(false); expect(reads).toBe(1);
        for (const timer of timers.slice(1)) expect(clear).toHaveBeenCalledWith(timer.timer);
        finish(); await active;
    } finally {
        finish?.(); timers.forEach(({ timer }) => clearTimeout(timer));
        timeout.mockRestore(); clear.mockRestore(); clock.mockRestore(); warning.mockRestore();
    }
});

test("queued work cannot survive a logout/login cycle even when the account ID repeats", async () => {
    installRuntimeLimits({ upload: 1 });
    let finish!: () => void;
    const active = withRuntimeConcurrency("upload", () => new Promise<void>((resolve) => { finish = resolve; }));
    let started = false;
    const waiting = withRuntimeConcurrency("upload", async () => { started = true; }).catch((e) => e);
    await tick();
    const limits = useUserStore.getState().runtimeLimits;
    apiClient.defaults.adapter = async (config) => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 0, data: { user: null, runtimeLimits: limits } } });
    useUserStore.getState().setUser({ id: "temporary", username: "temporary", displayName: "temporary", role: "user", status: "active" });
    useUserStore.getState().setUser(null);
    installRuntimeLimits(); finish(); await active;
    expect((await waiting).message).toMatch(/账号|策略/); expect(started).toBe(false);
});
