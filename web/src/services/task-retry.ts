import { ApiError } from "@/services/api/request";
import { retryGenerationTask } from "@/services/api/task-center";

export async function retryTaskWithBillingConfirmation(
    id: string,
    confirm: (message: string) => Promise<boolean>,
    retry = retryGenerationTask,
) {
    try {
        return await retry(id);
    } catch (error) {
        if (!(error instanceof ApiError) || error.reason !== "task_billing_review_required") throw error;
        const orderId = error.details?.billingOrderId;
        if (typeof orderId !== "string" || !orderId.trim()) throw error;
        if (!await confirm(error.message)) throw new DOMException("已取消重新生成", "AbortError");
        // Acknowledge this exact attempt only; never automatically repeat a paid call.
        return retry(id, orderId);
    }
}
