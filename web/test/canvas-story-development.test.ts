import { describe, expect, test } from "bun:test";
import { advanceStoryDevelopment, buildStoryDevelopmentPrompt, createNextStoryEpisode, createStoryDevelopmentChain, ensureStoryDevelopmentChain, parseStoryTopics, saveStoryDevelopmentNode, storySourceState, storyStageLabel } from "@/lib/canvas/canvas-story-development";
import { createShortDramaPipeline, deriveShortDramaProgress } from "@/lib/canvas/canvas-short-drama";
import { createCanvasNode } from "@/lib/canvas/canvas-project-domain";
import { CanvasNodeType } from "@/types/canvas";
import { defaultShortDramaSettings, DramaEnding } from "@/lib/short-drama-settings";

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
        expect(chain.slice(0, 3).map((node) => node.width)).toEqual([560, 560, 560]);
        expect(chain.at(-1)!.width).toBe(400);
        expect(chain.slice(1).map((node, index) => node.position.x - chain[index].position.x)).toEqual([640, 640, 640]);
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
        expect(prompt).toContain("第 3 集"); expect(prompt).toContain("改善对白"); expect(prompt).toContain("世界规则"); expect(prompt).not.toContain("UNRELATED_SECRET");
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
    test("fresh topic draws avoid anchoring on an adopted draft but retain explicitly imported Markdown", () => {
        const { nodes } = createStoryDevelopmentChain({ x: 0, y: 0 });
        const topic = { ...nodes[0].metadata!.storyDevelopment!, brief: { ...nodes[0].metadata!.storyDevelopment!.brief!, genre: "爱情", style: "悬疑", premise: "主角守护一处社区空间" } };
        const previousCandidate = "旧候选：收集证据夺回公司";
        const fresh = buildStoryDevelopmentPrompt(topic, nodes, previousCandidate, "", true);
        expect(fresh).not.toContain(previousCandidate);
        expect(fresh).not.toContain("当前草稿");
        expect(fresh).toContain("候选间不得重复同一冲突机制");
        expect(fresh).toContain("故事发生地");
        const imported = buildStoryDevelopmentPrompt({ ...topic, topicSourceKind: "imported" }, nodes, "# 导入故事\n主角守护社区的旧电影院。", "", true);
        expect(imported).toContain("用户导入的原始选题材料");
        expect(imported).toContain("主角守护社区的旧电影院");
        expect(imported).not.toContain("当前草稿");
        expect(() => buildStoryDevelopmentPrompt({ ...topic, topicSourceKind: "imported", brief: { ...topic.brief!, genre: "", style: "", premise: "" } }, nodes, "用户导入故事", "", true)).not.toThrow();
        const edit = buildStoryDevelopmentPrompt(topic, nodes, previousCandidate, "保留设定，调整动机", false);
        expect(edit).toContain(previousCandidate);
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
    test("production plan is regenerated from the adopted topic instead of the old draft", () => {
        const nodes = writtenChain();
        const prompt = buildStoryDevelopmentPrompt(nodes[1].metadata!.storyDevelopment!, nodes, "旧版本完整故事正文", "补全缺项");
        for (const requirement of ["故事总纲", "结局遵循全局设置与用户要求", "人物弧光", "集数分配", "伏笔与回收", "AI生成可行性", "本次故事总纲必须重新从当前已采用选题推演"]) expect(prompt).toContain(requirement);
        expect(prompt).not.toContain("旧版本完整故事正文");
        expect(prompt).not.toContain("当前草稿");
        const next = advanceStoryDevelopment(nodes[1].id, nodes, []);
        expect(next.node).toBe(nodes[2]);
        expect(next.node.metadata!.storyDevelopment!.stage).toBe("episodes");
        expect(next.node.metadata!.content).toBe(nodes[2].metadata!.content);
        expect(next.connections.some((edge) => edge.fromNodeId === nodes[1].id && edge.toNodeId === nodes[2].id)).toBe(true);
    });
    test("plan honors an open ending and stays within the story outline task", () => {
        const nodes = writtenChain();
        nodes[0].metadata!.storyDevelopment!.brief!.globalSettings = { ...defaultShortDramaSettings(), ending: DramaEnding.Open };
        const prompt = buildStoryDevelopmentPrompt(nodes[1].metadata!.storyDevelopment!, nodes, "", "");
        expect(prompt).toContain("结局偏好：开放结局");
        expect(prompt).toContain("开放结局应交代阶段结果和保留悬念");
        expect(prompt).not.toContain("明确结局");
        expect(prompt).not.toContain("不以悬念代替结局");
        expect(prompt).toContain("根据已采用选题，仅输出独立的故事总纲与世界规则");
        expect(prompt).toContain("完成后结束本步骤");
        expect(prompt).not.toContain("全剧资产清单与系统编码");
        expect(prompt).not.toContain("视觉与美术规范");
        expect(prompt).not.toContain("导演与视听规范");
        expect(prompt).not.toContain("生成与一致性规范");
    });
    test("legacy outline is optional even empty, deleted or stale; required plan still gates generation", () => {
        for (const content of ["", "LEGACY_REFERENCE"]) {
            const nodes = writtenChain();
            const legacy = createCanvasNode(CanvasNodeType.Text, { x: 0, y: 400 }, { content, storyDevelopment: { stage: "outline", pipelineId: nodes[0].metadata!.storyDevelopment!.pipelineId, sourceNodeIds: [nodes[0].id, nodes[1].id], sourceSignatures: { [nodes[1].id]: "old-plan" } } });
            const legacyNodes = nodes.map((node) => ["episodes", "body"].includes(node.metadata!.storyDevelopment!.stage) ? { ...node, metadata: { ...node.metadata, storyDevelopment: { ...node.metadata!.storyDevelopment!, sourceNodeIds: [...node.metadata!.storyDevelopment!.sourceNodeIds, legacy.id] } } } : node);
            expect(buildStoryDevelopmentPrompt(nodes[1].metadata!.storyDevelopment!, [...legacyNodes, legacy], "旧版本总纲", "")).not.toContain("LEGACY_REFERENCE");
            expect(buildStoryDevelopmentPrompt(nodes[1].metadata!.storyDevelopment!, [...legacyNodes, legacy], "旧版本总纲", "")).not.toContain("旧版本总纲");
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
