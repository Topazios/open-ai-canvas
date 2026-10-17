import { createShortDramaPipeline } from "../../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, type WorkflowGenerationRequest } from "../../src/lib/canvas/canvas-short-drama-workflow";
import { commitCanvasGenerationResult } from "../../src/lib/canvas/canvas-generation-result";
import { shortDramaStep, type ShortDramaStepId } from "../../src/lib/short-drama-steps";
import { bibleOutput, assetItem } from "./workflow-asset-output";
import { completeWorkflowPlan } from "./workflow-plan";

export function workflowImageFixture(options: { failedAssetSummaries?: boolean } = {}) {
    const pipeline = createShortDramaPipeline({ x: 0, y: 0 }, true);
    pipeline.nodes[0].metadata!.content = "Fixture topic";
    let nodes = pipeline.nodes;
    let connections = pipeline.connections;
    const request: WorkflowGenerationRequest = { step: "story.plan", pipelineId: nodeWorkflow(nodes[0])!.pipelineId, sourceNodeIds: [nodes[0].id], model: "fixture::text", instruction: "", episodeCount: 2, minutesPerEpisode: "2", start: 1, count: 2 };
    const steps: ShortDramaStepId[] = ["story.plan", "story.episodes", "story.body", "assets.bible", "assets.characters", "assets.environments", "assets.props", "direction.shots", "direction.production"];
    for (const step of steps) {
        const sourceNodeIds = defaultWorkflowSources(step, request.pipelineId, nodes).filter(Boolean);
        const result = createWorkflowDocuments({ ...request, step, sourceNodeIds }, nodes, connections, { x: 0, y: 0 });
        nodes = result.nodes; connections = result.connections;
        if (step === "story.plan") { completeWorkflowPlan(result); continue; }
        for (const node of result.created) {
            const content = step === "assets.bible" ? bibleOutput : shortDramaStep(step)?.output === "asset-group"
                ? JSON.stringify({ summary: "Fixture coverage", items: [assetItem(`${step} A`, `${step} A: fixed features and voice`, 1), assetItem(`${step} B`, `${step} B: different features and voice`, 2)] })
                : step === "direction.production" ? JSON.stringify({ shots: [1, 2].map((number) => ({ id: `SH0${number}`, title: `Shot ${number}`, assetKeys: [], prompt: `SHOT_${number}_BOARD`, startFramePrompt: `SHOT_${number}_START`, endFramePrompt: `SHOT_${number}_END`, keyframes: [{ id: "K1", time: "2s", prompt: `SHOT_${number}_KEY` }], negativePrompt: "No costume changes", continuity: "Preserve eyeline" })) })
                : `${step} episode ${nodeWorkflow(node)?.episodeNumber || "all"}: scene goals, blocking, shots, continuity, dialogue and timing`;
            nodes = commitCanvasGenerationResult(nodes, node, { ...node, metadata: { ...node.metadata, content, status: "success" } }, `fixture-${node.id}`);
            if (options.failedAssetSummaries && step !== "assets.bible" && shortDramaStep(step)?.output === "asset-group") {
                const manifest = nodes.find((entry) => entry.id === node.id)!;
                Object.assign(manifest.metadata!, { content: "", status: "error" });
                Object.assign(nodeWorkflow(manifest)!, { assetOutput: true, materializedTaskId: undefined });
            }
        }
    }
    const sourceNodeIds = defaultWorkflowSources("assets.character_references", request.pipelineId, nodes).filter(Boolean);
    return { nodes, connections, request: { ...request, step: "assets.character_references" as const, model: "fixture::image", sourceNodeIds, imageSettings: { size: "1536x1024", quality: "auto", transparentBackground: "false" } } };
}
