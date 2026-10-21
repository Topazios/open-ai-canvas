import { describe, expect, test } from "bun:test";

import { createCanvasNode, createStoryboardRow } from "@/lib/canvas/canvas-project-domain";
import { createShortDramaPipeline, deriveShortDramaProgress } from "@/lib/canvas/canvas-short-drama";
import { CanvasNodeType } from "@/types/canvas";

function pipelineWithShot() {
    const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
    const script = pipeline.nodes.find((node) => node.id === pipeline.scriptNodeId)!;
    script.metadata!.storyboard!.rows = [createStoryboardRow(1, { plotDescription: "Opening shot" })];
    return { ...pipeline, script };
}

describe("canvas short drama preproduction guide", () => {
    test("asset production moves into story without changing saved nodes or edges", () => {
        const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
        const before = JSON.stringify(pipeline);
        const progress = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        expect(progress.active).toBe(true);
        expect(progress.steps.map((step) => step.id)).toEqual(["story", "storyboard", "voice", "edit", "review", "delivery"]);
        expect(progress.steps.map((step) => step.label)).toEqual(["剧情与章节", "分镜与视频草样", "配音与声音", "剪辑与后期", "成片质检", "导出交付"]);
        expect(progress.steps.every((step) => step.tasks.length > 0)).toBe(true);
        expect(progress.steps.reduce((count, step) => count + step.tasks.length, 0)).toBe(24);
        expect(progress.steps.flatMap((step) => step.tasks.map((task) => task.id))).toEqual([
            "story.topic", "story.plan", "guide.assets.references", "story.episodes", "story.body", "story.audit",
            "guide.direction.breakdown", "guide.direction.frames", "guide.direction.previsualization",
            "video.sample", "video.generate",
            "voice.dialogue", "voice.casting", "voice.recording", "voice.timing",
            "video.finish",
            "edit.rough", "edit.picture", "edit.sound", "edit.subtitles",
            "review.audit", "review.revision",
            "delivery.output", "delivery.promotion",
        ]);
        expect(progress.completedCount).toBe(0);
        expect(progress.steps[0].status).toBe("current");
        expect(JSON.stringify(pipeline)).toBe(before);
    });

    test("freeform unrelated canvases do not activate the production guide", () => {
        const node = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: "Notes" });
        expect(deriveShortDramaProgress([node], []).active).toBe(false);
    });

    test("style alone does not imply production images or screenplay audit completion", () => {
        const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
        pipeline.nodes[0].metadata!.content = "Visual style";
        const progress = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        const story = progress.steps.find((step) => step.id === "story")!;
        expect(story.tasks.find((task) => task.id === "guide.assets.references")?.ready).not.toBe(true);
        expect(story.tasks.find((task) => task.id === "story.audit")?.ready).not.toBe(true);
        expect(story.status).not.toBe("completed");
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
        const storyboard = progress.steps.find((step) => step.id === "storyboard")!;
        expect(storyboard.tasks.find((task) => task.id === "video.generate")!.ready).toBe(true);
        expect(progress.steps.find((step) => step.id === "storyboard")!.tasks[0].nodeId).toBe(pipeline.scriptNodeId);
        pipeline.script.metadata!.storyboard!.rows.push(createStoryboardRow(2, { plotDescription: "Second shot" }));
        progress = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        expect(progress.steps.find((step) => step.id === "storyboard")!.tasks.find((task) => task.id === "video.generate")!.ready).not.toBe(true);
    });

    test("a legacy final video enables screening but never implies approval or delivery", () => {
        const pipeline = pipelineWithShot();
        const final = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { workflowKind: "final", status: "success", content: "final.mp4" });
        pipeline.nodes.push(final);
        const progress = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        const review = progress.steps.find((step) => step.id === "review")!;
        const screening = review.tasks.find((task) => task.id === "review.audit")!;
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
        expect(progress.steps.find((step) => step.id === "edit")!.tasks.find((task) => task.id === "edit.rough")!.nodeId).toBe(audio.id);
    });

    test("deleting a final result removes its screening action target", () => {
        const pipeline = pipelineWithShot();
        const final = createCanvasNode(CanvasNodeType.Video, { x: 0, y: 0 }, { workflowKind: "final", status: "success", content: "final.mp4" });
        const before = deriveShortDramaProgress([...pipeline.nodes, final], pipeline.connections);
        const after = deriveShortDramaProgress(pipeline.nodes, pipeline.connections);
        expect(before.steps.find((step) => step.id === "review")!.tasks.find((task) => task.id === "review.audit")!.nodeId).toBe(final.id);
        expect(after.steps.find((step) => step.id === "review")!.tasks.find((task) => task.id === "review.audit")!.nodeId).toBeUndefined();
        expect(after.steps.find((step) => step.id === "review")!.tasks.find((task) => task.id === "review.audit")!.ready).not.toBe(true);
    });
});
