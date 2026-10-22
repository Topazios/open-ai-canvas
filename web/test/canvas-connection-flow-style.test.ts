import { expect, test } from "bun:test";

const connectionSource = await Bun.file(new URL("../src/components/canvas/canvas-connections.tsx", import.meta.url)).text();
const globalStyles = (await Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text()).replace(/\r\n/g, "\n");

test("连接线使用起点到终点的方向标记和连续流动层", () => {
    expect(connectionSource).toContain("markerEnd={showVisual ? `url(#${markerId})` : undefined}");
    expect(connectionSource).toContain("className=\"canvas-connection-flow\"");
    expect(connectionSource).toContain("className=\"canvas-connection-comet\"");
    expect(connectionSource).toContain("gradientUnits=\"userSpaceOnUse\" x1={startX} y1={startY} x2={endX} y2={endY}");
    expect(connectionSource).toContain("--canvas-connection-delay");
});

test("连接线动画在交互和减少动态效果偏好下会降级", () => {
    expect(globalStyles).toContain("@keyframes canvas-connection-flow");
    expect(globalStyles).toContain("@keyframes canvas-connection-comet");
    expect(globalStyles).toContain('[data-canvas-viewport][data-canvas-viewport-interacting="true"] :where(.canvas-connection-flow, .canvas-connection-comet, .canvas-connection-draft)');
    expect(globalStyles).toContain(".canvas-connection-flow,\n    .canvas-connection-comet,\n    .canvas-connection-target,\n    .canvas-connection-draft {\n        animation: none;");
});
