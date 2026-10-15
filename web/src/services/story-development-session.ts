import { localForageStorageForScope } from "@/lib/localforage-storage";
import { parseStoryTopics, storyDocumentSignature } from "@/lib/canvas/canvas-story-development";
import { parseBackendGenerationResult } from "@/services/api/generation-task";
import type { GenerationTask, TaskStatus } from "@/services/api/task-center";
import type { CanvasNodeData, StoryDevelopmentData } from "@/types/canvas";

export type StoryPreview = { text: string; draft: string; signatures: Record<string, string>; topicCount?: number; error?: string };
type StoryRevision = Pick<StorySession, "content" | "data">;
export type StoryJob = {
    operationId: string;
    taskId?: string;
    status: TaskStatus | "pending" | "submitting" | "unknown";
    draw: boolean;
    topicCount: number;
    draft: string;
    signatures: Record<string, string>;
    error?: string;
    partialText?: string;
    batchOwnerNodeId?: string;
    appliedToCanvas?: boolean;
};
export type StoryEpisodeBatch = { id: string; items: Array<{ nodeId: string; episodeNumber: number; operationId: string }>; skipped: number[]; stopped?: boolean };
export type StorySession = {
    revision: number;
    baseSignature: string;
    title: string;
    content: string;
    data: StoryDevelopmentData;
    dirty: boolean;
    instruction: string;
    model: string;
    preview: StoryPreview | null;
    job: StoryJob | null;
    previousVersion?: StoryRevision;
    redoVersion?: StoryRevision;
    episodeBatch?: StoryEpisodeBatch;
    batchStart?: number;
    batchCount?: number;
};
export const storyDraftKey = (session: Pick<StorySession, "content" | "data">) => JSON.stringify([session.content, session.data]);
export const storyJobActive = (job: StoryJob | null) => Boolean(job && ["pending", "submitting", "unknown", "queued", "running"].includes(job.status));
export function newStorySession(node: CanvasNodeData, model: string): StorySession {
    return { revision: 0, baseSignature: storyDocumentSignature(node), title: node.title || "", content: node.metadata?.content || "", data: structuredClone(node.metadata!.storyDevelopment!), dirty: false, instruction: "", model, preview: null, job: null };
}

const storyRevision = (session: StorySession): StoryRevision => ({ content: session.content, data: structuredClone(session.data) });
export function applyStoryResult(session: StorySession, result: Pick<StoryPreview, "text" | "signatures" | "topicCount">): StorySession {
    if (!result.text.trim()) throw new Error("AI 未返回内容，原稿已保留");
    const data = result.topicCount !== undefined
        ? { ...session.data, candidates: parseStoryTopics(result.text, result.topicCount) }
        : { ...session.data, sourceSignatures: { ...result.signatures } };
    // Capture the latest draft, including edits made while the task was running.
    return { ...session, content: result.topicCount !== undefined ? session.content : result.text, data, previousVersion: storyRevision(session), redoVersion: undefined, dirty: true, preview: null };
}

export function restoreStoryRevision(session: StorySession, redo = false): StorySession {
    const version = redo ? session.redoVersion : session.previousVersion;
    if (!version || storyJobActive(session.job)) return session;
    return { ...session, ...structuredClone(version), previousVersion: redo ? storyRevision(session) : undefined, redoVersion: redo ? undefined : storyRevision(session), dirty: true };
}

export function recoverStorySession(saved: StorySession | null, node: CanvasNodeData, model: string): StorySession {
    const value = saved && (saved.dirty || saved.preview || storyJobActive(saved.job) || saved.baseSignature === storyDocumentSignature(node))
        ? saved : { ...newStorySession(node, model), instruction: saved?.instruction || "", model: saved?.model || model, job: saved?.job || null, episodeBatch: saved?.episodeBatch, batchStart: saved?.batchStart, batchCount: saved?.batchCount };
    const restored = value.job?.status === "submitting" ? { ...value, job: { ...value.job, status: "unknown" as const } } : value;
    if (!restored.preview) return restored;
    try { return applyStoryResult(restored, restored.preview); }
    catch (error) { return { ...restored, preview: { ...restored.preview, error: error instanceof Error ? error.message : "旧结果读取失败" } }; }
}

export function storyTaskMatches(task: GenerationTask, operationId: string) {
    if (task.clientContext?.clientOperationId === operationId) return true;
    // Task details retain sanitized metadata; list responses expose only safe IDs.
    try { return JSON.parse(task.inputJson || "{}").metadata?.clientOperationId === operationId; }
    catch { return false; }
}

export function receiveStoryTask(session: StorySession, task: GenerationTask): StorySession {
    const job = session.job;
    if (!job || (job.taskId && job.taskId !== task.id) || !storyJobActive(job)) return session;
    const next = { ...session, job: { ...job, taskId: task.id, status: task.status, error: task.error, partialText: task.textDraft || job.partialText } };
    if (task.status !== "succeeded") return JSON.stringify(next.job) === JSON.stringify(job) ? session : next;
    try {
        const text = parseBackendGenerationResult(task).text;
        if (!text?.trim()) throw new Error("AI 未返回内容，原稿已保留");
        next.job.partialText = undefined;
        return applyStoryResult(next, { text, signatures: job.signatures, ...(job.draw ? { topicCount: job.topicCount } : {}) });
    } catch (error) {
        next.job.status = "failed";
        next.job.partialText = task.textDraft || job.partialText;
        next.job.error = error instanceof Error ? error.message : "结果读取失败";
    }
    return next;
}

type Storage = { getItem(key: string): string | null | Promise<string | null>; setItem(key: string, value: string): unknown };
type Lock = <T>(key: string, action: () => Promise<T>) => Promise<T>;
const storageLock: Lock = (key, action) => {
    if (!navigator.locks) return Promise.reject(new Error("当前浏览器不支持安全草稿锁，请使用本机 Chrome"));
    return navigator.locks.request(key, action);
};

export function createStorySessionStore(scope: string, canvasId: string, nodeId: string, storage: Storage = localForageStorageForScope(scope), lock: Lock = storageLock) {
    const key = `story-development:${canvasId}:${nodeId}`;
    const read = async (): Promise<StorySession | null> => {
        const raw = await storage.getItem(key);
        return raw ? JSON.parse(raw) as StorySession : null;
    };
    return {
        read,
        write: (session: StorySession, expectedRevision: number) => lock(`${scope}:${key}`, async () => {
            const current = await read();
            if ((current?.revision || 0) !== expectedRevision) throw new Error("另一窗口已更新此步骤，请保留当前文本并关闭重开后合并");
            const saved = { ...session, revision: expectedRevision + 1 };
            await storage.setItem(key, JSON.stringify(saved));
            return saved.revision;
        }),
    };
}
