import { expect, test } from "bun:test";
import { retryCanvasAssetSyncAfterRateLimit } from "../src/services/project-asset-sync";

test("canvas asset sync retries a transient local canvas update race", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await retryCanvasAssetSyncAfterRateLimit(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("画布仍在更新，已保留本地内容，请稍后再加载最新版本");
        return "saved";
    }, { wait: async (delayMs) => { delays.push(delayMs); } });

    expect(result).toBe("saved");
    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 500]);
});

test("asset sync does not retry non-transient failures", async () => {
    let attempts = 0;
    await expect(retryCanvasAssetSyncAfterRateLimit(async () => {
        attempts += 1;
        throw new Error("上游资源不可用");
    }, { wait: async () => undefined })).rejects.toThrow("上游资源不可用");

    expect(attempts).toBe(1);
});
