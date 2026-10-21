import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { createWorkflowDocuments, nodeWorkflow, workflowBodyTaskInput } from "../src/lib/canvas/canvas-short-drama-workflow";
import { compactWorkflowNodes } from "../src/lib/canvas/canvas-workflow-persistence";
import { ShortDramaStep } from "../src/lib/short-drama-steps";
import { workflowGenerationSources } from "../src/lib/canvas/canvas-short-drama-workflow";
import { bodySourceRecords } from "../src/lib/canvas/workflow-body-context";
import type { CanvasNodeData } from "../src/types/canvas";

// Reconstruct requests in memory only. No content, credentials or model calls.
const [path, canvasId] = process.argv.slice(2);
if (!path || !canvasId) throw new Error("Usage: bun scripts/workflow-body-diagnostic.ts <database> <canvas-id>");
const db = new Database(resolve(path), { readonly: true });
try {
    const saved = db.query("SELECT payload_json FROM canvas_projects WHERE id = ?").get(canvasId) as { payload_json: string };
    const canvas = JSON.parse(saved.payload_json);
    const nodes = canvas.nodes as CanvasNodeData[];
    const outline = nodes.filter(n => nodeWorkflow(n)?.step === ShortDramaStep.Episodes && n.metadata?.content?.trim()).at(-1)!;
    if (!outline) throw new Error("No completed outline");
    const data = nodeWorkflow(outline)!;
    const generated = createWorkflowDocuments({ step: ShortDramaStep.Body, pipelineId: data.pipelineId, sourceNodeIds: [outline.id],
        model: outline.metadata!.model || "diagnostic-only", instruction: "", episodeCount: data.parameters!.episodeCount,
        minutesPerEpisode: data.parameters!.minutesPerEpisode, start: 1, count: data.parameters!.episodeCount,
    }, nodes, canvas.connections, { x: 0, y: 0 });
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const inputs = generated.created.map(node => workflowBodyTaskInput(node, generated.nodes, generated.connections));
    const requestChars = inputs.map(input => input.prompt.length + JSON.stringify(input.workflowBatch || {}).length).sort((a, b) => a - b);
    const referenceCondensationNeeded = (input: typeof inputs[number]) => {
        const batch = input.workflowBatch;
        if (batch?.version !== 4) return false;
        const chars = (text: string) => Array.from(text).length;
        const context = batch.context.map(unit => `\n\n${unit.label}\n${unit.text}`).join("");
        const references = batch.units.reduce((size, unit) => size + chars(`${unit.label}\n${unit.text}`) + 2, 0);
        return references > 48000 - chars(input.prompt) - chars(context) - 1000;
    };
    console.log(JSON.stringify({ originalBytes: bytes(canvas), generatedCount: generated.created.length,
        directEpisodeRequests: inputs.filter(input => !input.workflowBatch).length,
        bodyQualityCheckedRequests: inputs.filter(input => input.workflowBatch?.version === 4 && input.workflowBatch.bodyWriting).length,
        referenceCondensationRequests: inputs.filter(referenceCondensationNeeded).length,
        largestDirectPromptChars: Math.max(0, ...inputs.filter(input => !input.workflowBatch).map(input => input.prompt.length)),
        firstRequestChars: inputs[0].prompt.length,
        assembledRequestChars: { min: requestChars[0], median: requestChars[Math.floor(requestChars.length / 2)], max: requestChars.at(-1) },
        requestBytes: bytes({ project: { ...canvas, nodes: compactWorkflowNodes(generated.nodes), connections: generated.connections } }),
        firstNodeBytes: bytes(generated.created[0]), firstBatchUnits: nodeWorkflow(generated.created[0])?.textBatch?.units.length || 0,
        firstPromptChars: generated.created[0].metadata?.prompt?.length,
        firstSources: bodySourceRecords(workflowGenerationSources(nodeWorkflow(generated.created[0])!, generated.nodes), 1, "").map(record => ({ title: record.title, chars: record.content.length })),
    }, null, 2));
} finally { db.close(); }
