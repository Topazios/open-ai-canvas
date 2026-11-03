import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasNode } from "../src/components/canvas/canvas-node";
import { CanvasFrameNode } from "../src/components/canvas/canvas-frame-node";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

const noop = () => {};

const planDoc = (id: string, planSection?: string, extra: Record<string, unknown> = {}): CanvasNodeData => ({
    id, type: CanvasNodeType.Text, title: `文稿 ${id}`, position: { x: 0, y: 0 }, width: 400, height: 280, parentId: "frame",
    metadata: {
        status: "success", content: `${id} 正文`,
        shortDrama: { stage: "story", step: "story.plan", role: "document", pipelineId: "pipeline", sourceNodeIds: [], sourceSignatures: {}, planSection, ...extra },
    },
} as CanvasNodeData);

const renderNode = (data: CanvasNodeData) => renderToStaticMarkup(
    <CanvasNode data={data} scale={1} isSelected={false} isRelated={false} isFocusRelated={false} isConnectionTarget={false} showImageInfo={false}
        onMouseDown={noop} onHoverStart={noop} onHoverEnd={noop} onConnectStart={noop} onResize={noop} onContentChange={noop} onContextMenu={noop} onOpenTaskDetails={noop} />,
);

const frame = (sourceNodeIds: string[]): CanvasNodeData => ({
    id: "frame", type: CanvasNodeType.Frame, title: "制作方案", position: { x: 0, y: 0 }, width: 1296, height: 900,
    metadata: {
        shortDrama: { stage: "story", step: "story.plan", role: "collection", pipelineId: "pipeline", sourceNodeIds, sourceSignatures: {}, assetGroup: { manifestId: "manifest", kind: "plan" } },
    },
} as CanvasNodeData);

const renderFrame = (children: CanvasNodeData[]) => renderToStaticMarkup(
    <CanvasFrameNode data={frame(children.map((node) => node.id))} childNodes={children} taskAnchor={undefined} productionRun={undefined} scale={1} isSelected={false} isDropTarget={false}
        onMouseDown={noop} onResize={noop} onToggleCollapsed={noop} onFolderStyleChange={noop} onTitleChange={noop} onContextMenu={noop} onOpenTaskDetails={noop} />,
);

test("story outline card is marked as the primary plan document", () => {
    const html = renderNode(planDoc("story", "story"));
    expect(html).toContain("总纲");
    expect(html).not.toContain("规范");
});

test("other plan sections are marked as supporting specs", () => {
    const html = renderNode(planDoc("visual", "visual"));
    expect(html).toContain("规范");
    expect(html).not.toContain("总纲");
});

test("ordinary nodes and grouped plan assets carry no plan role label", () => {
    const plain = renderNode({ ...planDoc("plain"), metadata: { status: "success", content: "普通正文" } });
    expect(plain).not.toContain("总纲");
    expect(plain).not.toContain("规范");

    const grouped = renderNode(planDoc("grouped", "story", { planGroup: { kind: "scene" } }));
    expect(grouped).not.toContain("总纲");
    expect(grouped).not.toContain("规范");
});

test("plan container counts the outline separately from its specs", () => {
    const children = [planDoc("story", "story"), planDoc("a", "visual"), planDoc("b", "audio"), planDoc("c", "style"), planDoc("d", "rules")];
    expect(renderFrame(children)).toContain("总纲 + 4 份规范");
});

test("plan container without an outline falls back to a plain document count", () => {
    const children = [planDoc("a", "visual"), planDoc("b", "audio")];
    const html = renderFrame(children);
    expect(html).toContain("2 份方案文稿");
    expect(html).not.toContain("总纲 +");
});
