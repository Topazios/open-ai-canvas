import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { createWorkflowDocuments, nodeWorkflow, workflowBodyTaskInput } from "../src/lib/canvas/canvas-short-drama-workflow";
import { ShortDramaStep } from "../src/lib/short-drama-steps";
import type { CanvasNodeData } from "../src/types/canvas";

// Read-only admission check: no project writes, prompts, credentials or model calls.
const [path, canvasId] = process.argv.slice(2);
if (!path || !canvasId) throw new Error("Usage: bun scripts/workflow-audit-diagnostic.ts <database> <canvas-id>");
const db = new Database(resolve(path), { readonly: true });
try {
    const saved = db.query("SELECT payload_json FROM canvas_projects WHERE id = ?").get(canvasId) as { payload_json: string } | null;
    if (!saved) throw new Error("Canvas not found");
    const canvas = JSON.parse(saved.payload_json);
    const nodes = canvas.nodes as CanvasNodeData[];
    const bodies = nodes.filter(node => nodeWorkflow(node)?.step === ShortDramaStep.Body && nodeWorkflow(node)?.role === "document" && node.metadata?.content?.trim() && !["loading", "error"].includes(node.metadata?.status || ""));
    const checks = bodies.map(body => {
        const data = nodeWorkflow(body)!;
        try {
            const result = createWorkflowDocuments({ step: ShortDramaStep.Audit, pipelineId: data.pipelineId, sourceNodeIds: [body.id], model: "diagnostic-only", instruction: "", episodeCount: data.parameters?.episodeCount || 1, minutesPerEpisode: data.parameters?.minutesPerEpisode || "", start: 1, count: 1, globalSettings: canvas.globalSettings }, nodes, canvas.connections, { x: 0, y: 0 });
            const audit = result.created[0];
            const input = workflowBodyTaskInput(audit, result.nodes);
            return { episode: data.episodeNumber, accepted: true, promptChars: input.prompt.length, contextDocuments: nodeWorkflow(audit)?.screenplayAudit?.contextNodeIds.length, assetAgent: !!nodeWorkflow(audit)?.productionAgent, genericBatch: !!input.workflowBatch };
        } catch (error) { return { episode: data.episodeNumber, accepted: false, error: error instanceof Error ? error.message : "Invalid input" }; }
    });
    console.log(JSON.stringify({ completedBodyVersions: bodies.length, checks }, null, 2));
} finally { db.close(); }
