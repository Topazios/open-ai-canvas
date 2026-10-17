import { getActiveUserScope } from "@/lib/user-scope";
import { freshRuntimeLimits, readRuntimeLimits, setRuntimeLimitsQueueWaiting } from "@/services/runtime-limits";
import { useUserStore } from "@/stores/use-user-store";

const IMAGE_PREPARATION_TIMEOUT_MS = 60_000;

type ImageConsumer = {
    signal: AbortSignal;
    resolve: (image: HTMLImageElement) => void;
    reject: (error: unknown) => void;
    onAbort: () => void;
    timeoutMs: number;
    timeout?: ReturnType<typeof setTimeout>;
};
type ImagePreparationJob = {
    key: string;
    src: string;
    consumers: Set<ImageConsumer>;
    started: boolean;
    settled: boolean;
    decoding: boolean;
    image?: HTMLImageElement;
};

const inFlight = new Map<string, ImagePreparationJob>();
const queue: ImagePreparationJob[] = [];
let activePreparations = 0;
let pumping = false;
let refreshing = false;

useUserStore.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) {
        for (const job of [...inFlight.values()]) settle(job, undefined, abortError());
    }
    if (state.runtimeLimits !== previous.runtimeLimits || state.runtimeLimitsUpdatedAt !== previous.runtimeLimitsUpdatedAt || state.runtimeLimitsError !== previous.runtimeLimitsError) pump();
});

/** Share only in-flight decode work in the same account. Each caller owns its cancellation/deadline. */
export function prepareCanvasImage(src: string, signal: AbortSignal, timeoutMs = IMAGE_PREPARATION_TIMEOUT_MS): Promise<HTMLImageElement> {
    if (signal.aborted) return Promise.reject(abortError());
    const key = `${getActiveUserScope()}\0${src}`;
    let job = inFlight.get(key);
    if (!job) {
        job = { key, src, consumers: new Set(), started: false, settled: false, decoding: false };
        inFlight.set(key, job);
        queue.push(job);
        setRuntimeLimitsQueueWaiting(queue, true);
    }
    const target = job;
    return new Promise((resolve, reject) => {
        const consumer: ImageConsumer = { signal, resolve, reject, onAbort: () => {}, timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : IMAGE_PREPARATION_TIMEOUT_MS };
        consumer.onAbort = () => releaseConsumer(target, consumer, abortError());
        target.consumers.add(consumer);
        signal.addEventListener("abort", consumer.onAbort, { once: true });
        if (target.started) startDeadline(target, consumer);
        pump();
    });
}

export function canvasImagePreparationStats() {
    return { active: activePreparations, queued: queue.length, limit: freshRuntimeLimits()?.concurrency.imagePreparation, consumers: [...inFlight.values()].reduce((sum, job) => sum + job.consumers.size, 0) };
}

function startDeadline(job: ImagePreparationJob, consumer: ImageConsumer) {
    consumer.timeout = setTimeout(() => releaseConsumer(job, consumer, new Error("图片加载或解码超时")), consumer.timeoutMs);
}

function cleanupConsumer(consumer: ImageConsumer) {
    consumer.signal.removeEventListener("abort", consumer.onAbort);
    if (consumer.timeout !== undefined) clearTimeout(consumer.timeout);
}

function releaseConsumer(job: ImagePreparationJob, consumer: ImageConsumer, error: unknown) {
    if (!job.consumers.delete(consumer)) return;
    cleanupConsumer(consumer);
    consumer.reject(error);
    if (!job.consumers.size) settle(job, undefined, error);
}

function pump() {
    if (pumping || refreshing || !queue.length) return;
    const limits = freshRuntimeLimits();
    if (!limits) {
        refreshing = true;
        void readRuntimeLimits().catch((error) => {
            for (const job of [...queue]) settle(job, undefined, error);
        }).finally(() => { refreshing = false; pump(); });
        return;
    }
    pumping = true;
    try {
        while (activePreparations < limits.concurrency.imagePreparation && queue.length) {
            const job = queue.shift()!;
            if (job.settled) continue;
            if (!job.key.startsWith(`${getActiveUserScope()}\0`)) { settle(job, undefined, abortError()); continue; }
            job.started = true;
            activePreparations += 1;
            job.consumers.forEach((consumer) => startDeadline(job, consumer));
            try {
                const image = new Image();
                job.image = image;
                image.decoding = "async";
                image.onload = () => {
                    if (job.settled || job.decoding) return;
                    job.decoding = true;
                    try {
                        void image.decode().then(() => settle(job, image), (error) => settle(job, undefined, error));
                    } catch (error) { settle(job, undefined, error); }
                };
                image.onerror = () => settle(job, undefined, new Error("图片加载失败"));
                image.src = job.src;
                if (image.complete && image.naturalWidth > 0) image.onload?.call(image, new Event("load"));
            } catch (error) { settle(job, undefined, error); }
        }
    } finally { pumping = false; setRuntimeLimitsQueueWaiting(queue, queue.length > 0); }
}

function settle(job: ImagePreparationJob, image?: HTMLImageElement, error?: unknown) {
    if (job.settled) return;
    job.settled = true;
    if (inFlight.get(job.key) === job) inFlight.delete(job.key);
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    setRuntimeLimitsQueueWaiting(queue, queue.length > 0);
    if (job.image) {
        job.image.onload = null;
        job.image.onerror = null;
        if (!image) job.image.removeAttribute("src");
    }
    if (job.started) activePreparations -= 1;
    job.consumers.forEach((consumer) => {
        cleanupConsumer(consumer);
        if (image) consumer.resolve(image);
        else consumer.reject(error ?? new Error("图片准备未完成"));
    });
    job.consumers.clear();
    job.image = undefined;
    pump();
}

function abortError() {
    return new DOMException("图片准备已取消", "AbortError");
}
