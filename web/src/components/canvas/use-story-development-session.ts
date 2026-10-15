import { useEffect, useRef, useState } from "react";
import { getActiveUserScope } from "@/lib/user-scope";
import { createStorySessionStore, newStorySession, receiveStoryTask, recoverStorySession, storyJobActive, storyTaskMatches, type StorySession } from "@/services/story-development-session";
import { listGenerationTasks, queryGenerationTask } from "@/services/api/task-center";
import type { CanvasNodeData } from "@/types/canvas";

export function useStoryDevelopmentSession(node: CanvasNodeData, canvasId: string, model: string) {
    const [scope] = useState(getActiveUserScope);
    const [store] = useState(() => createStorySessionStore(scope, canvasId, node.id));
    const [session, setSession] = useState(() => newStorySession(node, model));
    const current = useRef(session);
    const revision = useRef(0);
    const queue = useRef<Promise<void>>(Promise.resolve());
    const alive = useRef(false);
    const [ready, setReady] = useState(false);
    const [storageError, setStorageError] = useState("");
    const [syncError, setSyncError] = useState("");
    const [persisting, setPersisting] = useState(false);
    const serial = useRef(0);

    const persist = (value: StorySession) => {
        const token = ++serial.current;
        setPersisting(true);
        const write = queue.current.then(async () => {
            revision.current = await store.write(value, revision.current);
        });
        queue.current = write.catch(() => undefined);
        void write.then(() => {
            if (alive.current && token === serial.current) { setStorageError(""); setPersisting(false); }
        }, (error) => {
            if (alive.current) { setStorageError(error instanceof Error ? error.message : "本地草稿保存失败"); setPersisting(false); }
        });
        return write;
    };
    const update = (patch: Partial<StorySession>) => {
        if (!alive.current || getActiveUserScope() !== scope) return Promise.reject(new Error("创作会话已关闭或账号已切换"));
        current.current = { ...current.current, ...patch };
        setSession(current.current);
        return persist(current.current);
    };
    const updateRef = useRef(update);
    updateRef.current = update;

    useEffect(() => {
        alive.current = true;
        let cancelled = false;
        void store.read().then((saved) => {
            if (cancelled) return;
            revision.current = saved?.revision || 0;
            const value = recoverStorySession(saved, node, model);
            current.current = value; setSession(value); setReady(true);
            if (saved?.preview) void persist(value).catch(() => undefined);
        }).catch((error) => { if (alive.current) setStorageError(`无法读取本地草稿：${error instanceof Error ? error.message : "存储不可用"}`); });
        return () => { cancelled = true; alive.current = false; };
    }, [store]); // Node identity is the editor key; content changes are handled by save conflict checks.

    const operationId = session.job?.operationId;
    const active = storyJobActive(session.job);
    useEffect(() => {
        if (!ready || !active) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                if (getActiveUserScope() !== scope) return;
                const job = current.current.job;
                if (!job || job.operationId !== operationId || !storyJobActive(job)) return;
                if (job.status === "pending") return;
                let task;
                if (job.taskId) task = await queryGenerationTask(job.taskId, { signal: controller.signal });
                else {
                    const tasks = await listGenerationTasks(100, { projectId: canvasId }, undefined, controller.signal);
                    const matched = tasks.find((item) => storyTaskMatches(item, job.operationId));
                    if (matched) task = await queryGenerationTask(matched.id, { signal: controller.signal });
                }
                if (controller.signal.aborted || getActiveUserScope() !== scope) return;
                if (task) {
                    const next = receiveStoryTask(current.current, task);
                    if (next !== current.current) await updateRef.current(next);
                    setSyncError("");
                } else if (job.status === "unknown") setSyncError("提交结果待确认，暂未找到任务。请核对任务中心后再解除占用，避免重复生成。");
            } catch {
                if (!controller.signal.aborted) setSyncError("任务状态暂不可用，正在重新连接；后台任务未取消");
            } finally {
                if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2500);
            }
        };
        void poll();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [ready, active, operationId, canvasId, scope]);

    useEffect(() => {
        if (!persisting && !storageError) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [persisting, storageError]);

    const reload = async () => {
        await queue.current;
        const saved = await store.read();
        revision.current = saved?.revision || 0;
        current.current = recoverStorySession(saved, node, model);
        setSession(current.current); setStorageError(""); setReady(true);
        if (saved?.preview) await persist(current.current);
    };
    return { session, current, update, ready, storageError, syncError, persisting, reload, flush: () => persist(current.current) };
}
