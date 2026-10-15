import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope, isUserScopedPersistenceSuppressed } from "@/lib/user-scope";
import { nanoid } from "nanoid";
import type { TimelineProject } from "@/types/timeline";

export function projectEditorTimelineKey(projectId: string, unitId?: string) {
    return `editor-timeline:${unitId ? `${projectId}:unit:${unitId}` : projectId}`;
}

const writes = new Map<string, Promise<void>>();

// 时间线保存与审片确认使用同一把锁，防止确认过程中另一个标签页改写输入。
export function withProjectEditorStorageLock<T>(scope: string, projectId: string, unitId: string | undefined, operation: () => Promise<T>, requireCrossTabLock = false): Promise<T> {
    const key = JSON.stringify(["project-editor", scope, projectId, unitId || ""]);
    const previous = writes.get(key) || Promise.resolve();
    const pending = previous.then(async () => {
        if (typeof navigator !== "undefined" && navigator.locks) return navigator.locks.request(key, operation);
        if (requireCrossTabLock && typeof document !== "undefined") throw new Error("当前浏览器无法锁定审片版本，请使用支持跨标签存储锁的浏览器");
        return operation();
    });
    const tail = pending.then(() => undefined, () => undefined);
    writes.set(key, tail);
    void tail.finally(() => { if (writes.get(key) === tail) writes.delete(key); });
    return pending;
}

function checkedTimeline(value: TimelineProject): TimelineProject {
    if (!value || value.version !== 2 || !Array.isArray(value.tracks) || !Array.isArray(value.clips) || !Number.isFinite(value.durationMs)) {
        throw new Error("当前集时间线记录无效，请返回剪辑器检查并保存");
    }
    return value;
}

type LegacyTimelineAssignment = { version: 1; projectId: string; unitId: string; assignedAt: string; snapshot: TimelineProject };
const assignmentKey = (projectId: string) => `editor-timeline:${projectId}:assignment`;

async function readAssignment(projectId: string, scope: string): Promise<LegacyTimelineAssignment | null> {
    const raw = await localForageStorageForScope(scope).getItem(assignmentKey(projectId));
    if (!raw) return null;
    const value = JSON.parse(raw) as LegacyTimelineAssignment;
    if (!value || value.version !== 1 || value.projectId !== projectId || typeof value.unitId !== "string" || !value.unitId || typeof value.assignedAt !== "string") throw new Error("旧剪辑归属记录无效，原记录已保留");
    checkedTimeline(value.snapshot);
    return value;
}

export function projectTimelineVersion(timeline: TimelineProject | null): string | null {
    return timeline ? JSON.stringify(timeline) : null;
}

export async function loadProjectEditorTimeline(projectId: string, unitId: string | undefined, scope = getActiveUserScope()): Promise<TimelineProject | null> {
    const raw = await localForageStorageForScope(scope).getItem(projectEditorTimelineKey(projectId, unitId));
    if (raw) return checkedTimeline(JSON.parse(raw));
    if (!unitId) return null;
    const assignment = await readAssignment(projectId, scope);
    return assignment?.unitId === unitId ? assignment.snapshot : null;
}

export async function previewLegacyProjectTimeline(projectId: string, scope = getActiveUserScope()) {
    return withProjectEditorStorageLock(scope, projectId, undefined, async () => {
        const source = await loadProjectEditorTimeline(projectId, undefined, scope);
        const assignment = await readAssignment(projectId, scope);
        return { source, assignedUnitId: assignment?.unitId };
    });
}

export async function assignLegacyProjectTimeline(projectId: string, unitId: string, expectedSource: TimelineProject, scope = getActiveUserScope()) {
    if (!projectId || !unitId) throw new Error("请选择旧剪辑的目标集数");
    return withProjectEditorStorageLock(scope, projectId, undefined, () => withProjectEditorStorageLock(scope, projectId, unitId, async () => {
        const assignment = await readAssignment(projectId, scope);
        if (assignment) {
            if (assignment.unitId !== unitId) throw new Error("旧项目剪辑已归属其他集，不会重复复制；请刷新预览");
            return (await loadProjectEditorTimeline(projectId, unitId, scope))!;
        }
        const source = await loadProjectEditorTimeline(projectId, undefined, scope);
        if (!source?.clips.length || projectTimelineVersion(source) !== projectTimelineVersion(expectedSource)) throw new Error("旧项目剪辑已变化，请刷新预览后再确认");
        if (source.clips.some((clip) => [clip.shotSource, clip.voiceSource].some((reference) => reference && (reference.projectId !== projectId || reference.unitId !== unitId)))) throw new Error("旧剪辑包含其他项目或集数的镜头来源，请核对目标集数");
        if (await loadProjectEditorTimeline(projectId, unitId, scope)) throw new Error("目标集已有剪辑，归属操作未覆盖现有内容");
        // Commit ownership and the recoverable snapshot together. No multi-key half migration.
        const next: LegacyTimelineAssignment = { version: 1, projectId, unitId, assignedAt: new Date().toISOString(), snapshot: source };
        await localForageStorageForScope(scope).setItem(assignmentKey(projectId), JSON.stringify(next));
        return source;
    }, true), true);
}

export type ProjectTimelineDraft = {
    version: 1; id: string; revision: string; projectId: string; unitId?: string; savedAt: string;
    reason: "save-failed" | "before-recovery"; snapshot: TimelineProject;
};
const draftsKey = (projectId: string, unitId?: string) => `${projectEditorTimelineKey(projectId, unitId)}:drafts`;

// Callers hold the timeline lock; each editor session only replaces its own draft.
async function readDrafts(projectId: string, unitId: string | undefined, scope: string): Promise<ProjectTimelineDraft[]> {
    const raw = await localForageStorageForScope(scope).getItem(draftsKey(projectId, unitId));
    if (!raw) return [];
    const drafts = JSON.parse(raw) as ProjectTimelineDraft[];
    if (!Array.isArray(drafts) || drafts.some((draft) => !draft || draft.version !== 1 || draft.projectId !== projectId || draft.unitId !== unitId || !draft.id || typeof draft.id !== "string" || typeof draft.revision !== "string" || !draft.revision || typeof draft.savedAt !== "string" || !Number.isFinite(Date.parse(draft.savedAt)) || !["save-failed", "before-recovery"].includes(draft.reason))) throw new Error("本机剪辑草稿记录无效，原记录已保留");
    drafts.forEach((draft) => checkedTimeline(draft.snapshot));
    return drafts;
}

function writeDrafts(projectId: string, unitId: string | undefined, scope: string, drafts: ProjectTimelineDraft[]) {
    if (isUserScopedPersistenceSuppressed()) throw new Error("当前账号正在切换，暂不能写入剪辑草稿");
    return localForageStorageForScope(scope).setItem(draftsKey(projectId, unitId), JSON.stringify(drafts));
}

export function loadProjectTimelineDrafts(projectId: string, unitId: string | undefined, scope = getActiveUserScope()) {
    return withProjectEditorStorageLock(scope, projectId, unitId, () => readDrafts(projectId, unitId, scope));
}

export function saveProjectEditorTimeline(projectId: string, unitId: string | undefined, timeline: TimelineProject, scope = getActiveUserScope(), options?: { expectedVersion: string | null; draftId?: string }) {
    return withProjectEditorStorageLock(scope, projectId, unitId, async () => {
        checkedTimeline(timeline);
        try {
            if (isUserScopedPersistenceSuppressed()) throw new Error("当前账号正在切换，暂不能保存剪辑");
            const currentVersion = options ? projectTimelineVersion(await loadProjectEditorTimeline(projectId, unitId, scope)) : undefined;
            // An acknowledged retry of the exact committed snapshot is safe after a storage acknowledgement failure.
            if (options && currentVersion !== options.expectedVersion && currentVersion !== projectTimelineVersion(timeline)) throw new Error("时间线已在其他页面更新，本次保存未覆盖新版本");
            await localForageStorageForScope(scope).setItem(projectEditorTimelineKey(projectId, unitId), JSON.stringify(timeline));
        } catch (error) {
            if (!options?.draftId) throw error;
            const message = error instanceof Error ? error.message : String(error);
            try {
                const drafts = await readDrafts(projectId, unitId, scope);
                const draft: ProjectTimelineDraft = { version: 1, id: options.draftId, revision: nanoid(), projectId, unitId, savedAt: new Date().toISOString(), reason: "save-failed", snapshot: timeline };
                await writeDrafts(projectId, unitId, scope, [...drafts.filter((item) => item.id !== draft.id), draft]);
            } catch (draftError) {
                throw new Error(`${message}；草稿写入也失败，刷新可能丢失当前修改：${draftError instanceof Error ? draftError.message : String(draftError)}`);
            }
            throw new Error(`${message}；修改已保留为本机草稿，重新进入剪辑器可恢复`);
        }
        if (options?.draftId) {
            try {
                const drafts = await readDrafts(projectId, unitId, scope);
                if (drafts.some((draft) => draft.id === options.draftId)) await writeDrafts(projectId, unitId, scope, drafts.filter((draft) => draft.id !== options.draftId));
            } catch {
                throw new Error("时间线已写入本机，但草稿清理失败，请重试保存");
            }
        }
    }, Boolean(options));
}

export function restoreProjectTimelineDraft(projectId: string, unitId: string | undefined, draft: Pick<ProjectTimelineDraft, "id" | "revision">, expectedVersion: string | null, scope = getActiveUserScope()) {
    return withProjectEditorStorageLock(scope, projectId, unitId, async () => {
        if (isUserScopedPersistenceSuppressed()) throw new Error("当前账号正在切换，暂不能恢复剪辑");
        const current = await loadProjectEditorTimeline(projectId, unitId, scope);
        if (projectTimelineVersion(current) !== expectedVersion) throw new Error("当前剪辑已变化，请刷新草稿预览后重新确认");
        const drafts = await readDrafts(projectId, unitId, scope);
        const selected = drafts.find((item) => item.id === draft.id && item.revision === draft.revision);
        if (!selected) throw new Error("所选草稿已变化或已处理，请刷新草稿预览");
        if (current && projectTimelineVersion(current) !== projectTimelineVersion(selected.snapshot) && !drafts.some((item) => item.reason === "before-recovery" && projectTimelineVersion(item.snapshot) === projectTimelineVersion(current))) {
            drafts.push({ version: 1, id: nanoid(), revision: nanoid(), projectId, unitId, savedAt: new Date().toISOString(), reason: "before-recovery", snapshot: current });
            // Preserve the displaced version before committing; a failed backup must never replace the current edit.
            await writeDrafts(projectId, unitId, scope, drafts);
        }
        await localForageStorageForScope(scope).setItem(projectEditorTimelineKey(projectId, unitId), JSON.stringify(selected.snapshot));
        try {
            await writeDrafts(projectId, unitId, scope, drafts.filter((item) => item.id !== selected.id));
        } catch {
            throw new Error("草稿已恢复到本机，但恢复列表更新失败，请刷新预览核对");
        }
        return selected.snapshot;
    }, true);
}
