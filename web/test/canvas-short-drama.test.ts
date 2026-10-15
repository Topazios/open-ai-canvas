import { describe, expect, test } from "bun:test";

import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { createShortDramaPipeline, deriveShortDramaProgress } from "@/lib/canvas/canvas-short-drama";
import { shortDramaStages } from "@/lib/short-drama-stages";
import { CanvasNodeType } from "@/types/canvas";

function pipelineWithShot() {
    const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
    const script = pipeline.nodes.find((node) => node.id === pipeline.scriptNodeId)!;
    script.metadata!.storyboard!.rows = [createStoryboardRow(1, { plotDescription: "Opening shot" })];
    return { ...pipeline, script };
}

describe("canvas short drama eight-stage guide", () => {
    test("creation pipelines expose all eight stages without changing saved nodes or edges", () => {
        const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
        const before = JSON.stringify(pipeline);
        const progress = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        expect(progress.active).toBe(true);
        expect(progress.steps.map((step) => step.id)).toEqual(["story", "assets", "storyboard", "voice", "video", "edit", "review", "delivery"]);
        expect(progress.steps.map((step) => step.label)).toEqual(shortDramaStages.map((stage) => stage.label));
        expect(progress.steps.every((step) => step.tasks.length > 0)).toBe(true);
        expect(progress.steps.reduce((count, step) => count + step.tasks.length, 0)).toBe(30);
        expect(progress.steps.flatMap((step) => step.tasks.map((task) => task.id))).toEqual([
            "story.topic", "story.plan", "story.episodes", "story.body",
            "assets.bible", "guide.assets.fixed", "guide.assets.references",
            "guide.direction.breakdown", "guide.direction.prompting", "guide.direction.frames", "guide.direction.previsualization",
            "voice.dialogue", "voice.casting", "voice.recording", "voice.timing",
            "video.sample", "video.generate", "video.performance", "video.approve",
            "edit.rough", "edit.picture", "edit.sound", "edit.subtitles",
            "review.automatic", "review.screening", "review.revision",
            "delivery.render", "delivery.package", "delivery.verify", "delivery.promotion",
        ]);
        expect(progress.completedCount).toBe(0);
        expect(progress.steps[0].status).toBe("current");
        expect(JSON.stringify(pipeline)).toBe(before);
    });

    test("freeform unrelated canvases do not activate the production guide", () => {
        const node = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: "Notes" });
        expect(deriveShortDramaProgress([node], []).active).toBe(false);
    });

    test("style becomes an asset subtask and does not imply asset confirmation", () => {
        const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
        pipeline.nodes[0].metadata!.content = "Visual style";
        const progress = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        const assets = progress.steps.find((step) => step.id === "assets")!;
        expect(assets.tasks.find((task) => task.id === "assets.bible")?.ready).not.toBe(true);
        expect(assets.status).not.toBe("completed");
        expect(progress.completedCount).toBe(0);
    });

    test("a topic alone cannot complete the four-step story stage", () => {
        const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
        pipeline.nodes[1].metadata!.content = "Story text";
        expect(deriveShortDramaProgress(pipeline.nodes, pipeline.connections).steps[0].tasks[0].ready).toBe(true);
        expect(deriveShortDramaProgress(pipeline.nodes, pipeline.connections).steps[0].status).toBe("current");
        expect(deriveShortDramaProgress(pipeline.nodes, []).steps[0].status).toBe("current");
    });

    test("missing media permits document setup but does not mark editing or screening complete", () => {
        const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
        const progress = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        for (const step of progress.steps.filter((step) => step.id === "edit" || step.id === "review" || step.id === "delivery")) {
            expect(step.tasks.every((task) => task.actionLabel === "生成" && !task.ready)).toBe(true);
            expect(step.status).not.toBe("completed");
        }
        expect(progress.steps.find((step) => step.id === "voice")!.tasks.find((task) => task.id === "voice.recording")!.unavailableReason).toBeUndefined();
    });

    test("storyboard actions open its actual node and videos require every shot result", () => {
        const pipeline = pipelineWithShot();
        const video = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { status: "success", content: "test-video.mp4" });
        pipeline.script.metadata!.storyboard!.rows[0].videoNodeId = video.id;
        pipeline.nodes.push(video);
        let progress = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        expect(progress.steps.find((step) => step.id === "video")!.status).toBe("completed");
        expect(progress.steps.find((step) => step.id === "storyboard")!.tasks[0].nodeId).toBe(pipeline.scriptNodeId);
        pipeline.script.metadata!.storyboard!.rows.push(createStoryboardRow(2, { plotDescription: "Second shot" }));
        progress = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        expect(progress.steps.find((step) => step.id === "video")!.status).not.toBe("completed");
    });

    test("a legacy final video enables screening but never implies approval or delivery", () => {
        const pipeline = pipelineWithShot();
        const final = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { workflowKind: "final", status: "success", content: "final.mp4" });
        pipeline.nodes.push(final);
        const progress = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        const review = progress.steps.find((step) => step.id === "review")!;
        const screening = review.tasks.find((task) => task.id === "review.screening")!;
        expect(screening.nodeId).toBe(final.id);
        expect(screening.unavailableReason).toBeUndefined();
        expect(review.status).not.toBe("completed");
        expect(progress.steps.find((step) => step.id === "delivery")!.status).not.toBe("completed");
        expect(progress.completed).toBe(false);
    });

    test("audio material enables editing but does not count as a completed sound stage", () => {
        const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
        const audio = createCanvasNode(CanvasNodeType.Audio, { x: 0, y: 0 }, { storageKey: "local-audio" });
        pipeline.nodes.push(audio);
        const progress = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        const voice = progress.steps.find((step) => step.id === "voice")!;
        expect(voice.tasks.find((task) => task.id === "voice.recording")!.ready).toBe(true);
        expect(voice.status).not.toBe("completed");
        expect(progress.steps.find((step) => step.id === "edit")!.tasks[0].nodeId).toBe(audio.id);
    });

    test("deleting a final result removes its screening action target", () => {
        const pipeline = pipelineWithShot();
        const final = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { workflowKind: "final", status: "success", content: "final.mp4" });
        const before = deriveShortDramaProgress([...pipeline.nodes, final], pipeline.connections);
        const after = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        expect(before.steps.find((step) => step.id === "review")!.tasks.find((task) => task.id === "review.screening")!.nodeId).toBe(final.id);
        expect(after.steps.find((step) => step.id === "review")!.tasks.find((task) => task.id === "review.screening")!.nodeId).toBeUndefined();
        expect(after.steps.find((step) => step.id === "review")!.tasks.find((task) => task.id === "review.screening")!.ready).not.toBe(true);
    });
});
