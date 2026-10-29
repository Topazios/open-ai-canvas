import { ApiError } from "@/services/api/request";

const retryDelaysMs = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

function retryableSaveError(error: unknown) {
    if (error instanceof ApiError) return error.retryable || [409, 428, 429].includes(error.status || 0);
    return false;
}

function waitForRetry(delay: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            error ? reject(error) : resolve();
        };
        const abort = () => finish(new DOMException("已取消", "AbortError"));
        const timer = setTimeout(() => finish(), delay);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
    });
}

export async function saveWorkflowCanvasUntilSynced(save: (options?: { quiet?: boolean }) => Promise<boolean>, signal: AbortSignal, onWaiting?: () => void) {
    for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw new DOMException("已取消", "AbortError");
        let saved = false;
        try {
            saved = await save({ quiet: true });
        } catch (error) {
            if (!retryableSaveError(error)) throw error;
        }
        if (signal.aborted) throw new DOMException("已取消", "AbortError");
        if (saved) return;
        onWaiting?.();
        await waitForRetry(retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)], signal);
    }
}
