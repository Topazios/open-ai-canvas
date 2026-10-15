import { describe, expect, test } from "bun:test";
import { ApiError } from "../src/services/api/request";
import type { GenerationTask } from "../src/services/api/task-center";
import { retryTaskWithBillingConfirmation } from "../src/services/task-retry";

const task = { id: "image-task", status: "queued" } as GenerationTask;
const pending = () => new ApiError("原请求费用待核对，新请求单独记账", {
    status: 409, reason: "task_billing_review_required", details: { billingOrderId: "old-order" },
});

describe("image retry billing confirmation", () => {
    test("normal retry does not ask for confirmation", async () => {
        const result = await retryTaskWithBillingConfirmation(task.id, async () => { throw new Error("unexpected confirmation"); }, async () => task);
        expect(result).toBe(task);
    });
    test("cancel preserves original failure without submitting again", async () => {
        let calls = 0;
        await expect(retryTaskWithBillingConfirmation(task.id, async () => false, async () => { calls++; throw pending(); })).rejects.toMatchObject({ name: "AbortError" });
        expect(calls).toBe(1);
    });
    test("confirm resubmits once with exact original order", async () => {
        const calls: (string | undefined)[][] = [];
        const result = await retryTaskWithBillingConfirmation(task.id, async (message) => { expect(message).toContain("待核对"); return true; }, async (id, order) => {
            calls.push([id, order]);
            if (!order) throw pending();
            return task;
        });
        expect(result).toBe(task);
        expect(calls).toEqual([[task.id, undefined], [task.id, "old-order"]]);
    });
    test("a failed confirmed request never loops or repeats billing", async () => {
        let calls = 0;
        await expect(retryTaskWithBillingConfirmation(task.id, async () => true, async () => { calls++; throw pending(); })).rejects.toBeInstanceOf(ApiError);
        expect(calls).toBe(2);
    });
    test("ordinary errors and malformed confirmation responses do not bypass guards", async () => {
        for (const error of [new Error("network"), new ApiError("denied", { reason: "forbidden" }), new ApiError("missing order", { reason: "task_billing_review_required" })]) {
            await expect(retryTaskWithBillingConfirmation(task.id, async () => { throw new Error("unexpected confirmation"); }, async () => { throw error; })).rejects.toBe(error);
        }
    });
});
