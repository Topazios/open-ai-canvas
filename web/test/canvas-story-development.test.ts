import { describe, expect, test } from "bun:test";
import { advanceStoryDevelopment, buildStoryDevelopmentPrompt, createNextStoryEpisode, createStoryDevelopmentChain, ensureStoryDevelopmentChain, parseStoryTopics, saveStoryDevelopmentNode, storySourceState, storyStageLabel } from "@/lib/canvas/canvas-story-development";
import { createShortDramaPipeline, deriveShortDramaProgress } from "@/lib/canvas/canvas-short-drama";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { CanvasNodeType } from "@/types/canvas";

function writtenChain() {
    let { nodes } = createStoryDevelopmentChain({ x: 0, y: 0 });
    for (const original of nodes) nodes = saveStoryDevelopmentNode(nodes, original, original.title!, `${original.title}正文`, original.metadata!.storyDevelopment!);
    return nodes;
}
describe("story development", () => {
    test("four distinct linked documents precede storyboard", () => {
        const pipeline = createShortDramaPipeline({ x: 0, y: 0 });
        const chain = pipeline.nodes.filter((node) => node.metadata?.storyDevelopment);
        expect(chain.map((node) => node.metadata!.storyDevelopment!.stage)).toEqual(["topic", "plan", "episodes", "body"]);
        expect(new Set(chain.map((node) => node.id)).size).toBe(4);
        expect(pipeline.connections.some((edge) => edge.fromNodeId === chain.at(-1)!.id && edge.toNodeId === pipeline.scriptNodeId)).toBe(true);
        expect(chain.at(-1)!.metadata!.storyDevelopment!.sourceNodeIds).toEqual(chain.slice(0, -1).map((node) => node.id));
    });
    test("legacy nodes are preserved; explicit creation is idempotent and repairs missing steps", () => {
        const legacy = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { workflowKind: "story_input", content: "旧故事原文" });
        const first = ensureStoryDevelopmentChain([legacy], [], { x: 0, y: 500 });
        const second = ensureStoryDevelopmentChain(first.nodes, first.connections, { x: 999, y: 999 });
        expect(second.nodes[0]).toBe(legacy);
        expect(second.nodes.length).toBe(5);
        expect(second.connections).toEqual(first.connections);
        const deleted = first.chain[2].id;
        const repaired = ensureStoryDevelopmentChain(first.nodes.filter((node) => node.id !== deleted), first.connections.filter((edge) => edge.toNodeId !== deleted && edge.fromNodeId !== deleted), { x: 0, y: 500 });
        expect(repaired.nodes.find((node) => node.id === first.chain.at(-1)!.id)!.metadata!.storyDevelopment!.sourceNodeIds).not.toContain(deleted);
        expect(repaired.nodes[0]).toBe(legacy);
    });
    test("saved upstream revisions become stale without overwriting downstream content", () => {
        const nodes = writtenChain();
        const body = nodes.at(-1)!;
        expect(storySourceState(body.metadata!.storyDevelopment!, nodes).stale).toBe(false);
        const revised = saveStoryDevelopmentNode(nodes, nodes[0], "新题目", "新的冲突", nodes[0].metadata!.storyDevelopment!);
        expect(storySourceState(body.metadata!.storyDevelopment!, revised).stale).toBe(true);
        expect(revised.at(-1)).toBe(body);
        expect(storySourceState(body.metadata!.storyDevelopment!, revised).upstreamStale).toBe(true);
        expect(() => buildStoryDevelopmentPrompt(body.metadata!.storyDevelopment!, revised, "", "")).toThrow("前序节点待复核");
        expect(storySourceState(body.metadata!.storyDevelopment!, nodes.slice(1)).missing).toBe(true);
    });
    test("save merges moved geometry but rejects concurrent document edits or deletion", () => {
        const nodes = writtenChain();
        const original = nodes[0];
        const moved = nodes.map((node) => node.id === original.id ? { ...node, position: { x: 900, y: 750 } } : node);
        const result = saveStoryDevelopmentNode(moved, original, "新标题", "新内容", original.metadata!.storyDevelopment!);
        expect(result[0].position).toEqual({ x: 900, y: 750 });
        expect(result[1]).toBe(nodes[1]);
        expect(() => saveStoryDevelopmentNode(result, original, "覆盖", "旧内容", original.metadata!.storyDevelopment!)).toThrow("其他操作");
        expect(() => saveStoryDevelopmentNode([], original, "标题", "正文", original.metadata!.storyDevelopment!)).toThrow("已删除");
    });
    test("prompts use only this chain and target episode; missing upstream blocks AI", () => {
        const nodes = writtenChain();
        const extra = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 0 }, { content: "UNRELATED_SECRET" });
        const body = nodes.at(-1)!.metadata!.storyDevelopment!;
        const prompt = buildStoryDevelopmentPrompt({ ...body, episodeNumber: 3 }, [...nodes, extra], "草稿", "改善对白");
        expect(prompt).toContain("第 3 集"); expect(prompt).toContain("改善对白"); expect(prompt).toContain("制作方案正文"); expect(prompt).not.toContain("UNRELATED_SECRET");
        expect(() => buildStoryDevelopmentPrompt(body, nodes.slice(1), "", "")).toThrow("前序节点");
        expect(() => buildStoryDevelopmentPrompt({ ...body, sourceNodeIds: [] }, [], "", "")).toThrow("前序节点");
    });
    test("candidate schema is validated before adoption", () => {
        const value = { title: "题目", logline: "人物目标", conflict: "冲突", appeal: "悬疑" };
        expect(parseStoryTopics(JSON.stringify({ topics: [value, value, value] }))).toHaveLength(3);
        expect(() => parseStoryTopics('{"topics":[{"title":"不完整"},{}]}')).toThrow();
        expect(() => parseStoryTopics("空结果")).toThrow();
    });
    test("topic generation honors batch size and excludes hidden production fields", () => {
        const { nodes } = createStoryDevelopmentChain({ x: 0, y: 0 });
        const data = nodes[0].metadata!.storyDevelopment!;
        data.brief = { ...data.brief!, genre: "奇幻", style: "悬疑", premise: "相机改写选择", audience: "HIDDEN_AUDIENCE", topicCount: 7 };
        const prompt = buildStoryDevelopmentPrompt(data, nodes, "", "", true);
        expect(prompt).toContain("一次生成 7 个");
        expect(prompt).not.toContain("HIDDEN_AUDIENCE");
        expect(prompt).not.toContain("episodeCount");
        const candidate = { title: "标题", logline: "故事", conflict: "冲突", appeal: "看点" };
        expect(parseStoryTopics(JSON.stringify({ topics: [candidate] }), 1)).toHaveLength(1);
        expect(parseStoryTopics(JSON.stringify({ topics: Array(10).fill(candidate) }), 10)).toHaveLength(10);
        expect(() => parseStoryTopics(JSON.stringify({ topics: [candidate] }), 7)).toThrow("与要求");
        expect(() => parseStoryTopics(JSON.stringify({ topics: Array(11).fill(candidate) }))).toThrow();
        delete data.brief.topicCount;
        expect(buildStoryDevelopmentPrompt(data, nodes, "", "", true)).toContain("一次生成 4 个");
    });
    test("one written episode is not whole-season readiness; each new body is separate", () => {
        const nodes = writtenChain();
        expect(deriveShortDramaProgress(nodes, []).steps[0].tasks.at(-1)!.ready).toBe(false);
        const body = nodes.at(-1)!;
        const second = createNextStoryEpisode(body, nodes);
        expect(second.metadata!.storyDevelopment!.episodeNumber).toBe(2);
        expect(second.metadata!.content).toBe("");
        expect(second.metadata!.storyDevelopment!.sourceNodeIds).toEqual(body.metadata!.storyDevelopment!.sourceNodeIds);
        expect(body.metadata!.content).toBe("第 1 集 · 正文正文");
    });
    test("production plan includes story architecture and directly opens existing episode outlines", () => {
        const nodes = writtenChain();
        const prompt = buildStoryDevelopmentPrompt(nodes[1].metadata!.storyDevelopment!, nodes, "已有制作方案", "补全缺项");
        for (const requirement of ["故事总纲", "明确结局", "人物弧光", "集数分配", "伏笔与回收", "AI生成可行性", "已有制作方案"]) expect(prompt).toContain(requirement);
        const next = advanceStoryDevelopment(nodes[1].id, nodes, []);
        expect(next.node).toBe(nodes[2]);
        expect(next.node.metadata!.storyDevelopment!.stage).toBe("episodes");
        expect(next.node.metadata!.content).toBe(nodes[2].metadata!.content);
        expect(next.connections.some((edge) => edge.fromNodeId === nodes[1].id && edge.toNodeId === nodes[2].id)).toBe(true);
    });
    test("legacy outline is optional even empty, deleted or stale; required plan still gates generation", () => {
        for (const content of ["", "LEGACY_REFERENCE"]) {
            const nodes = writtenChain();
            const legacy = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 400 }, { content, storyDevelopment: { stage: "outline", pipelineId: nodes[0].metadata!.storyDevelopment!.pipelineId, sourceNodeIds: [nodes[0].id, nodes[1].id], sourceSignatures: { [nodes[1].id]: "old-plan" } } });
            const legacyNodes = nodes.map((node) => ["episodes", "body"].includes(node.metadata!.storyDevelopment!.stage) ? { ...node, metadata: { ...node.metadata, storyDevelopment: { ...node.metadata!.storyDevelopment!, sourceNodeIds: [...node.metadata!.storyDevelopment!.sourceNodeIds, legacy.id] } } } : node);
            // Match an old saved body to its old episode document, including the legacy dependency.
            const bodyData = legacyNodes[3].metadata!.storyDevelopment!;
            bodyData.sourceSignatures = storySourceState(bodyData, legacyNodes).signatures;
            for (const present of [true, false]) {
                const all = present ? [...legacyNodes, legacy] : legacyNodes;
                for (const node of legacyNodes.slice(2)) {
                    const state = storySourceState(node.metadata!.storyDevelopment!, all);
                    expect(state.missing).toBe(false); expect(state.stale).toBe(false); expect(state.upstreamStale).toBe(false);
                    expect(buildStoryDevelopmentPrompt(node.metadata!.storyDevelopment!, all, "", "")).not.toContain("LEGACY_REFERENCE");
                    expect(storySourceState(node.metadata!.storyDevelopment!, all.filter((item) => item.id !== nodes[1].id)).missing).toBe(true);
                }
                const next = advanceStoryDevelopment(nodes[1].id, all, []);
                expect(next.node.id).toBe(nodes[2].id);
                expect(next.node.metadata!.content).toBe(nodes[2].metadata!.content);
                expect(next.node.metadata!.storyDevelopment!.sourceNodeIds).toEqual([nodes[0].id, nodes[1].id]);
                if (present) expect(next.nodes.find((node) => node.id === legacy.id)).toBe(legacy);
                expect(storySourceState(nodes[1].metadata!.storyDevelopment!, all).references).toEqual(present && content ? [legacy] : []);
            }
        }
    });
    test("legacy outline remains editable and advances to episodes instead of topic", () => {
        const nodes = writtenChain();
        const legacy = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 400 }, { content: "保留原文", storyDevelopment: { stage: "outline", pipelineId: nodes[0].metadata!.storyDevelopment!.pipelineId, sourceNodeIds: [nodes[0].id, nodes[1].id] } });
        const all = [...nodes, legacy];
        expect(storyStageLabel("outline")).toContain("历史参考");
        expect(buildStoryDevelopmentPrompt(legacy.metadata!.storyDevelopment!, all, "保留原文", "调整")).toContain("保留原文");
        expect(advanceStoryDevelopment(legacy.id, all, []).node.id).toBe(nodes[2].id);
        const ensured = ensureStoryDevelopmentChain(all, [], { x: 0, y: 0 });
        expect(ensured.nodes.find((node) => node.id === legacy.id)).toBe(legacy);
        expect(ensured.chain).toHaveLength(4);
        expect(ensured.connections.some((edge) => edge.fromNodeId === nodes[1].id && edge.toNodeId === nodes[2].id)).toBe(true);
    });
});
