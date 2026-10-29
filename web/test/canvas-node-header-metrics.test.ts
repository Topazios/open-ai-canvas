import { describe, expect, test } from "bun:test";

import { groupStatusButtonsCompact, groupedHeaderMetrics, nodeActionBarMode } from "../src/lib/canvas/canvas-node-header-metrics";

describe("groupedHeaderMetrics", () => {
    test("非分组节点保持原行为", () => {
        expect(groupedHeaderMetrics({ scale: 0.35, nodeWidth: 280, grouped: false })).toEqual({ visible: true, k: 1, showMeta: true });
        expect(groupedHeaderMetrics({ scale: 0.3, nodeWidth: 280, grouped: false }).visible).toBe(false);
    });

    test("分组子节点标题随缩放变小", () => {
        expect(groupedHeaderMetrics({ scale: 1, nodeWidth: 280, grouped: true })).toEqual({ visible: true, k: 1, showMeta: true });
        expect(groupedHeaderMetrics({ scale: 2, nodeWidth: 280, grouped: true }).k).toBe(1);
        expect(groupedHeaderMetrics({ scale: 0.5, nodeWidth: 280, grouped: true })).toEqual({ visible: true, k: 0.5, showMeta: true });
    });

    test("分组子节点低于 0.5 时隐藏标题", () => {
        expect(groupedHeaderMetrics({ scale: 0.49, nodeWidth: 280, grouped: true }).visible).toBe(false);
        expect(groupedHeaderMetrics({ scale: 0.35, nodeWidth: 280, grouped: true }).visible).toBe(false);
    });

    test("屏幕上节点太窄时隐藏尺寸和编码", () => {
        expect(groupedHeaderMetrics({ scale: 0.5, nodeWidth: 200, grouped: true }).showMeta).toBe(false);
        expect(groupedHeaderMetrics({ scale: 0.5, nodeWidth: 280, grouped: true }).showMeta).toBe(true);
    });
});

describe("nodeActionBarMode", () => {
    test("按屏幕宽度切换", () => {
        expect(nodeActionBarMode(119)).toBe("hidden");
        expect(nodeActionBarMode(120)).toBe("compact");
        expect(nodeActionBarMode(199)).toBe("compact");
        expect(nodeActionBarMode(200)).toBe("full");
    });
});

describe("groupStatusButtonsCompact", () => {
    test("小于 360 时只显示图标", () => {
        expect(groupStatusButtonsCompact(359)).toBe(true);
        expect(groupStatusButtonsCompact(360)).toBe(false);
    });
});
