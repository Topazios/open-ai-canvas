import { canvasContentHash } from "@/lib/canvas/canvas-content";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const key = (id: string) => `infinite-canvas:sync-baseline:${id}`;

// One acknowledged ancestor per canvas, separate from the mutable offline draft.
export async function persistCanvasSyncBaseline(project: CanvasProject, scope: string) {
    await localForageStorageForScope(scope).setItem(key(project.id), JSON.stringify(project));
}

export async function readCanvasSyncBaseline(local: CanvasProject, scope: string) {
    const raw = await localForageStorageForScope(scope).getItem(key(local.id));
    if (!raw) return undefined;
    const project = JSON.parse(raw) as CanvasProject;
    if (project.id !== local.id || project.revision !== local.revision || !local.remoteContentHash) return undefined;
    return await canvasContentHash(project) === local.remoteContentHash ? project : undefined;
}
