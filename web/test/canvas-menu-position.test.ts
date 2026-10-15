import { expect, test } from "bun:test";
import { getCanvasMenuLayout } from "../src/lib/canvas/canvas-menu-position";

test("bottom context menu uses actual content height instead of the old estimate", () => {
    expect(getCanvasMenuLayout({ left: 1410, top: 860 }, { width: 224, height: 312 }, { width: 1440, height: 1000 })).toEqual({ left: 1204, top: 676, width: 224, maxHeight: 920 });
});

test("submenu flips left and fits its own taller content", () => {
    const result = getCanvasMenuLayout({ left: 1204, top: 676 }, { width: 360, height: 400 }, { width: 1440, height: 1000 }, 224);
    expect(result.left).toBe(836);
    expect(result.top).toBe(588);
});

test("submenu uses the right side when space is available", () => {
    expect(getCanvasMenuLayout({ left: 100, top: 100 }, { width: 360, height: 400 }, { width: 1440, height: 1000 }, 224).left).toBe(332);
});

test("short windows cap menu height below the header and leave room for scrolling", () => {
    const result = getCanvasMenuLayout({ left: 540, top: 360 }, { width: 224, height: 495 }, { width: 800, height: 360 });
    expect(result.top).toBe(68);
    expect(result.maxHeight).toBe(280);
    expect(result.top + result.maxHeight).toBe(348);
});

test("narrow visible viewports constrain width and preserve visual viewport offsets", () => {
    const result = getCanvasMenuLayout({ left: 900, top: 900 }, { width: 360, height: 400 }, { left: 80, top: 120, width: 300, height: 360 });
    expect(result).toEqual({ left: 92, top: 188, width: 276, maxHeight: 280 });
});

test("all requested corners stay inside feasible desktop and compact viewport bounds", () => {
    for (const width of [320, 800, 1440]) for (const height of [220, 360, 1000]) {
        for (const left of [-100, 0, width / 2, width + 100]) for (const top of [-100, 0, height / 2, height + 100]) {
            for (const menuHeight of [84, 312, 495, 900]) {
                const result = getCanvasMenuLayout({ left, top }, { width: 360, height: menuHeight }, { width, height });
                expect(result.left).toBeGreaterThanOrEqual(12);
                expect(result.left + result.width).toBeLessThanOrEqual(width - 12);
                expect(result.top).toBeGreaterThanOrEqual(68);
                expect(result.top + Math.min(menuHeight, result.maxHeight)).toBeLessThanOrEqual(height - 12);
            }
        }
    }
});
