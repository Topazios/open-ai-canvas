import { describe, expect, test } from "bun:test";
import { canvasShotBindingLabel, canvasShotMediaNode, type CanvasShotBinding } from "../src/lib/canvas/canvas-shot-projection";
import type { CanvasNodeData } from "../src/types/canvas";

const node = Object.freeze({ id: "node", type: "video", title: "Local title", position: { x: 12, y: 24 }, width: 400, height: 240,
    metadata: Object.freeze({ storageKey: "resource:original", content: "old media", videoPreview: { storageKey: "resource:old-poster" }, subtitleEntries: [{ text: "local subtitle" }], taskId: "original-task", status: "loading" }) }) as unknown as CanvasNodeData;
function binding(): CanvasShotBinding {
    return { unavailable: false, link: { id: "link", projectId: "p", unitId: "u", canvasId: "c", nodeId: "node", shotId: "shot", shotRevisionId: "revision", artifactId: "artifact", createdAt: "", updatedAt: "" },
        view: { linkId: "link", nodeId: "node", state: "current", shotTitle: "Business title", resourceAvailable: true,
            artifact: { id: "artifact", projectId: "p", unitId: "u", shotId: "shot", revisionId: "revision", resourceId: "adopted", type: "video", selected: true, status: "ready", version: 1, metadataJson: "{}", createdAt: "", updatedAt: "" } } };
}

describe("canvas shot read projection", () => {
    test("uses adopted media without copying original task, poster or subtitles and keeps geometry", () => {
        const before = JSON.stringify(node);
        const display = canvasShotMediaNode(node, binding())!;
        expect(display.title).toBe("Business title");
        expect(display.position).toBe(node.position);
        expect(display.width).toBe(node.width);
        expect(display.metadata).toEqual({ storageKey: "resource:adopted", status: "success" });
        expect(JSON.stringify(node)).toBe(before);
        expect(display).not.toBe(node);
    });
    test("stale, unavailable or mismatched bindings never return playable media", () => {
        const scenarios = [
            (b: CanvasShotBinding) => { b.unavailable = true; },
            (b: CanvasShotBinding) => { b.view = undefined; },
            (b: CanvasShotBinding) => { b.view!.state = "resource_unavailable"; },
            (b: CanvasShotBinding) => { b.view!.state = "shot_revised"; },
            (b: CanvasShotBinding) => { b.view!.resourceAvailable = false; },
            (b: CanvasShotBinding) => { b.view!.linkId = "other"; },
            (b: CanvasShotBinding) => { b.view!.artifact!.revisionId = "new-revision"; },
            (b: CanvasShotBinding) => { b.view!.artifact!.selected = false; },
            (b: CanvasShotBinding) => { b.view!.artifact!.type = "audio"; },
        ];
        for (const modify of scenarios) { const b = binding(); modify(b); expect(canvasShotMediaNode(node, b)).toBeNull(); }
    });
    test("a failed refresh is never presented as a current business record", () => {
        const b = binding(); b.unavailable = true;
        expect(canvasShotBindingLabel(b)).toBe("项目内容暂不可用");
        b.unavailable = false; b.view!.state = "resource_unavailable";
        expect(canvasShotBindingLabel(b)).toBe("产物资源不可用");
    });
});
