type MenuViewport = { width: number; height: number; left?: number; top?: number };

/** Screen-space menus share the canvas header inset and keep all commands scroll-accessible. */
export function getCanvasMenuLayout(anchor: { left: number; top: number }, size: { width: number; height: number }, viewport: MenuViewport, parentWidth?: number) {
    const margin = Math.min(12, Math.max(0, viewport.width / 2), Math.max(0, viewport.height / 2));
    const leftEdge = (viewport.left ?? 0) + margin;
    const topEdge = (viewport.top ?? 0) + Math.min(68, Math.max(margin, viewport.height - margin * 2));
    const rightEdge = (viewport.left ?? 0) + viewport.width - margin;
    const bottomEdge = (viewport.top ?? 0) + viewport.height - margin;
    const width = Math.min(size.width, Math.max(0, rightEdge - leftEdge));
    const maxHeight = Math.max(0, bottomEdge - topEdge);
    const height = Math.min(size.height, maxHeight);
    let preferredLeft = anchor.left;
    if (parentWidth !== undefined) {
        const right = anchor.left + parentWidth + 8;
        preferredLeft = right + width <= rightEdge ? right : anchor.left - width - 8;
    }
    return {
        left: Math.min(Math.max(preferredLeft, leftEdge), Math.max(leftEdge, rightEdge - width)),
        top: Math.min(Math.max(anchor.top, topEdge), Math.max(topEdge, bottomEdge - height)),
        width,
        maxHeight,
    };
}
