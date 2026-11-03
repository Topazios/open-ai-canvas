import { describe, expect, test } from "bun:test";

import { removeCanvasNodes } from "../src/lib/canvas/canvas-project-domain";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

function node(id: string, shortDrama?: Record<string, unknown>, parentId?: string): CanvasNodeData {
    return {
        id,
        type: shortDrama?.role === "collection" ? CanvasNodeType.Frame : CanvasNodeType.Text,
        title: id,
        position: { x: 0, y: 0 },
        width: 320,
        height: 240,
        parentId,
        metadata: shortDrama ? ({ shortDrama: { stage: "story", sourceNodeIds: [], sourceSignatures: {}, pipelineId: "p", ...shortDrama } } as CanvasNodeData["metadata"]) : undefined,
    };
}

describe("删除制作方案容器", () => {
    test("独立总纲随容器一起删除，无关节点保留", () => {
        const story = node("story", { step: "story.plan", role: "document", planSection: "story" });
        const container = node("container", { step: "story.plan", role: "collection", sourceNodeIds: ["story", "child"] });
        const child = node("child", { step: "story.plan", role: "document", planSection: "characters" }, "container");
        const otherStory = node("other-story", { step: "story.plan", role: "document", planSection: "story" });
        const topic = node("topic", { step: "story.topic", role: "document" });

        const result = removeCanvasNodes([topic, story, container, child, otherStory], new Set(["container"]));

        expect(result.nodes.map((entry) => entry.id).sort()).toEqual(["other-story", "topic"]);
    });
});
