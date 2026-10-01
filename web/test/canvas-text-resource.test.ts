import { expect, test } from "bun:test";

import { remapImportedNodeResource, restoreCanvasTextResources } from "@/lib/canvas/canvas-text-resource";
import { resourceFileUrl } from "@/services/api/resources";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const textNode: CanvasNodeData = {
    id: "script",
    type: CanvasNodeType.Text,
    title: "剧本.txt",
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
    metadata: { storageKey: "resource:old", content: "第一场：开场", prompt: "第一场：开场", mimeType: "text/plain" },
};

test("import remaps the text file reference without replacing its body", () => {
    const result = remapImportedNodeResource(textNode, { storageKey: "resource:new", url: resourceFileUrl("new") });
    expect(result.metadata?.storageKey).toBe("resource:new");
    expect(result.metadata?.content).toBe("第一场：开场");
    expect(result.metadata?.prompt).toBe("第一场：开场");
    const image = remapImportedNodeResource({ ...textNode, type: CanvasNodeType.Image }, { storageKey: "resource:new", url: resourceFileUrl("new") });
    expect(image.metadata?.content).toBe(resourceFileUrl("new"));
    const legacy = remapImportedNodeResource({ ...textNode, metadata: { ...textNode.metadata, content: resourceFileUrl("old"), prompt: resourceFileUrl("old") } }, { storageKey: "resource:new", url: resourceFileUrl("new"), textContent: "第一场：开场" });
    expect(legacy.metadata?.content).toBe("第一场：开场");
    expect(legacy.metadata?.prompt).toBe("第一场：开场");
});

test("legacy text URL restores from its uploaded file without touching edited text", async () => {
    const project = {
        nodes: [
            { ...textNode, metadata: { ...textNode.metadata, content: resourceFileUrl("old"), prompt: resourceFileUrl("old") } },
            textNode,
            { ...textNode, id: "image", type: CanvasNodeType.Image, metadata: { ...textNode.metadata, content: resourceFileUrl("old") } },
        ],
    } as CanvasProject;
    let reads = 0;
    const restored = await restoreCanvasTextResources(project, async (key) => {
        expect(key).toBe("resource:old");
        reads += 1;
        return "第一场：开场";
    });
    expect(reads).toBe(1);
    expect(restored.nodes[0].metadata?.content).toBe("第一场：开场");
    expect(restored.nodes[0].metadata?.prompt).toBe("第一场：开场");
    expect(restored.nodes[1]).toBe(textNode);
    expect(restored.nodes[2].metadata?.content).toBe(resourceFileUrl("old"));
});
