import { getActiveUserScope } from "@/lib/user-scope";
import { withCanvasStorePersistenceLock, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { withGenerationArtifactCommitLock } from "@/services/generation-asset-repository";
import { preserveCanvasSyncDraftLocked } from "@/services/canvas-sync-draft-storage";
export { readAllCanvasSyncDrafts, readCanvasSyncDrafts, type CanvasSyncDraft } from "@/services/canvas-sync-draft-storage";

export async function preserveCanvasSyncDraft(project: CanvasProject, scope = getActiveUserScope()) {
    // A separate record survives replacement of the active canvas and a browser reload.
    const snapshot = structuredClone(project);
    return withGenerationArtifactCommitLock(scope, () =>
        withCanvasStorePersistenceLock(scope, () => preserveCanvasSyncDraftLocked(snapshot, scope)),
    );
}
