import { useLayoutEffect, useMemo, useRef } from "react";
import { reconcileCanvasArray, reconcileCanvasArrayMap } from "@/lib/canvas/canvas-render-reconciliation";

export function useCanvasDerivedArray<T>(next: T[], equal: (left: T, right: T) => boolean = Object.is) {
    const previous = useRef<T[] | undefined>(undefined);
    const result = useMemo(() => reconcileCanvasArray(previous.current, next, equal), [next, equal]);
    useLayoutEffect(() => { previous.current = result; }, [result]);
    return result;
}

export function useCanvasDerivedArrayMap<T>(next: Map<string, T[]>, equal: (left: T, right: T) => boolean = Object.is) {
    const previous = useRef<Map<string, T[]> | undefined>(undefined);
    const result = useMemo(() => reconcileCanvasArrayMap(previous.current, next, equal), [next, equal]);
    useLayoutEffect(() => { previous.current = result; }, [result]);
    return result;
}
