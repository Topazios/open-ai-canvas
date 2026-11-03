import { nanoid } from "nanoid";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { sameCanvasContent } from "@/lib/canvas/canvas-content";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export type CanvasSyncDraft = { id: string; savedAt: string; project: CanvasProject };
const draftKey = (projectId: string) => `infinite-canvas:sync-drafts:${projectId}`;
const draftIndexKey = "infinite-canvas:sync-draft-index";
// 同一画布只保留最近的若干份草稿。内容每变一次就会产生一份，不设上限会无限累积。
export const MAX_CANVAS_SYNC_DRAFTS_PER_PROJECT = 20;

export async function readAllCanvasSyncDrafts(scope = getActiveUserScope()) {
    const raw = await localForageStorageForScope(scope).getItem(draftIndexKey);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    return (await Promise.all(ids.map((id) => readCanvasSyncDrafts(id, scope)))).flat();
}

export async function readCanvasSyncDrafts(projectId: string, scope = getActiveUserScope()): Promise<CanvasSyncDraft[]> {
    const raw = await localForageStorageForScope(scope).getItem(draftKey(projectId));
    return raw ? JSON.parse(raw) : [];
}

/** Caller holds the scope's canvas storage lock, including during media cleanup. */
export async function preserveCanvasSyncDraftLocked(project: CanvasProject, scope: string) {
    const snapshot = structuredClone(project);
    const drafts = await readCanvasSyncDrafts(snapshot.id, scope);
    const storage = localForageStorageForScope(scope);
    if (!drafts.some((draft) => sameCanvasContent(draft.project, snapshot))) {
        const rawIndex = await storage.getItem(draftIndexKey);
        const ids: string[] = rawIndex ? JSON.parse(rawIndex) : [];
        if (!ids.includes(snapshot.id)) await storage.setItem(draftIndexKey, JSON.stringify([...ids, snapshot.id]));
        drafts.push({ id: nanoid(), savedAt: new Date().toISOString(), project: snapshot });
        if (drafts.length > MAX_CANVAS_SYNC_DRAFTS_PER_PROJECT) drafts.splice(0, drafts.length - MAX_CANVAS_SYNC_DRAFTS_PER_PROJECT);
        await storage.setItem(draftKey(snapshot.id), JSON.stringify(drafts));
    } else if (drafts.length > MAX_CANVAS_SYNC_DRAFTS_PER_PROJECT) {
        // 历史上已累积超量的草稿,在内容重复时也顺带裁剪。
        drafts.splice(0, drafts.length - MAX_CANVAS_SYNC_DRAFTS_PER_PROJECT);
        await storage.setItem(draftKey(snapshot.id), JSON.stringify(drafts));
    }
    return drafts.length;
}
