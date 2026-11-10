import { expect, test } from "bun:test";
import { createShortDramaPipeline } from "@/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowAncestors, workflowGenerationSources, workflowSignature, workflowSourceSignaturesMatch } from "@/lib/canvas/canvas-short-drama-workflow";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function fixture() {
    const pipeline = createShortDramaPipeline({ x: 0, y: 0 }, true);
    const topic = pipeline.nodes[0];
    topic.metadata!.content = "选定故事与冲突";
    const request = { step: "story.plan" as const, pipelineId: nodeWorkflow(topic)!.pipelineId, sourceNodeIds: [topic.id], model: "fixture", instruction: "", episodeCount: 3, minutesPerEpisode: "2", start: 1, count: 1 };
    const plan = createWorkflowDocuments(request, pipeline.nodes, pipeline.connections, { x: 0, y: 0 });
    const manifest = plan.created[0];
    const frame = plan.nodes.find(node => node.id === manifest.parentId)!;
    const data = nodeWorkflow(manifest)!;
    const story: CanvasNodeData = { ...manifest, id: "story", title: "故事总纲与世界规则", metadata: {
        status: "success", content: "完整故事总纲：既定人物经历冲突、选择、转折并在结局完成成长。",
        shortDrama: { ...data, productionAgent: undefined, assetKey: "story", planSection: "story" as never, assetOutput: false },
    } };
    const direction: CanvasNodeData = { ...story, id: "direction", title: "导演与视听规范", metadata: {
        status: "loading", content: "等待生成", shortDrama: { ...nodeWorkflow(story)!, assetKey: "direction", planSection: "direction" as never },
    } };
    plan.nodes.push(story, direction);
    nodeWorkflow(frame)!.sourceNodeIds = [manifest.id, story.id, direction.id];
    // The shared task anchor is reused when other plan documents start.
    manifest.metadata!.status = "loading";
    nodeWorkflow(manifest)!.assetOutput = false;
    nodeWorkflow(manifest)!.materializedTaskId = "saved-outline-run";
    nodeWorkflow(frame)!.planReady = true;
    plan.connections.push({ id: "topic-plan", fromNodeId: topic.id, toNodeId: frame.id });
    const episodes = { ...request, step: "story.episodes" as const, sourceNodeIds: [frame.id] };
    return { ...plan, topic, frame, manifest, story, direction, request: episodes };
}

test("saved v5 outline unlocks the generator while the shared summary is running or failed", () => {
    const f = fixture();
    for (const status of ["idle", "loading", "error"] as const) {
        f.manifest.metadata!.status = status;
        nodeWorkflow(f.manifest)!.assetOutput = true;
        nodeWorkflow(f.manifest)!.materializedTaskId = undefined;
        nodeWorkflow(f.frame)!.planReady = false;
        const before = JSON.stringify(f.nodes);
        expect(defaultWorkflowSources("story.episodes", f.request.pipelineId, f.nodes)).toEqual([f.frame.id]);
        const sources = workflowGenerationSources(f.request, f.nodes, f.connections);
        expect(sources.map(node => node.id)).toEqual([f.topic.id, f.story.id]);
        expect(JSON.stringify(f.nodes)).toBe(before);
        const result = createWorkflowDocuments(f.request, f.nodes, f.connections, { x: 0, y: 0 });
        const outline = result.created[0];
        expect(nodeWorkflow(outline)?.textBatch).toMatchObject({ version: 3, episodeCount: 3 });
        expect(outline.metadata?.prompt).toContain("第 1–3 集");
        expect(nodeWorkflow(outline)?.sourceSignatures).not.toHaveProperty(f.manifest.id);
        expect(nodeWorkflow(outline)?.sourceSignatures).not.toHaveProperty(f.frame.id);
    }
});

test("later plan tasks do not invalidate saved episode outlines or block body generation", () => {
    const f = fixture();
    const result = createWorkflowDocuments(f.request, f.nodes, f.connections, { x: 0, y: 0 });
    const outline = result.created[0];
    Object.assign(outline.metadata!, { status: "success", content: "## 第 1 集｜开端\n人物作出选择。\n## 第 2 集｜代价\n选择造成后果。\n## 第 3 集｜结局\n冲突得到解决。" });
    expect(defaultWorkflowSources("story.episodes", f.request.pipelineId, result.nodes, outline.id)).toEqual([f.frame.id]);
    f.manifest.metadata!.status = "error";
    f.direction.metadata!.status = "error";
    nodeWorkflow(f.frame)!.sourceNodeIds.push("unrelated-pending-document");
    expect(workflowSourceSignaturesMatch(nodeWorkflow(outline)!, result.nodes)).toBe(true);
    expect(() => workflowAncestors([outline.id], result.nodes, f.request.pipelineId, result.connections)).not.toThrow();
    const body = createWorkflowDocuments({ ...f.request, step: "story.body", sourceNodeIds: [outline.id] }, result.nodes, result.connections, { x: 0, y: 0 });
    expect(nodeWorkflow(body.created[0])?.episodeNumber).toBe(1);
    Object.assign(body.created[0].metadata!, { status: "success", content: "完整本集正文" });
    expect(() => workflowGenerationSources({ ...f.request, step: "assets.characters", sourceNodeIds: [body.created[0].id, f.frame.id] }, body.nodes, body.connections)).toThrow("请先完成制作方案");
    f.story.metadata!.content += "总纲剧情改变";
    expect(workflowSourceSignaturesMatch(nodeWorkflow(outline)!, result.nodes)).toBe(false);
    expect(() => workflowAncestors([outline.id], result.nodes, f.request.pipelineId, result.connections)).toThrow("前文已更新");
});

test("outline generation retains completed asset codes from its own plan only", () => {
    const f = fixture();
    const group: CanvasNodeData = { ...f.frame, id: "characters", metadata: { shortDrama: {
        ...nodeWorkflow(f.frame)!, planVersion: 2, sourceNodeIds: ["character"], planGroup: { rootFrameId: f.frame.id, kind: "character" },
    } } };
    const character: CanvasNodeData = { ...f.story, id: "character", parentId: group.id, title: "主角", type: CanvasNodeType.Text, metadata: {
        status: "success", content: "主角完整外貌资料，不必重复携带。", shortDrama: {
            ...nodeWorkflow(f.story)!, assetKey: "hero", planSection: undefined, sourceNodeIds: [f.frame.id], sourceSteps: ["story.plan"], sourceSignatures: {},
            assetIdentity: { id: "hero", code: "CHR-0001", kind: "character" },
            planAsset: { key: "hero", kind: "character", name: "主角", episodes: [1] },
        },
    } };
    nodeWorkflow(f.frame)!.planGroups = { character: group.id };
    f.nodes.push(group, character);
    f.connections.push({ id: "plan-characters", fromNodeId: f.frame.id, toNodeId: group.id });
    const result = createWorkflowDocuments(f.request, f.nodes, f.connections, { x: 0, y: 0 });
    const input = nodeWorkflow(result.created[0])!.textBatch!.units.map(unit => unit.text).join("\n");
    expect(input).toContain("CHR-0001");
    expect(input).not.toContain("主角完整外貌资料");
    expect(defaultWorkflowSources("story.episodes", f.request.pipelineId, f.nodes, character.id)).toEqual([f.frame.id]);
    character.metadata!.status = "loading";
    expect(workflowGenerationSources(f.request, f.nodes, f.connections).some(node => node.id === character.id)).toBe(false);
    character.metadata!.status = "success";
    nodeWorkflow(group)!.planGroup!.rootFrameId = "another-plan";
    expect(workflowGenerationSources(f.request, f.nodes, f.connections).some(node => node.id === character.id)).toBe(false);
});

test("assets completing during save do not change a queued outline input snapshot", () => {
    const f = fixture();
    const result = createWorkflowDocuments(f.request, f.nodes, f.connections, { x: 0, y: 0 });
    const outline = result.created[0];
    const before = workflowGenerationSources(nodeWorkflow(outline)!, result.nodes, result.connections).map(node => [node.id, workflowSignature(node)]);
    f.direction.metadata!.status = "success";
    f.direction.metadata!.content = "叙事视角与信息揭示规则：只呈现主角已知信息。";
    const after = workflowGenerationSources(nodeWorkflow(outline)!, result.nodes, result.connections).map(node => [node.id, workflowSignature(node)]);
    expect(after).toEqual(before);
    expect(workflowSourceSignaturesMatch(nodeWorkflow(outline)!, result.nodes)).toBe(true);
    outline.metadata!.content = "完整分集集纲";
    outline.metadata!.status = "success";
    expect(workflowAncestors([outline.id], result.nodes, f.request.pipelineId, result.connections).some(node => node.id === f.direction.id)).toBe(false);
    const next = createWorkflowDocuments(f.request, f.nodes, f.connections, { x: 0, y: 0 });
    expect(nodeWorkflow(next.created[0])!.sourceSignatures).toHaveProperty(f.direction.id);
});

for (const invalid of ["missing", "empty", "loading", "error", "placeholder", "duplicate", "moved", "pipeline", "version", "stale", "disconnected", "cycle"] as const) {
    test(`invalid outline source still blocks generation: ${invalid}`, () => {
        const f = fixture();
        if (invalid === "missing") f.nodes = f.nodes.filter(node => node.id !== f.story.id);
        if (invalid === "empty") f.story.metadata!.content = "";
        if (invalid === "loading" || invalid === "error") f.story.metadata!.status = invalid;
        if (invalid === "placeholder") nodeWorkflow(f.story)!.planGeneration = { runId: "run", status: "queued" };
        if (invalid === "duplicate") {
            const duplicate = { ...f.story, id: "second-story" };
            f.nodes.push(duplicate);
            nodeWorkflow(f.frame)!.sourceNodeIds.push(duplicate.id);
        }
        if (invalid === "moved") f.story.parentId = "another-plan";
        if (invalid === "pipeline") nodeWorkflow(f.story)!.pipelineId = "another-pipeline";
        if (invalid === "version") nodeWorkflow(f.story)!.version = 999;
        if (invalid === "stale") f.topic.metadata!.content += "选题已修改";
        if (invalid === "disconnected") f.connections = [];
        if (invalid === "cycle") {
            nodeWorkflow(f.story)!.sourceNodeIds = [f.frame.id];
            nodeWorkflow(f.story)!.sourceSignatures = { [f.frame.id]: workflowSignature(f.frame) };
            f.connections.push({ id: "cycle", fromNodeId: f.frame.id, toNodeId: f.story.id });
        }
        expect(() => workflowGenerationSources(f.request, f.nodes, f.connections)).toThrow();
        expect(() => createWorkflowDocuments(f.request, f.nodes, f.connections, { x: 0, y: 0 })).toThrow();
    });
}
