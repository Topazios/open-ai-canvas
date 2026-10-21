import { afterEach, expect, spyOn, test } from "bun:test";
import { hydrateNodeGenerationContext, type NodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import * as images from "../src/services/image-storage";
import * as drawings from "../src/lib/canvas/canvas-drawing-reference";
import * as grades from "../src/lib/canvas/canvas-color-grade";
import type { ReferenceImage } from "../src/types/image";

const context = (referenceImages: ReferenceImage[]): NodeGenerationContext => ({
    prompt: "Frame", referenceImages, referenceVideos: [], referenceAudios: [], characterReferences: [],
    resolvedCharacterVersions: [], resolvedCharacterVoices: [], textCount: 0, imageCount: referenceImages.length, videoCount: 0, audioCount: 0,
});
const reference = (id: string, extra: Partial<ReferenceImage>): ReferenceImage => ({ id, name: `${id}.png`, type: "image/png", dataUrl: "", ...extra });
const restores: Array<() => void> = [];
afterEach(() => { restores.splice(0).forEach(restore => restore()); });

test("image and video submissions preserve resource references without downloading or encoding originals", async () => {
    const encode = spyOn(images, "imageToDataUrl").mockResolvedValue("data:image/png;base64,encoded");
    restores.push(() => encode.mockRestore());
    const refs = [
        reference("owned", { storageKey: "resource:owned", width: 2048, height: 3072 }),
        reference("public", { url: "https://media.example/frame.png" }),
        reference("legacy-url", { dataUrl: "https://media.example/legacy.png" }),
    ];
    for (const mode of ["image", "video"] as const) {
        const result = await hydrateNodeGenerationContext(context(refs), "project", undefined, mode);
        expect(result.referenceImages).toEqual(refs);
        expect(result.referenceImages.map(image => image.id)).toEqual(["owned", "public", "legacy-url"]);
        expect(result.imageCount).toBe(3);
    }
    expect(encode).not.toHaveBeenCalled();
});

test("local images still hydrate and text consumers still receive inline image bytes", async () => {
    const encode = spyOn(images, "imageToDataUrl").mockResolvedValue("data:image/png;base64,encoded");
    restores.push(() => encode.mockRestore());
    const local = reference("local", { storageKey: "image:scope:local", url: "blob:local" });
    const remote = reference("owned", { storageKey: "resource:owned" });
    const result = await hydrateNodeGenerationContext(context([remote, local]), "project", undefined, "image");
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledWith(local);
    expect(result.referenceImages[1].dataUrl).toBe("data:image/png;base64,encoded");
    const text = await hydrateNodeGenerationContext(context([remote]), "project", undefined, "text");
    expect(encode).toHaveBeenCalledTimes(2);
    expect(text.referenceImages[0].dataUrl).toBe("data:image/png;base64,encoded");
});

test("derived drawings and color grading are materialized before remote-reference shortcuts", async () => {
    const draw = spyOn(drawings, "resolveCanvasDrawingReference").mockResolvedValue(reference("drawing-output", { storageKey: "resource:rendered" }));
    const grade = spyOn(grades, "resolveCanvasColorGradeReference").mockResolvedValue(reference("grade-output", { dataUrl: "data:image/png;base64,graded" }));
    restores.push(() => draw.mockRestore(), () => grade.mockRestore());
    const drawing = reference("drawing", { storageKey: "resource:old", source: { kind: "drawing", drawingId: "drawing", revision: 2, shapeCount: 1 } });
    const color = reference("color", { url: "https://media.example/original.png", source: { kind: "colorgrade", url: "https://media.example/original.png", grade: {} as grades.CanvasColorGrade } });
    const result = await hydrateNodeGenerationContext(context([drawing, color]), "project", undefined, "image");
    expect(draw).toHaveBeenCalledWith("project", drawing);
    expect(grade).toHaveBeenCalledWith(color);
    expect(result.referenceImages.map(image => image.id)).toEqual(["drawing-output", "grade-output"]);
});
