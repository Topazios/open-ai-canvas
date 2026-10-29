import { expect, test } from "bun:test";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { canAutoAdjustImagePrompt, canRedrawFailedImage, canRegenerateImageInDialog, canRegenerateImagePrompt, readImageNodePrompt } from "@/lib/canvas/canvas-image-redraw";

function imageNode(metadata: Record<string, unknown> = {}): CanvasNodeData {
    return { id: "n1", type: CanvasNodeType.Image, x: 0, y: 0, width: 300, height: 300, metadata: { content: "data:image/png;base64,AA", prompt: "原提示词", taskId: "task-1", ...metadata } } as CanvasNodeData;
}

test("没有图片内容的节点不显示提示词页", () => {
    expect(canRegenerateImagePrompt(imageNode({ content: "" }))).toBe(false);
    expect(canRegenerateImagePrompt(null)).toBe(false);
});

test("普通图片节点有提示词页，但不能在弹窗内直接重新生成", () => {
    const node = imageNode();
    expect(canRegenerateImagePrompt(node)).toBe(true);
    expect(canRegenerateImageInDialog(node)).toBe(false);
});

test("短剧图片节点可在弹窗内重新生成，有设定板才允许自动调整", () => {
    const plain = imageNode({ shortDrama: { mediaKind: "image" } });
    expect(canRegenerateImageInDialog(plain)).toBe(true);
    expect(canAutoAdjustImagePrompt(plain)).toBe(false);
    const sheet = imageNode({ shortDrama: { mediaKind: "image", assetSheet: {} } });
    expect(canAutoAdjustImagePrompt(sheet)).toBe(true);
});

test("非图片类短剧节点不提供提示词页", () => {
    expect(canRegenerateImagePrompt(imageNode({ shortDrama: { mediaKind: "video" } }))).toBe(false);
});

test("读取提示词优先用 prompt，其次 composerContent", () => {
    expect(readImageNodePrompt(imageNode())).toBe("原提示词");
    expect(readImageNodePrompt(imageNode({ prompt: "", composerContent: "输入框内容" }))).toBe("输入框内容");
    expect(readImageNodePrompt(undefined)).toBe("");
});

test("失败且无图的短剧图片节点可进入重绘弹窗", () => {
    const failed = imageNode({ content: "", status: "error", shortDrama: { mediaKind: "image" } });
    expect(canRedrawFailedImage(failed)).toBe(true);
    expect(canRedrawFailedImage(imageNode({ content: "", status: "error" }))).toBe(false);
    expect(canRedrawFailedImage(imageNode({ content: "", status: "error", shortDrama: { mediaKind: "video" } }))).toBe(false);
    expect(canRedrawFailedImage(imageNode({ shortDrama: { mediaKind: "image" } }))).toBe(false);
});

test("失败但已有图片或已上传的短剧图片节点同样进入重绘弹窗", () => {
    const withContent = imageNode({ status: "error", shortDrama: { mediaKind: "image", assetSheet: {} } });
    expect(canRedrawFailedImage(withContent)).toBe(true);
    expect(canRegenerateImageInDialog(withContent)).toBe(true);
    expect(canRedrawFailedImage(imageNode({ status: "error", fileUpload: { name: "a.png" }, shortDrama: { mediaKind: "image" } }))).toBe(true);
    expect(canRedrawFailedImage(imageNode({ status: "error", taskId: "", fileUpload: { name: "a.png" }, shortDrama: { mediaKind: "image" } }))).toBe(false);
    expect(canRedrawFailedImage(imageNode({ status: "error" }))).toBe(false);
});
