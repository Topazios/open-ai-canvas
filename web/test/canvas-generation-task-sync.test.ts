import { describe, expect, spyOn, test } from "bun:test";

import { applyGeneratedMediaResultMetadata, applyGenerationTaskResultToNodes, buildGenerationTaskNodeResult, videoMetadata } from "@/lib/canvas/canvas-generation-task-sync";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import * as imageStorage from "@/services/image-storage";

function videoNode(assetId: string, storageKey: string): CanvasNodeData {
    return {
        id: "node-1",
        type: CanvasNodeType.Video,
        title: "镜头",
        position: { x: 0, y: 0 },
        width: 320,
        height: 180,
        metadata: { assetId, storageKey, content: "https://example.test/old.mp4", prompt: "旧提示词" },
    };
}

describe("applyGeneratedMediaResultMetadata", () => {
    test("asset-sheet task results keep the original generated image without cropping or recomposition", async () => {
        const node = {
            id: "sheet",
            type: CanvasNodeType.Image,
            title: "场景设定板",
            position: { x: 0, y: 0 },
            width: 400,
            height: 280,
            metadata: {
                size: "1536x1024",
                shortDrama: { assetSheet: { version: 3, kind: "environment", size: "1536x1024", styleSignatures: {} } },
            },
        } as CanvasNodeData;
        const upload = spyOn(imageStorage, "uploadImage").mockResolvedValue({
            url: "https://example.test/original.png", storageKey: "resource:original", width: 1536, height: 1024, bytes: 4, mimeType: "image/png",
        });
        const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch image for cropping"));
        try {
            const result = await buildGenerationTaskNodeResult(node, {
                id: "task", type: "canvas_image", status: "succeeded", prompt: "full sheet", attempts: 1, createdAt: "", updatedAt: "",
                resultJson: JSON.stringify({ images: [{ dataUrl: "data:image/png;base64,AAAA", width: 1536, height: 1024 }] }),
            });
            expect(upload).toHaveBeenCalledWith("data:image/png;base64,AAAA");
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(result.metadata?.storageKey).toBe("resource:original");
        } finally {
            upload.mockRestore();
            fetchSpy.mockRestore();
        }
    });

    test("明确指定的节点已删除时不能根据 taskId 误更新其他节点", async () => {
        const other = { ...videoNode("asset", "video:key"), metadata: { taskId: "task" } };
        const applied = await applyGenerationTaskResultToNodes([other], { id: "task", type: "canvas_video", status: "succeeded", prompt: "", attempts: 1, createdAt: "", updatedAt: "" }, "deleted-node");
        expect(applied.updated).toBe(false);
        expect(applied.nodes).toEqual([other]);
    });
    test("clears the previous asset binding when a regenerated media result lands", () => {
        const node = videoNode("asset-old", "video:old");
        const next = applyGeneratedMediaResultMetadata(node, videoMetadata({
            url: "https://example.test/new.mp4",
            storageKey: "video:new",
            width: 1280,
            height: 720,
            bytes: 12,
            mimeType: "video/mp4",
            durationMs: 4000,
        }), { prompt: "新提示词" });

        expect(next.assetId).toBeUndefined();
        expect(next.storageKey).toBe("video:new");
        expect(next.content).toBe("https://example.test/new.mp4");
        expect(next.prompt).toBe("新提示词");
        expect(next.status).toBe("success");
    });
});
