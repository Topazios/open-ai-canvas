import { useEffect, type RefObject } from "react";
import { startCanvasPerformanceDiagnostics } from "@/lib/canvas/canvas-performance-diagnostics";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

export function useCanvasPerformanceDiagnostics(enabled: boolean, root: RefObject<HTMLDivElement | null>, nodes: RefObject<CanvasNodeData[]>, connections: RefObject<CanvasConnection[]>) {
    useEffect(() => {
        if (!enabled || !root.current) return;
        return startCanvasPerformanceDiagnostics(root.current, () => ({ nodes: nodes.current.length, connections: connections.current.length }));
    }, [enabled, root, nodes, connections]);
}
