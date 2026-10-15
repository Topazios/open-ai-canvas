import { useEffect, useState, type RefObject } from "react";

// Selection is not editor ownership: a cell can keep focus while selection or
// the camera changes. Pin only its node, without writing document state.
export function useCanvasEditorFocus(projectId: string, containerRef: RefObject<HTMLElement | null>) {
    const [focused, setFocused] = useState<{ projectId: string; nodeId: string | null } | null>(null);
    useEffect(() => {
        let disposed = false;
        const update = () => {
            if (disposed) return;
            const element = document.activeElement;
            const editable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ||
                element instanceof HTMLSelectElement || (element instanceof HTMLElement && element.isContentEditable);
            const node = editable && containerRef.current?.contains(element) ? element.closest<HTMLElement>("[data-node-id]") : null;
            const nodeId = node?.dataset.nodeId || null;
            setFocused((current) => current?.projectId === projectId && current.nodeId === nodeId ? current : { projectId, nodeId });
        };
        const afterBlur = () => queueMicrotask(update);
        document.addEventListener("focusin", update);
        document.addEventListener("focusout", afterBlur);
        update();
        return () => {
            disposed = true;
            document.removeEventListener("focusin", update);
            document.removeEventListener("focusout", afterBlur);
        };
    }, [containerRef, projectId]);
    return focused?.projectId === projectId ? focused.nodeId : null;
}
