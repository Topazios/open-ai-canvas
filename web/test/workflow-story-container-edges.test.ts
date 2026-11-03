import { expect, test } from "bun:test";
import { createWorkflowDocuments, nodeWorkflow, restoreWorkflowSourceConnections } from "../src/lib/canvas/canvas-short-drama-workflow";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { ShortDramaStep } from "../src/lib/short-drama-steps";
import { completeUnifiedWorkflowPlan } from "./fixtures/workflow-plan";

function fixture() {
    const p = createShortDramaPipeline({ x: 0, y: 0 }, true);
    p.nodes[0].metadata!.content = "选定故事";
    const request = {
        step: ShortDramaStep.Plan, pipelineId: nodeWorkflow(p.nodes[0])!.pipelineId, sourceNodeIds: [p.storyNodeId],
        model: "test", instruction: "", episodeCount: 4, minutesPerEpisode: "2", start: 1, count: 4,
    };
    const result = createWorkflowDocuments(request, p.nodes, p.connections, { x: 0, y: 0 });
    const plan = completeUnifiedWorkflowPlan(result);
    const story = plan.docs.find((node) => node.metadata?.shortDrama?.planSection === "story")!;
    return { result, plan, story, p };
}

test("a story outline placed inside its own plan container gets no edge from that container", () => {
    const { result, plan, story } = fixture();
    expect(story).toBeDefined();
    story.parentId = plan.frame.id;
    nodeWorkflow(story)!.sourceNodeIds = [plan.frame.id];
    const restored = restoreWorkflowSourceConnections(result.nodes, result.connections);
    expect(restored.some((edge) => edge.fromNodeId === plan.frame.id && edge.toNodeId === story.id)).toBe(false);
    expect(restored.some((edge) => edge.fromNodeId === story.id && edge.toNodeId === plan.frame.id)).toBe(false);
    expect(restored).toBe(result.connections);
});

test("a story outline outside the container still gets the edge from its real source", () => {
    const { result, plan, story, p } = fixture();
    story.parentId = undefined;
    nodeWorkflow(story)!.sourceNodeIds = [p.storyNodeId];
    const withoutEdges = result.connections.filter((edge) => edge.toNodeId !== story.id && edge.fromNodeId !== story.id);
    const restored = restoreWorkflowSourceConnections(result.nodes, withoutEdges);
    expect(restored.length).toBeGreaterThan(withoutEdges.length);
    expect(plan.frame.id).toBeTruthy();
});
