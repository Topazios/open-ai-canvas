import { describe, expect, test } from "bun:test";
import { createStoryDevelopmentChain, prepareStoryEpisodeBatch, saveStoryDevelopmentNode, storySourceState } from "../src/lib/canvas/canvas-story-development";
import { newStorySession, receiveStoryTask, recoverStorySession, restoreStoryRevision } from "../src/services/story-development-session";
import type { GenerationTask } from "../src/services/api/task-center";

function fixture() {
    const chain = createStoryDevelopmentChain({ x: 0, y: 0 });
    let nodes = chain.nodes;
    for (const node of chain.nodes.slice(0, 3)) nodes = saveStoryDevelopmentNode(nodes, node, node.title!, "已确认的完整上游内容", node.metadata!.storyDevelopment!);
    return { nodes, connections: chain.connections, body: nodes[3] };
}
describe("episode batches", () => {
    test("creates the selected episode range with independent IDs and outline dependencies", () => {
        const { nodes, connections, body } = fixture();
        const result = prepareStoryEpisodeBatch(body.id, nodes, connections, 2, 4);
        expect(result.targets.map((node) => node.metadata!.storyDevelopment!.episodeNumber)).toEqual([2, 3, 4, 5]);
        expect(new Set(result.targets.map((node) => node.id)).size).toBe(4);
        for (const node of result.targets) {
            expect(storySourceState(node.metadata!.storyDevelopment!, result.nodes).missing).toBe(false);
            expect(result.connections.some((edge) => edge.fromNodeId === nodes[2].id && edge.toNodeId === node.id)).toBe(true);
        }
        expect(result.nodes.find((node) => node.id === body.id)).toBe(body);
        expect(prepareStoryEpisodeBatch(body.id, result.nodes, result.connections, 2, 4).nodes).toEqual(result.nodes);
    });
    test("preserves completed bodies and excludes local drafts or active jobs", () => {
        const { nodes, connections, body } = fixture();
        const created = prepareStoryEpisodeBatch(body.id, nodes, connections, 1, 4);
        const first = saveStoryDevelopmentNode(created.nodes, body, body.title!, "已有正文不可覆盖", body.metadata!.storyDevelopment!);
        const result = prepareStoryEpisodeBatch(body.id, first, created.connections, 1, 4, [created.targets[1].id, created.targets[2].id]);
        expect(result.targets.map((node) => node.metadata!.storyDevelopment!.episodeNumber)).toEqual([4]);
        expect(result.skipped).toEqual([1, 2, 3]);
        expect(result.nodes.find((node) => node.id === body.id)!.metadata!.content).toBe("已有正文不可覆盖");
    });
    test("rejects invalid ranges, duplicate episodes, missing source or unreviewed upstream", () => {
        const { nodes, connections, body } = fixture();
        for (const [start, count] of [[0, 2], [1, 0], [12, 2], [1.5, 2], [1, NaN]]) expect(() => prepareStoryEpisodeBatch(body.id, nodes, connections, start, count)).toThrow();
        expect(() => prepareStoryEpisodeBatch(body.id, nodes.filter((node) => node.id !== body.id), connections, 1, 3)).toThrow("删除");
        expect(() => prepareStoryEpisodeBatch(body.id, [...nodes, { ...body, id: "duplicate" }], connections, 1, 3)).toThrow("多个正文");
        const changed = saveStoryDevelopmentNode(nodes, nodes[0], "修改选题", "改变故事", nodes[0].metadata!.storyDevelopment!);
        expect(() => prepareStoryEpisodeBatch(body.id, changed, connections, 1, 3)).toThrow("复核");
    });
    test("per-episode results recover independently, keep batch membership and remain undoable", () => {
        const { body } = fixture();
        const original = newStorySession(body, "fixture");
        original.episodeBatch = { id: "batch", items: [{ nodeId: body.id, episodeNumber: 1, operationId: "operation" }], skipped: [] };
        original.job = { operationId: "operation", status: "submitting", draw: false, topicCount: 4, draft: "", signatures: {}, batchOwnerNodeId: body.id };
        const recovered = recoverStorySession(original, body, "fixture");
        expect(recovered.job?.status).toBe("unknown");
        const result = receiveStoryTask(recovered, { id: "task", status: "succeeded", resultJson: JSON.stringify({ text: "第一集正文" }) } as GenerationTask);
        expect(result.content).toBe("第一集正文");
        expect(result.episodeBatch).toEqual(original.episodeBatch);
        expect(result.job?.batchOwnerNodeId).toBe(body.id);
        expect(restoreStoryRevision(result).content).toBe("");
        const failed = receiveStoryTask(recovered, { id: "task", status: "failed", error: "upstream failed" } as GenerationTask);
        expect(failed.content).toBe("");
        expect(failed.job?.status).toBe("failed");
    });
});
