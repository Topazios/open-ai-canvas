import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listCanvasNodeShotLinks, type CanvasNodeShotLink } from "@/services/api/projects";
import { getActiveUserScope } from "@/lib/user-scope";
import type { CanvasShotBinding } from "@/lib/canvas/canvas-shot-projection";

export function useCanvasShotProjection(projectId: string, canvasId: string, fallbackLinks?: CanvasNodeShotLink[]) {
    const scope = getActiveUserScope();
    const owner = JSON.stringify([scope, projectId, canvasId]);
    const query = useQuery({
        queryKey: ["canvas-node-shot-links", scope, projectId, canvasId],
        queryFn: () => listCanvasNodeShotLinks(projectId, canvasId), enabled: Boolean(projectId && canvasId),
        refetchInterval: 15000, refetchIntervalInBackground: false, refetchOnWindowFocus: "always",
    });
    const previousBindings = useRef(new Map<string, CanvasShotBinding>());
    const bindings = useMemo(() => {
        const result = new Map<string, CanvasShotBinding>();
        if (!projectId) return result;
        const views = new Map(query.data?.views?.map((view) => [view.linkId, view]));
        for (const link of query.data?.links ?? fallbackLinks ?? []) {
            if (link.projectId === projectId && link.canvasId === canvasId) {
                const view = views.get(link.id);
                const unavailable = query.isError || !query.data;
                const previous = previousBindings.current.get(link.nodeId);
                result.set(link.nodeId, previous?.link === link && previous.view === view && previous.unavailable === unavailable ? previous : { link, view, unavailable });
            }
        }
        return result;
    }, [canvasId, projectId, fallbackLinks, query.data, query.isError]);
    useLayoutEffect(() => { previousBindings.current = bindings; }, [bindings]);
    const [originalViews, setOriginalViews] = useState<{ owner: string; ids: ReadonlySet<string> }>({ owner, ids: new Set() });
    const originalNodeIds = useMemo(() => originalViews.owner === owner ? originalViews.ids : new Set<string>(), [originalViews, owner]);
    const setOriginalView = useCallback((nodeId: string, original: boolean) => {
        setOriginalViews((previous) => {
            const ids = new Set(previous.owner === owner ? previous.ids : []);
            if (original) ids.add(nodeId); else ids.delete(nodeId);
            return { owner, ids };
        });
    }, [owner]);
    const refresh = useCallback(() => { void query.refetch(); }, [query.refetch]);
    return { bindings, originalNodeIds, setOriginalView, refresh };
}
