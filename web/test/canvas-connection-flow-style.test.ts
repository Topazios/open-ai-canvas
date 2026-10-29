import { expect, test } from "bun:test";

const connectionSource = await Bun.file(new URL("../src/components/canvas/canvas-connections.tsx", import.meta.url)).text();
const globalStyles = (await Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text()).replace(/\r\n/g, "\n");
const worldSource = await Bun.file(new URL("../src/pages/canvas/canvas-project-world-layers.tsx", import.meta.url)).text();
const graphicsSource = await Bun.file(new URL("../src/components/canvas/canvas-leafer-graphics-layer.tsx", import.meta.url)).text();

test("连接线始终显示，静态主视觉保留轻量命中层", () => {
    expect(worldSource).toContain("props.displayConnections.map");
    expect(graphicsSource).toContain("displayConnections: CanvasDisplayConnection[]");
    expect(graphicsSource).toContain("strokeWidth: emphasized ? 1.8 : 1.35");
    expect(connectionSource).toContain('pointerEvents: "stroke"');
});

test("连接线样式来自全局策略，方向标记更轻", () => {
    expect(graphicsSource).toContain("connectionPolicy?: RuntimeLimits[\"canvas\"]");
    expect(graphicsSource).toContain("connectionTargetDotPath");
    expect(graphicsSource).toContain('props.connectionPolicy?.connectionLineStyle || "solid"');
    expect(graphicsSource).toContain('props.connectionPolicy?.connectionArrowStyle || "arrow"');
    expect(graphicsSource).not.toContain("dashOffset");
    expect(graphicsSource).not.toContain("requestAnimationFrame(animateFlow)");
    expect(connectionSource).toContain('connectionPolicy?.connectionLineStyle || "solid"');
    expect(connectionSource).toContain('connectionPolicy?.connectionArrowStyle || "arrow"');
    expect(connectionSource).toContain('strokeWidth={emphasized ? 1.8 : 1.4}');
});

test("连接线不再注册持续动画", () => {
    expect(globalStyles).not.toContain("@keyframes canvas-connection-flow");
    expect(globalStyles).not.toContain("@keyframes canvas-connection-comet");
    expect(globalStyles).not.toContain("@keyframes canvas-connection-target-pulse");
    expect(graphicsSource).not.toContain("requestAnimationFrame(animateFlow)");
    expect(connectionSource).not.toContain("animateMotion");
    expect(connectionSource).not.toContain("canvas-connection-comet");
    expect(connectionSource).not.toContain("canvas-connection-flow");
});
