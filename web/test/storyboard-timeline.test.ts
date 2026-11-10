import { expect, test } from "bun:test";
import { appendStoryboardToTimeline, buildTimelineFromNodes } from "@/lib/timeline/timeline-build";
import { nodeWorkflow } from "@/lib/canvas/canvas-short-drama-workflow";
import { workflowImageFixture } from "./fixtures/workflow-image-project";

test("storyboard editing imports inline videos in episode order, skips unfinished shots and preserves edits", () => {
    const f = workflowImageFixture();
    const collection = f.nodes.find(node => nodeWorkflow(node)?.step === "direction.shots" && nodeWorkflow(node)?.role === "collection")!;
    const scripts = f.nodes.filter(node => node.parentId === collection.id).sort((a, b) => nodeWorkflow(a)!.episodeNumber! - nodeWorkflow(b)!.episodeNumber!);
    for (const script of scripts) {
        script.metadata!.storyboard!.rows[0].videoGeneration = { taskStatus: "succeeded", storageKey: `${script.id}.mp4`, durationMs: 6000 };
        script.metadata!.storyboard!.rows[1].videoGeneration = { taskStatus: "running" };
    }
    const initial = appendStoryboardToTimeline(collection, [...f.nodes].reverse(), buildTimelineFromNodes([]));
    expect(initial.clips.map(clip => clip.title)).toEqual(["第 1 集 · SH01", "第 2 集 · SH01"]);
    expect(initial.clips.map(clip => clip.startMs)).toEqual([0, 6000]);
    expect(initial.clips[0].directMedia?.storageKey).toBe(`${scripts[0].id}.mp4`);
    const edited = { ...initial, clips: initial.clips.map(clip => ({ ...clip, durationMs: 3000, sourceStartMs: 1000 })) };
    expect(appendStoryboardToTimeline(collection, f.nodes, edited)).toBe(edited);
    scripts[1].metadata!.storyboard!.rows[1].videoGeneration = { taskStatus: "succeeded", content: "https://example.test/shot.mp4", durationMs: 4000 };
    const appended = appendStoryboardToTimeline(collection, f.nodes, edited);
    expect(appended.clips).toHaveLength(3);
    expect(appended.clips.slice(0, 2)).toEqual(edited.clips);
    expect(appended.clips[2].startMs).toBe(9000);
    expect(appended.clips[2].directMedia?.url).toBe("https://example.test/shot.mp4");
});
