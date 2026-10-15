import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { scopedLocalStorage } from "@/lib/user-scope";

const storageKey = "infinite-canvas:drama-guide-position";
type Point = { x: number; y: number };

export function useDramaGuidePosition(visible: boolean) {
    const panelRef = useRef<HTMLElement>(null);
    const [position, setPosition] = useState<Point | null>(() => {
        try {
            const saved = JSON.parse(scopedLocalStorage.getItem(storageKey) || "null");
            return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
        } catch { return null; }
    });
    const current = useRef(position);
    const drag = useRef<{ pointer: number; start: Point; origin: Point } | null>(null);
    const clamp = (point: Point): Point => {
        const panel = panelRef.current;
        const parent = panel?.offsetParent as HTMLElement | null;
        if (!panel || !parent) return point;
        return { x: Math.max(8, Math.min(point.x, parent.clientWidth - panel.offsetWidth - 8)), y: Math.max(8, Math.min(point.y, parent.clientHeight - panel.offsetHeight - 8)) };
    };
    const move = (point: Point, persist = false) => {
        const next = clamp(point);
        current.current = next; setPosition((old) => old?.x === next.x && old.y === next.y ? old : next);
        if (persist) try { scopedLocalStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Position is optional UI state. */ }
    };
    useLayoutEffect(() => {
        const panel = panelRef.current;
        const parent = panel?.offsetParent as HTMLElement | null;
        if (!visible || !panel || !parent) return;
        const fit = () => move(current.current || { x: panel.offsetLeft, y: panel.offsetTop });
        const cancel = () => { if (drag.current) { const origin = drag.current.origin; drag.current = null; move(origin); } };
        fit();
        const observer = new ResizeObserver(fit); observer.observe(parent); observer.observe(panel);
        window.addEventListener("blur", cancel);
        return () => { observer.disconnect(); window.removeEventListener("blur", cancel); drag.current = null; };
    }, [visible]);
    return { panelRef, position, handleProps: {
        onPointerDown(event: PointerEvent<HTMLButtonElement>) {
            if (event.button !== 0 || !current.current) return;
            event.preventDefault(); event.stopPropagation();
            drag.current = { pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: current.current };
            event.currentTarget.setPointerCapture(event.pointerId);
        },
        onPointerMove(event: PointerEvent<HTMLButtonElement>) {
            const active = drag.current;
            if (!active || active.pointer !== event.pointerId) return;
            move({ x: active.origin.x + event.clientX - active.start.x, y: active.origin.y + event.clientY - active.start.y });
        },
        onPointerUp(event: PointerEvent<HTMLButtonElement>) {
            if (drag.current?.pointer !== event.pointerId) return;
            drag.current = null;
            if (current.current) move(current.current, true);
            event.currentTarget.releasePointerCapture(event.pointerId);
        },
        onLostPointerCapture() { if (drag.current) { const origin = drag.current.origin; drag.current = null; move(origin); } },
        onPointerCancel() { if (drag.current) { const origin = drag.current.origin; drag.current = null; move(origin); } },
        onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
            if (!current.current) return;
            if (event.key === "Escape" && drag.current) { const origin = drag.current.origin; drag.current = null; move(origin); return; }
            const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
            if (!direction) return;
            event.preventDefault(); event.stopPropagation();
            move({ x: current.current.x + direction[0] * 20, y: current.current.y + direction[1] * 20 }, true);
        },
    } };
}
