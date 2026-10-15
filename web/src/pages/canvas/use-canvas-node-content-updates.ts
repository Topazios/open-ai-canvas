import { useCallback, useLayoutEffect, useMemo, type MutableRefObject } from "react";

import { createCanvasStateWriter } from "@/lib/canvas/canvas-editor-state";
import { updateCanvasNode, updateCanvasNodes } from "@/lib/canvas/canvas-node-timestamps";
import type { CanvasNodeData } from "@/types/canvas";

type NodeUpdate = (node: CanvasNodeData) => CanvasNodeData;

/** Content callbacks share the editor's synchronous state, with a canvas-owned measurement queue. */
export function useCanvasNodeContentUpdates(projectId: string, nodesRef: MutableRefObject<CanvasNodeData[]>, publish: (nodes: CanvasNodeData[]) => void) {
    const write = useMemo(() => createCanvasStateWriter(nodesRef, publish), [nodesRef, publish]);
    const queue = useMemo(() => ({ active: false, updates: new Map<string, NodeUpdate>(), timer: null as ReturnType<typeof setTimeout> | null }), [projectId]);
    useLayoutEffect(() => {
        queue.active = true;
        return () => {
            queue.active = false;
            if (queue.timer !== null) clearTimeout(queue.timer);
            queue.timer = null;
            queue.updates.clear();
        };
    }, [queue]);

    const updateNode = useCallback((nodeId: string, update: NodeUpdate) => {
        if (queue.active) write((current) => updateCanvasNode(current, nodeId, update));
    }, [queue, write]);
    const updateMediaNode = useCallback((nodeId: string, update: NodeUpdate) => {
        if (!queue.active) return;
        const previous = queue.updates.get(nodeId);
        queue.updates.set(nodeId, previous ? (node) => update(previous(node)) : update);
        if (queue.timer !== null) return;
        queue.timer = setTimeout(() => {
            queue.timer = null;
            if (!queue.active || !queue.updates.size) return;
            const updates = new Map(queue.updates);
            queue.updates.clear();
            write((current) => updateCanvasNodes(current, updates));
        }, 120);
    }, [queue, write]);
    return { updateNode, updateMediaNode };
}
