import { describe, expect, test } from "bun:test";

import { getAttachedNodePanelPosition, resolveCanvasOverlayScale } from "../src/components/canvas/canvas-workspace-overlays";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const node = {
    id: "node-1",
    type: CanvasNodeType.Image,
    title: "图片",
    position: { x: 100, y: 80 },
    width: 400,
    height: 300,
    metadata: {},
} as CanvasNodeData;

describe("canvas screen-space overlays", () => {
    test("never applies viewport scale to toolbar or panel controls", () => {
        expect(resolveCanvasOverlayScale(0.25, true)).toBe(1);
        expect(resolveCanvasOverlayScale(2.5, true)).toBe(1);
    });

    test("adds the canvas viewport offset exactly once for fixed panels", () => {
        const position = getAttachedNodePanelPosition(
            node,
            { x: 40, y: 30, k: 1 },
            { width: 1000, height: 700 },
            600,
            240,
            null,
            { left: 120, top: 64 },
        );
        expect(position.left).toBe(160);
        expect(position.top).toBe(64 + 420);
    });
});
