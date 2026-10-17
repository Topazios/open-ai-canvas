import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { createWorkflowDocuments } from "../src/lib/canvas/canvas-short-drama-workflow";
import { ShortDramaStep } from "../src/lib/short-drama-steps";
import type { CanvasNodeData, CanvasConnection } from "../src/types/canvas";

// Read-only comparison against the real persisted canvas. Never submits a task
// or prints source prose, configuration credentials or provider payloads.
const [databasePath, taskId] = process.argv.slice(2);
if (!databasePath || !taskId) throw new Error("Usage: bun scripts/workflow-outline-context-diagnostic.ts <database> <task-id>");
const db = new Database(resolve(databasePath), { readonly: true });
try {
    const task = db.query("SELECT user_id, project_id, input_json FROM tasks WHERE id = ?").get(taskId) as { user_id: string; project_id: string; input_json: string } | null;
    if (!task) throw new Error("Task not found");
    const saved = JSON.parse(task.input_json);
    if (saved.metadata?.workflowStep !== ShortDramaStep.Episodes) throw new Error("Not an outline task");
    const snapshot = db.query("SELECT payload_json FROM canvas_snapshots WHERE canvas_id = ? AND user_id = ? ORDER BY revision DESC LIMIT 1").get(task.project_id, task.user_id) as { payload_json: string } | null;
    if (!snapshot) throw new Error("Canvas snapshot not found");
    const canvas = JSON.parse(snapshot.payload_json);
    const nodes = canvas.nodes as CanvasNodeData[];
    const source = nodes.find((node) => node.id === saved.metadata.nodeId);
    const workflow = source?.metadata?.shortDrama;
    if (!workflow) throw new Error("Original outline node not found");
    const count = workflow.parameters?.episodeCount || 12;
    const generated = createWorkflowDocuments({ step: ShortDramaStep.Episodes, pipelineId: workflow.pipelineId, sourceNodeIds: workflow.sourceNodeIds,
        model: source?.metadata?.model || "diagnostic-only", instruction: workflow.parameters?.instruction || "", episodeCount: count,
        minutesPerEpisode: workflow.parameters?.minutesPerEpisode || "2", start: 1, count: 1, globalSettings: canvas.globalSettings,
    }, nodes, canvas.connections as CanvasConnection[], { x: 0, y: 0 });
    const batch = generated.created[0].metadata!.shortDrama!.textBatch!;
    const oldChars = (saved.workflowBatch?.units || []).reduce((sum: number, unit: { text: string }) => sum + unit.text.length, 0);
    const newChars = batch.units.reduce((sum, unit) => sum + unit.text.length, 0);
    console.log(JSON.stringify({ originalUnits: saved.workflowBatch?.units?.length, originalContextChars: oldChars,
        newVersion: batch.version, newSourceUnits: batch.units.length, newContextChars: newChars,
        reductionPercent: Math.round((1 - newChars / oldChars) * 1000) / 10,
        episodeCount: batch.version === 3 ? batch.episodeCount : null,
        outlineRanges: batch.version === 3 ? Math.ceil(batch.episodeCount / 5) : null,
        needsContextCondensing: newChars > 24000,
    }, null, 2));
} finally { db.close(); }
