import { expect, test } from "bun:test";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { ShortDramaStep } from "@/lib/short-drama-steps";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, type WorkflowGenerationRequest } from "@/lib/canvas/canvas-short-drama-workflow";
import { workflowImageFixture } from "./fixtures/workflow-image-project";

// Exercise the actual form payload: downstream range tests alone cannot catch
// a later object property overwriting the value selected in the form.
const source = await Bun.file(new URL("../src/components/canvas/canvas-workflow-generator.tsx", import.meta.url)).text();
const payloads: string[] = [];
function visit(node: Node) {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "onGenerate") {
        payloads.push(source.slice(node.arguments[0].start!, node.arguments[0].end!));
    }
    for (const value of Object.values(node)) {
        for (const child of Array.isArray(value) ? value : [value]) {
            if (child && typeof child === "object" && typeof child.type === "string") visit(child as Node);
        }
    }
}
visit(parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] }));
expect(payloads).toHaveLength(1);

function formRequest(overrides: Record<string, unknown> = {}): WorkflowGenerationRequest {
    const state = {
        ShortDramaStep, step: { id: ShortDramaStep.Shots }, target: { step: ShortDramaStep.Shots, pipelineId: "p" },
        globalSettings: undefined, sources: ["body"], model: "fixture::text", isImage: false, isAudio: false,
        config: { textReasoningEffort: "high" }, instruction: "", episodeCount: 12, total: 12,
        minutes: "3-5", parameters: { minutesPerEpisode: "3-5" },
        start: 1, count: 1, storyboardStartEpisode: 1, storyboardEpisodeCount: 2,
        shotDurationSeconds: 27, shotDurationToleranceSeconds: 3, ...overrides,
    };
    return new Function(...Object.keys(state), `return (${payloads[0]});`)(...Object.values(state));
}

test("storyboard form preserves selected count instead of hidden general defaults", () => {
    expect(formRequest()).toMatchObject({ start: 1, count: 2, episodeCount: 12, shotDurationSeconds: 27, shotDurationToleranceSeconds: 3 });
    expect(formRequest({ start: 12, count: 1, storyboardStartEpisode: 4, storyboardEpisodeCount: 3 })).toMatchObject({ start: 4, count: 3 });
});

test("body form continues to use its own episode range", () => {
    expect(formRequest({ step: { id: ShortDramaStep.Body }, target: { step: ShortDramaStep.Body, pipelineId: "p" }, start: 3, count: 4 })).toMatchObject({ start: 3, count: 4 });
    expect(formRequest({ step: { id: ShortDramaStep.Body } }).shotDurationSeconds).toBeUndefined();
});

test("submitted form range creates two independently bound episode nodes", () => {
    const f = workflowImageFixture();
    const request = formRequest({
        target: { step: ShortDramaStep.Shots, pipelineId: f.request.pipelineId },
        sources: defaultWorkflowSources(ShortDramaStep.Shots, f.request.pipelineId, f.nodes).filter(Boolean),
    });
    const result = createWorkflowDocuments(request, f.nodes, f.connections, { x: 0, y: 0 });
    expect(result.created.map(node => nodeWorkflow(node)?.episodeNumber)).toEqual([1, 2]);
    for (const node of result.created) {
        const data = nodeWorkflow(node)!;
        expect(data.parameters).toMatchObject({ shotDurationSeconds: 27, shotDurationToleranceSeconds: 3 });
        const bodies = data.sourceNodeIds.map(id => result.nodes.find(entry => entry.id === id)).filter(entry => nodeWorkflow(entry)?.step === ShortDramaStep.Body);
        expect(bodies).toHaveLength(1);
        expect(nodeWorkflow(bodies[0])?.episodeNumber).toBe(data.episodeNumber);
        expect(nodeWorkflow(result.nodes.find(entry => entry.id === node.parentId))?.sourceNodeIds).toContain(node.id);
    }
    const second = createWorkflowDocuments({ ...request, start: 2, count: 1 }, f.nodes, f.connections, { x: 0, y: 0 });
    expect(second.created.map(node => nodeWorkflow(node)?.episodeNumber)).toEqual([2]);
});
