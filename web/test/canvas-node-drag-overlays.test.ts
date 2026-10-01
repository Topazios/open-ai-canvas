import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const projectSource = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/project.tsx"), "utf8");
const selectionControllerSource = readFileSync(resolve(import.meta.dir, "../src/pages/canvas/use-canvas-selection-controller.ts"), "utf8");
const toolbarSource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-node-toolbar.tsx"), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");

describe("canvas node drag overlays", () => {
    test("hides floating editors and selection controls for the whole drag preview", () => {
        expect(projectSource).toContain("const isCanvasNodeMoving = isNodeDragging || Boolean(dragPreview?.nodeIds.size);");
        // 面板浮层的守卫必须同时成立：类型排除、框选、拖拽预览。断言整段条件而不是某一行的
        // 字面量，避免上游拆行或新增类型排除（Panorama 等）后把排版变化报成契约失效。
        const flatSource = flat(projectSource);
        const overlayStart = flatSource.indexOf("{dialogNode &&");
        const overlayCondition = flatSource.slice(overlayStart, flatSource.indexOf("<CanvasNodePanelOverlay", overlayStart));
        expect(overlayCondition).toContain("dialogNode.type !== CanvasNodeType.Drawing");
        expect(overlayCondition).toContain("!selectionBox");
        expect(overlayCondition).toContain("!isCanvasNodeMoving");
        expect(projectSource).not.toContain("angleNode?.metadata?.content && !isCanvasNodeMoving");
        expect(projectSource).toContain("emotionNode?.metadata?.content && !isCanvasNodeMoving");
        expect(projectSource).toContain("selectedNodeBounds && !selectionBox && !isCanvasNodeMoving");
        expect(projectSource).toContain("node={isCanvasNodeMoving || nodeImageSettingsOpen || emotionNodeId || angleNodeId ? null : dialogNode || toolbarNode}");
        expect(projectSource).toContain("scaleWithNode");
        expect(projectSource).toContain("onNodeDragEnd: handleNodeDragEnd");
        expect(projectSource).toContain("setDialogNodeId(node.id);");
        expect(selectionControllerSource).toContain("if (clickedNodeId) onNodeDragEnd?.(clickedNodeId);");
    });

    test("keeps node toolbar fixed during horizontal viewport previews and clears it offscreen", () => {
        expect(toolbarSource).toContain("import { subscribeCanvasViewportVisibilityPreview }");
        expect(toolbarSource).toContain("const verticalChanged = Math.abs(nextViewport.y - previousViewport.y) > 0.5;");
        expect(toolbarSource).toContain("if (verticalChanged || scaleChanged) scheduleUpdate();");
        expect(toolbarSource).toContain("const visible = updateNodeVisibility(nextViewport);");
        expect(toolbarSource).toContain("if (visible && wasVisible === false) scheduleUpdate();");
        expect(toolbarSource).toContain("return nextElement?.isConnected ? nextElement : null;");
        expect(toolbarSource).toContain("setAnchor(null);");
        expect(toolbarSource).not.toContain("viewport.x]);");
    });

    test("repositions overlays when a horizontally hidden node returns to the viewport", () => {
        const overlaySource = readFileSync(resolve(import.meta.dir, "../src/components/canvas/canvas-workspace-overlays.tsx"), "utf8");
        const stylesSource = readFileSync(resolve(import.meta.dir, "../src/styles/globals.css"), "utf8");
        expect(overlaySource).toContain("let lastNodeVisibility: boolean | null = null;");
        expect(overlaySource).toContain("if (verticalChanged || scaleChanged || (visible && wasVisible === false)) updatePosition(nextViewport);");
        expect(overlaySource).toContain("if (visible && wasVisible === false) updatePosition(liveViewport);");
        expect(stylesSource).not.toContain("html[data-canvas-viewport-interacting=\"true\"] :where(\n        .canvas-node-toolbar,");
    });
});
