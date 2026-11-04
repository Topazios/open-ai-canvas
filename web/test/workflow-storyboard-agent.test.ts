import { expect, test } from "bun:test";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowSignature } from "@/lib/canvas/canvas-short-drama-workflow";
import { rebaseStoryboardAgentNode } from "@/pages/canvas/use-production-agent-runs";
import { workflowImageFixture } from "./fixtures/workflow-image-project";

test("storyboard uses durable production agent with compact prompt and existing episode container", () => {
    const f = workflowImageFixture();
    const result = createWorkflowDocuments({ ...f.request, step: "direction.shots", model: "fixture::text", sourceNodeIds: defaultWorkflowSources("direction.shots", f.request.pipelineId, f.nodes).filter(Boolean) }, f.nodes, f.connections, { x: 0, y: 0 });
    expect(result.created.length).toBeGreaterThan(0);
    for (const node of result.created) {
        expect(nodeWorkflow(node)?.productionAgent).toEqual({});
        expect(nodeWorkflow(node)?.textBatch).toBeUndefined();
        expect(nodeWorkflow(node)?.parameters).toMatchObject({ shotDurationSeconds: 10, shotDurationToleranceSeconds: 3 });
        expect(node.metadata!.prompt).toContain("完整镜头清单");
        expect(node.metadata!.prompt).toContain("全局Agent并发策略");
		expect(node.metadata!.prompt).toContain("以集为单位并发");
		expect(node.metadata!.prompt).toContain("不创建逐镜并发任务");
        expect(node.metadata!.prompt).not.toContain("关联来源：");
        const parent = result.nodes.find((entry) => entry.id === node.parentId)!;
        expect(nodeWorkflow(parent)?.sourceNodeIds).toContain(node.id);
        expect(nodeWorkflow(parent)?.step).toBe("direction.shots");
        expect(nodeWorkflow(node)?.sourceNodeIds.length).toBeGreaterThan(0);
    }
});

test("storyboard selects the matching body collection when launched from an episode", () => {
	const f = workflowImageFixture();
	const body = f.nodes.find((node) => nodeWorkflow(node)?.step === "story.body" && nodeWorkflow(node)?.episodeNumber === 1)!;
	const sourceNodeIds = defaultWorkflowSources("direction.shots", f.request.pipelineId, f.nodes, body.id).filter(Boolean);
	const bodyCollection = f.nodes.find((node) => nodeWorkflow(node)?.step === "story.body" && nodeWorkflow(node)?.role === "collection")!;
	expect(sourceNodeIds).toContain(bodyCollection.id);
	const result = createWorkflowDocuments({ ...f.request, step: "direction.shots", model: "fixture::text", sourceNodeIds }, f.nodes, f.connections, { x: 0, y: 0 });
	expect(result.created).toHaveLength(2);
	expect(nodeWorkflow(result.created[0])?.parameters).toMatchObject({ minutesPerEpisode: "2" });
	const firstEpisodeStoryboard = result.created.find((node) => nodeWorkflow(node)?.episodeNumber === 1)!;
	expect(nodeWorkflow(firstEpisodeStoryboard)?.sourceNodeIds).toContain(body.id);
});

test("storyboard range filters the selected episode bodies and persists timing controls", () => {
	const f = workflowImageFixture();
	const sourceNodeIds = defaultWorkflowSources("direction.shots", f.request.pipelineId, f.nodes).filter(Boolean);
	const result = createWorkflowDocuments({ ...f.request, step: "direction.shots", model: "fixture::text", sourceNodeIds, start: 2, count: 1, shotDurationSeconds: 15, shotDurationToleranceSeconds: 5 }, f.nodes, f.connections, { x: 0, y: 0 });
	expect(result.created).toHaveLength(1);
	expect(nodeWorkflow(result.created[0])).toMatchObject({ episodeNumber: 2, parameters: { shotDurationSeconds: 15, shotDurationToleranceSeconds: 5 } });
	const selectedBody = nodeWorkflow(result.nodes.find((node) => node.id === nodeWorkflow(result.created[0])!.sourceNodeIds.find((id) => nodeWorkflow(result.nodes.find((entry) => entry.id === id))?.step === "story.body"))!);
	expect(selectedBody?.episodeNumber).toBe(2);
});

test("explicit shot duration reaches each episode target and its persisted collection", () => {
    const f = workflowImageFixture();
    const result = createWorkflowDocuments({ ...f.request, step: "direction.shots", model: "fixture::text", shotDurationSeconds: 15, shotDurationToleranceSeconds: 5, sourceNodeIds: defaultWorkflowSources("direction.shots", f.request.pipelineId, f.nodes).filter(Boolean) }, f.nodes, f.connections, { x: 0, y: 0 });
    for (const node of result.created) {
        expect(nodeWorkflow(node)?.parameters).toMatchObject({ shotDurationSeconds: 15, shotDurationToleranceSeconds: 5 });
        expect(nodeWorkflow(result.nodes.find(item => item.id === node.parentId))?.parameters).toMatchObject({ shotDurationSeconds: 15, shotDurationToleranceSeconds: 5 });
    }
});

test("failed storyboard retry rebinds the same node to the current episode body", () => {
    const f = workflowImageFixture();
    const result = createWorkflowDocuments({ ...f.request, step: "direction.shots", model: "fixture::text", sourceNodeIds: defaultWorkflowSources("direction.shots", f.request.pipelineId, f.nodes).filter(Boolean) }, f.nodes, f.connections, { x: 0, y: 0 });
    const original = result.created[0];
    const originalData = nodeWorkflow(original)!;
    const running = { ...original, metadata: { ...original.metadata, shortDrama: { ...originalData, productionAgent: { runId: "old-run" } } } };
    const bodyId = originalData.sourceNodeIds.find((id) => nodeWorkflow(result.nodes.find((node) => node.id === id))?.step === "story.body")!;
    const currentNodes = result.nodes.map((node) => node.id === bodyId ? { ...node, metadata: { ...node.metadata, content: `${node.metadata?.content || ""}\n新增正文事实。` } } : node);
    const rebased = rebaseStoryboardAgentNode(running, currentNodes);
    const rebasedData = nodeWorkflow(rebased)!;
    expect(rebased.id).toBe(original.id);
    expect(rebasedData.productionAgent).toEqual({});
    expect(rebasedData.operationId).not.toBe(originalData.operationId);
    expect(rebasedData.sourceSignatures[bodyId]).toBe(workflowSignature(currentNodes.find((node) => node.id === bodyId)!));
    expect(rebased.metadata?.taskStage).toBe("准备基于新版正文重试");
});
