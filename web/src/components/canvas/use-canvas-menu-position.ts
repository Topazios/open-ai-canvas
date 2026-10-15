import { useLayoutEffect, useRef, useState } from "react";
import { getCanvasMenuLayout } from "@/lib/canvas/canvas-menu-position";

function readViewport() {
    const viewport = window.visualViewport;
    return { width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight, left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0 };
}

export function useCanvasMenuPosition(anchor: { left: number; top: number }, width: number, parentWidth?: number) {
    const ref = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState(() => getCanvasMenuLayout(anchor, { width, height: 0 }, typeof window === "undefined" ? { width: 1440, height: 900 } : readViewport(), parentWidth));
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        const update = () => {
            const next = getCanvasMenuLayout(anchor, { width, height: element.offsetHeight }, readViewport(), parentWidth);
            setPosition((current) => current.left === next.left && current.top === next.top && current.width === next.width && current.maxHeight === next.maxHeight ? current : next);
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(element);
        window.addEventListener("resize", update);
        const viewport = window.visualViewport;
        viewport?.addEventListener("resize", update);
        viewport?.addEventListener("scroll", update);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", update);
            viewport?.removeEventListener("resize", update);
            viewport?.removeEventListener("scroll", update);
        };
    }, [anchor.left, anchor.top, parentWidth, width]);
    return { ref, position };
}
