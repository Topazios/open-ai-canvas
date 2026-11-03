import { expect, test } from "bun:test";
import { ApiError } from "../src/services/api/request";
import { isCanvasVersionConflict, retryCanvasAssetSyncAfterRateLimit } from "../src/services/project-asset-sync";

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

test("asset sync retries a canvas version conflict instead of failing", async () => {
    let attempts = 0;
    const result = await retryCanvasAssetSyncAfterRateLimit(async () => {
        attempts += 1;
        if (attempts < 2) throw new ApiError("云端画布已有更新，已停止覆盖", { status: 409 });
        return "saved";
    }, { wait: async () => undefined });

    expect(result).toBe("saved");
    expect(attempts).toBe(2);
});

test("canvas version conflict detection ignores missing history resources", () => {
    expect(isCanvasVersionConflict(new ApiError("x", { status: 409 }))).toBe(true);
    expect(isCanvasVersionConflict(new ApiError("x", { status: 428 }))).toBe(true);
    expect(isCanvasVersionConflict(new ApiError("x", { status: 409, reason: "canvas_history_resources_missing" }))).toBe(false);
    expect(isCanvasVersionConflict(new Error("x"))).toBe(false);
});