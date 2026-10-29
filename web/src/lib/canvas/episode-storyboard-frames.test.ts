import assert from "node:assert/strict";
import test from "node:test";

import "./node-registry/definitions/index.ts";
// @ts-expect-error -- Node native TypeScript test runner requires the extension.
import { failedStoryboardBoundaryImagesForRow, storyboardFrameHash } from "./episode-storyboard-frames.ts";
// @ts-expect-error -- Node native TypeScript test runner requires the extension.
import { CanvasNodeType, StoryboardFrameKind, type CanvasNodeData, type StoryboardRow } from "../../types/canvas.ts";

function makeRow(): StoryboardRow {
    return {
        id: "row-1",
        shotNumber: 1,
        detailStatus: "ready",
        durationSeconds: 10,
        plotDescription: "角色推门进入房间",
        videoMotionPrompt: "CHR-1 推门进入 SCN-1",
        dialogue: "",
        characters: [],
        narrativeIntent: "",
        viewerPOV: "",
        performanceBlocking: "",
        shotSize: "中景",
        emotion: "紧张",
        lightingAndAtmosphere: "室内暖光",
        audioEffects: "",
        camera: "固定机位",
        motion: "推门",
        timeBeats: "",
        imageGenerationPrompt: "",
        mustHave: [],
        optionalDetails: [],
        continuityOut: "",
        negativePrompt: "",
        assetBindings: [],
    };
}

function makeNode(id: string, row: StoryboardRow, status: "failed" | "succeeded" | "queued"): CanvasNodeData {
    const frameId = id.endsWith("end") ? StoryboardFrameKind.End : StoryboardFrameKind.Start;
    return {
        id,
        type: CanvasNodeType.Image,
        title: id,
        position: { x: 0, y: 0 },
        width: 280,
        height: 280,
        metadata: {
            status: status === "failed" ? "error" : status === "succeeded" ? "success" : "loading",
            taskId: `task-${id}`,
            taskStatus: status === "failed" ? "failed" : status === "succeeded" ? "succeeded" : "queued",
            ...(status === "succeeded" ? { content: "image-data" } : {}),
            storyboardFrame: { scriptId: "script", rowId: row.id, frameId, sourcePromptHash: storyboardFrameHash(row) },
        },
    };
}

test("row retry selects only unique, current failed boundary images", () => {
    const row = makeRow();
    const hash = storyboardFrameHash(row);
    const failed = makeNode("failed-start", row, "failed");
    const succeeded = makeNode("success-end", row, "succeeded");
    const active = makeNode("active-start", row, "queued");
    row.frames = [
        { id: StoryboardFrameKind.Start, kind: StoryboardFrameKind.Start, timeSeconds: 0, prompt: "start", sourcePromptHash: hash, imageNodeId: failed.id },
        { id: StoryboardFrameKind.End, kind: StoryboardFrameKind.End, timeSeconds: 10, prompt: "end", sourcePromptHash: hash, imageNodeId: failed.id },
        { id: "success-end", kind: StoryboardFrameKind.End, timeSeconds: 10, prompt: "end", sourcePromptHash: hash, imageNodeId: succeeded.id },
        { id: "active-start", kind: StoryboardFrameKind.Start, timeSeconds: 0, prompt: "start", sourcePromptHash: hash, imageNodeId: active.id },
    ];
    const script = { id: "script", metadata: { storyboard: { rows: [row] } } } as CanvasNodeData;

    assert.deepEqual(failedStoryboardBoundaryImagesForRow(script, row.id, [script, failed, succeeded, active]), [failed]);
});

test("row retry ignores frames from an outdated prompt version", () => {
    const row = makeRow();
    const oldHash = storyboardFrameHash(row);
    const failed = makeNode("failed-start", row, "failed");
    row.videoMotionPrompt = "CHR-1 转身离开 SCN-1";
    row.frames = [{ id: StoryboardFrameKind.Start, kind: StoryboardFrameKind.Start, timeSeconds: 0, prompt: "old", sourcePromptHash: oldHash, imageNodeId: failed.id }];
    const script = { id: "script", metadata: { storyboard: { rows: [row] } } } as CanvasNodeData;

    assert.deepEqual(failedStoryboardBoundaryImagesForRow(script, row.id, [script, failed]), []);
});
