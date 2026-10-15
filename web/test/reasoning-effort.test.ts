import { expect, test } from "bun:test";
import { normalizeReasoningEffort } from "../src/lib/reasoning-effort";
import { prepareBackendGenerationTask, prepareBackendToolGenerationTask } from "../src/services/api/generation-task";
import { createModelChannel, defaultConfig, encodeChannelModel } from "../src/stores/use-config-store";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, nodeWorkflow } from "../src/lib/canvas/canvas-short-drama-workflow";

function config() {
    const channel = createModelChannel({ id: "fixture", name: "Fixture", baseUrl: "https://example.com/v1", apiKey: "", interfaceType: "openai-response", models: ["text"],
        modelCosts: [{ model: "text", capability: "text", protocol: "openai-response", billingMode: "fixed_request", unitPriceMicrocredits: 1 }] });
    return { ...defaultConfig, channels: [channel], model: encodeChannelModel(channel.id, "text") };
}

test("text requests default to medium and honor the captured override", async () => {
    const base = config();
    for (const value of [undefined, "low", "medium", "high"] as const) {
        const task = await prepareBackendGenerationTask({ mode: "text", prompt: "fixture", config: { ...base, textReasoningEffort: value } });
        expect(task.input?.textOptions).toMatchObject({ reasoningEffort: value || "medium" });
    }
    const task = await prepareBackendGenerationTask({ mode: "text", prompt: "fixture", config: { ...base, textReasoningEffort: "low" }, reasoningEffort: "high" });
    expect(task.input?.textOptions).toMatchObject({ reasoningEffort: "high" });
    expect(normalizeReasoningEffort("old-invalid-setting")).toBe("medium");
});

test("tool calls use the same preference as ordinary text", () => {
    const task = prepareBackendToolGenerationTask({ prompt: "fixture", config: { ...config(), textReasoningEffort: "low" }, messages: [{ role: "user", content: "fixture" }], tools: [], toolChoice: "auto" });
    expect(task.input?.textOptions).toMatchObject({ reasoningEffort: "low" });
});

test("workflow output captures effort without changing story source signatures", () => {
    const pipeline = createShortDramaPipeline({ x: 0, y: 0 }, true);
    pipeline.nodes[0].metadata!.content = "选题与核心冲突";
    const request = { step: "story.plan" as const, pipelineId: nodeWorkflow(pipeline.nodes[0])!.pipelineId, sourceNodeIds: [pipeline.storyNodeId], model: "fixture", instruction: "", episodeCount: 3, minutesPerEpisode: "2", start: 1, count: 1 };
    const high = createWorkflowDocuments({ ...request, reasoningEffort: "high" }, pipeline.nodes, [], { x: 0, y: 0 });
    const medium = createWorkflowDocuments(request, pipeline.nodes, [], { x: 0, y: 0 });
    expect(high.created[0].metadata?.reasoningEffort).toBe("high");
    expect(medium.created[0].metadata?.reasoningEffort).toBe("medium");
    expect(high.created[0].metadata?.shortDrama?.sourceSignatures).toEqual(medium.created[0].metadata?.shortDrama?.sourceSignatures);
    expect(JSON.parse(JSON.stringify(high.created[0])).metadata.reasoningEffort).toBe("high");
});
