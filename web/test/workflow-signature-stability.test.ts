import { expect, test } from "bun:test";
import { canonicalize } from "json-canonicalize";
import { createShortDramaPipeline } from "../src/lib/canvas/canvas-short-drama";
import { createWorkflowDocuments, defaultWorkflowSources, nodeWorkflow, workflowGenerationSources, workflowSignature, workflowSignatureMatches, workflowSourceSignaturesMatch } from "../src/lib/canvas/canvas-short-drama-workflow";
import { commitCanvasGenerationResult } from "../src/lib/canvas/canvas-generation-result";
import { bibleOutput } from "./fixtures/workflow-asset-output";
import type { CanvasNodeData } from "../src/types/canvas";

function legacy(node: CanvasNodeData) {
    const d = nodeWorkflow(node);
    const fields: unknown[] = [node.title, node.metadata?.content || "", d?.step, d?.sourceNodeIds, d?.parameters, node.metadata?.storyDevelopment?.brief];
    if (d?.assetProfile || d?.bibleConfirmation) fields.push({ assetProfile: d.assetProfile, bibleConfirmation: d.bibleConfirmation });
    let h = 2166136261;
    const text = JSON.stringify(fields);
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
}

test("a rebased source must be revalidated before live submission or background recovery", () => {
    const pipeline = createShortDramaPipeline({ x: 0, y: 0 }, true);
    const source = pipeline.nodes[0];
    const data = { ...nodeWorkflow(source)!, sourceNodeIds: [source.id], sourceSignatures: { [source.id]: workflowSignature(source) } };
    expect(workflowSourceSignaturesMatch(data, [source])).toBe(true);
    expect(workflowSourceSignaturesMatch(data, [{ ...source, position: { x: 99, y: 123 } }])).toBe(true);
    expect(workflowSourceSignaturesMatch(data, [{ ...source, metadata: { ...source.metadata, content: "new server content" } }])).toBe(false);
    expect(workflowSourceSignaturesMatch(data, [])).toBe(false);
});

test("Go key ordering preserves current and existing workflow inputs for every extraction category", () => {
    const p = createShortDramaPipeline({ x: 0, y: 0 }, true);
    p.nodes[0].metadata!.content = "Selected topic";
    const pipelineId = nodeWorkflow(p.nodes[0])!.pipelineId;
    const base = { pipelineId, model: "fixture", episodeCount: 2, minutesPerEpisode: "3", instruction: "", start: 1, count: 2 };
    let result = { ...p, created: [p.nodes[0]] };
    for (const step of ["story.plan", "story.episodes", "story.body"] as const) {
        const next = createWorkflowDocuments({ ...base, step, sourceNodeIds: [result.created[0].id] }, result.nodes, result.connections, { x: 0, y: 0 });
        next.created.forEach((node) => { node.metadata!.content = "Complete document"; node.metadata!.status = "success"; });
        result = { ...result, ...next };
    }
    const body = result.nodes.find((n) => nodeWorkflow(n)?.step === "story.body" && nodeWorkflow(n)?.role === "collection")!;
    const bible = createWorkflowDocuments({ ...base, step: "assets.bible", sourceNodeIds: [body.id] }, result.nodes, result.connections, { x: 0, y: 0 });
    const before = bible.created[0];
    const nodes = commitCanvasGenerationResult(bible.nodes, before, { ...before, metadata: { ...before.metadata, content: bibleOutput, status: "success" } }, "fixture");
    for (const version of ["v1", "v2"]) {
        const snapshot = structuredClone(nodes);
        if (version === "v1") for (const node of snapshot) {
            const data = nodeWorkflow(node);
            if (data) data.sourceSignatures = Object.fromEntries(Object.keys(data.sourceSignatures).map((id) => [id, legacy(snapshot.find((n) => n.id === id)!)]));
        }
        const persisted: CanvasNodeData[] = JSON.parse(canonicalize(snapshot));
        for (let i = 0; i < nodes.length; i++) {
            expect(workflowSignature(persisted[i])).toBe(workflowSignature(nodes[i]));
            expect(workflowSignatureMatches(persisted[i], version === "v1" ? legacy(nodes[i]) : workflowSignature(nodes[i]))).toBe(true);
        }
        for (const step of ["assets.bible", "assets.characters", "assets.environments", "assets.props", "assets.special"] as const) {
            const sourceNodeIds = defaultWorkflowSources(step, pipelineId, persisted, body.id).filter(Boolean);
            expect(() => workflowGenerationSources({ step, pipelineId, sourceNodeIds }, persisted, bible.connections)).not.toThrow();
        }
        persisted.find((n) => n.id === result.created[0].id)!.metadata!.content += "real edit";
        expect(() => workflowGenerationSources({ step: "assets.characters", pipelineId, sourceNodeIds: [body.id, before.parentId!] }, persisted, bible.connections)).toThrow("前文已更新");
    }
});

test("signature detects real parameter edits after JSON reordering", () => {
    const p = createShortDramaPipeline({ x: 0, y: 0 }, true);
    const n = p.nodes[0]; n.metadata!.content = "Prose";
    const expected = workflowSignature(n);
    const sorted = JSON.parse(canonicalize(n));
    expect(workflowSignatureMatches(sorted, expected)).toBe(true);
    sorted.metadata.storyDevelopment.brief.episodeCount++;
    expect(workflowSignatureMatches(sorted, expected)).toBe(false);
    expect(workflowSignatureMatches(sorted, legacy(n))).toBe(false);
});
