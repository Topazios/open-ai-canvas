import { http } from "@/services/api/request";
import { useUserStore, type RuntimeConcurrency, type RuntimeLimits } from "@/stores/use-user-store";

export const RUNTIME_LIMITS_TTL_MS = 15_000;
const keys: Array<keyof RuntimeConcurrency> = ["image", "text", "agent", "video", "audio", "other", "channel", "customRelay", "imagePreparation", "resourceDownload", "upload", "mediaRecovery", "agentSessions"];
export type ResolvedRuntimeLimits = RuntimeLimits & { concurrency: RuntimeConcurrency };
let pending: Promise<ResolvedRuntimeLimits> | undefined;
let revision = 0;
let sessionRevision = 0;
let retryAt = 0;
const waitingQueues = new Set<object>();
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

/** One timer serves all waiting queues, including image preparation. Active work alone never polls. */
export function setRuntimeLimitsQueueWaiting(owner: object, waiting: boolean) {
    if (waiting) waitingQueues.add(owner); else waitingQueues.delete(owner);
    if (!waitingQueues.size && refreshTimer !== undefined) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
    }
    if (waitingQueues.size && refreshTimer === undefined) {
        refreshTimer = setTimeout(async () => {
            refreshTimer = undefined;
            try { await readRuntimeLimits(); }
            catch (error) { console.warn("等待队列读取系统并发策略失败", error); }
            finally { setRuntimeLimitsQueueWaiting(owner, waitingQueues.has(owner)); }
        }, RUNTIME_LIMITS_TTL_MS);
    }
}

export class RuntimeLimitsError extends Error {
    constructor(message = "系统并发策略读取失败，已暂停新增任务，请稍后重试", options?: ErrorOptions) {
        super(message, options);
        this.name = "RuntimeLimitsError";
    }
}

export function validRuntimeLimits(limits?: RuntimeLimits): limits is ResolvedRuntimeLimits {
    return !!limits && Number.isSafeInteger(limits.activeTaskLimit) && limits.activeTaskLimit >= 0 &&
        !!limits.concurrency && keys.every((key) => Number.isSafeInteger(limits.concurrency![key]) && limits.concurrency![key] > 0);
}

export function freshRuntimeLimits(): ResolvedRuntimeLimits | undefined {
    const state = useUserStore.getState();
    if (!state.runtimeLimitsError && state.runtimeLimitsUpdatedAt > 0 && Date.now() - state.runtimeLimitsUpdatedAt < RUNTIME_LIMITS_TTL_MS && validRuntimeLimits(state.runtimeLimits)) return state.runtimeLimits;
}

export function invalidateRuntimeLimits() {
    revision++;
    pending = undefined;
    retryAt = 0;
    useUserStore.setState({ runtimeLimitsUpdatedAt: 0 });
}

useUserStore.subscribe((state, previous) => {
    if (state.user?.id !== previous.user?.id) { sessionRevision++; invalidateRuntimeLimits(); }
});

export function readRuntimeLimits(force = false): Promise<ResolvedRuntimeLimits> {
    if (force) invalidateRuntimeLimits();
    const fresh = freshRuntimeLimits();
    if (fresh) return Promise.resolve(fresh);
    if (pending) return pending;
    if (Date.now() < retryAt) return Promise.reject(new RuntimeLimitsError(useUserStore.getState().runtimeLimitsError));
    const requestRevision = revision;
    const userId = useUserStore.getState().user?.id;
    const request = http.get<{ user: { id: string } | null; runtimeLimits?: RuntimeLimits }>("/auth/session").then((payload) => {
        if (requestRevision !== revision || payload.user?.id !== userId) throw new RuntimeLimitsError("账号或系统策略已变化，请重新读取");
        if (!validRuntimeLimits(payload.runtimeLimits)) throw new RuntimeLimitsError("系统并发策略缺失或无效，已暂停新增任务");
        useUserStore.getState().setRuntimeLimits(payload.runtimeLimits);
        retryAt = 0;
        return payload.runtimeLimits;
    }).catch((cause: unknown) => {
        const error = cause instanceof RuntimeLimitsError ? cause : new RuntimeLimitsError(undefined, { cause });
        if (requestRevision === revision) {
            retryAt = Date.now() + 2_000;
            useUserStore.setState({ runtimeLimitsUpdatedAt: 0, runtimeLimitsError: error.message });
        }
        throw error;
    }).finally(() => { if (pending === request) pending = undefined; });
    pending = request;
    return request;
}

type Job = { run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void; sessionRevision: number; signal?: AbortSignal; abort: () => void };
type Pool = { active: number; pumping: boolean; queue: Job[] };
const pools = new Map<keyof RuntimeConcurrency, Pool>();

/** All callers of a category share its slots; every admission checks policy freshness. */
export function withRuntimeConcurrency<T>(kind: keyof RuntimeConcurrency, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException("已取消", "AbortError"));
    let pool = pools.get(kind);
    if (!pool) { pool = { active: 0, pumping: false, queue: [] }; pools.set(kind, pool); }
    const target = pool;
    return new Promise<T>((resolve, reject) => {
        const job: Job = { run, resolve: (value) => resolve(value as T), reject, sessionRevision, signal, abort: () => {} };
        job.abort = () => {
            const index = target.queue.indexOf(job);
            if (index >= 0) target.queue.splice(index, 1);
            setRuntimeLimitsQueueWaiting(target, target.queue.length > 0);
            signal?.removeEventListener("abort", job.abort);
            reject(new DOMException("已取消", "AbortError"));
        };
        signal?.addEventListener("abort", job.abort, { once: true });
        target.queue.push(job);
        setRuntimeLimitsQueueWaiting(target, true);
        void pump(kind, target);
    });
}

async function pump(kind: keyof RuntimeConcurrency, pool: Pool) {
    if (pool.pumping || !pool.queue.length) return;
    pool.pumping = true;
    try {
        await readRuntimeLimits();
        // Re-read after awaiting: a settings save or account switch may invalidate this response.
        const limits = freshRuntimeLimits();
        if (!limits) throw new RuntimeLimitsError();
        while (pool.active < limits.concurrency[kind] && pool.queue.length) {
            const job = pool.queue.shift()!;
            job.signal?.removeEventListener("abort", job.abort);
            if (job.sessionRevision !== sessionRevision) { job.reject(new RuntimeLimitsError("账号已切换，已取消等待任务")); continue; }
            if (job.signal?.aborted) { job.abort(); continue; }
            pool.active++;
            void Promise.resolve().then(() => {
                if (job.sessionRevision !== sessionRevision) throw new RuntimeLimitsError("账号已切换，已取消等待任务");
                if (job.signal?.aborted) throw new DOMException("已取消", "AbortError");
                return job.run();
            }).then(job.resolve, job.reject).finally(() => { pool.active--; void pump(kind, pool); });
        }
    } catch (error) {
        for (const job of pool.queue.splice(0)) { job.signal?.removeEventListener("abort", job.abort); job.reject(error); }
    } finally { pool.pumping = false; setRuntimeLimitsQueueWaiting(pool, pool.queue.length > 0); }
}

useUserStore.subscribe((state, previous) => {
    if (state.runtimeLimits !== previous.runtimeLimits || state.runtimeLimitsUpdatedAt !== previous.runtimeLimitsUpdatedAt || state.runtimeLimitsError !== previous.runtimeLimitsError || state.user?.id !== previous.user?.id) {
        for (const [kind, pool] of pools) void pump(kind, pool);
    }
});
