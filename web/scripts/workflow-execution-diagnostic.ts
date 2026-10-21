import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { createWorkflowDocuments, nodeWorkflow, workflowBodyTaskInput } from "../src/lib/canvas/canvas-short-drama-workflow";
import { ShortDramaStep } from "../src/lib/short-drama-steps";
import { canonicalize } from "json-canonicalize";
import type { CanvasNodeData } from "../src/types/canvas";

// Bounded, read-only inspection. Never print prompts, prose, errors or credentials.
const [path, canvasId] = process.argv.slice(2);
if (!path || !canvasId) throw new Error("Usage: bun scripts/workflow-execution-diagnostic.ts <database> <canvas-id>");
const db = new Database(resolve(path), { readonly: true });
const parse = (text: string) => { try { return JSON.parse(text); } catch { return {}; } };
const elapsed = (start?: string, end?: string) => {
    if (!start || !end) return undefined;
    const delta = Date.parse(end.replace(" ", "T")) - Date.parse(start.replace(" ", "T"));
    return Number.isFinite(delta) ? Math.round(delta / 1000) : undefined;
};
try {
    const saved = db.query("SELECT payload_json FROM canvas_projects WHERE id = ?").get(canvasId) as { payload_json: string } | null;
    if (!saved) throw new Error("Canvas not found");
    const canvas = parse(saved.payload_json);
    const nodes = canvas.nodes as CanvasNodeData[];
    const completed = nodes.filter(node => nodeWorkflow(node)?.step === ShortDramaStep.Body && nodeWorkflow(node)?.role === "document" && node.metadata?.content?.trim() && node.metadata?.status === "success").slice(0, 10);
    const contexts = completed.map(body => {
        const data = nodeWorkflow(body)!;
        try {
            const request = { step: ShortDramaStep.Audit, pipelineId: data.pipelineId, sourceNodeIds: [body.id], model: "diagnostic-only", instruction: "", episodeCount: data.parameters?.episodeCount || 1, minutesPerEpisode: data.parameters?.minutesPerEpisode || "", start: data.episodeNumber!, count: 1, globalSettings: canvas.globalSettings };
            const result = createWorkflowDocuments(request, nodes, canvas.connections, { x: 0, y: 0 });
            const audit = result.created[0];
            const auditInput = workflowBodyTaskInput(audit, result.nodes);
            const report = data.screenplayAudit?.report;
            let repairChars: number | undefined;
            if (report?.findings.length) {
                const reviewed = { ...audit, metadata: { ...audit.metadata, status: "success" as const, shortDrama: { ...nodeWorkflow(audit)!, screenplayAudit: { ...nodeWorkflow(audit)!.screenplayAudit!, report, reportSignature: canonicalize(report) } } } };
                const repair = createWorkflowDocuments({ ...request, step: ShortDramaStep.Body, auditRepairReportId: reviewed.id }, result.nodes.map(node => node.id === reviewed.id ? reviewed : node), result.connections, { x: 0, y: 0 });
                repairChars = workflowBodyTaskInput(repair.created[0], repair.nodes).prompt.length;
            }
            return { episode: data.episodeNumber, auditChars: auditInput.prompt.length, repairChars, contextDocuments: nodeWorkflow(audit)?.screenplayAudit?.contextNodeIds.length, genericBatch: Boolean(auditInput.workflowBatch) };
        } catch { return { episode: data.episodeNumber, reconstructable: false }; }
    });
    const recent = db.query("SELECT id, operation, status, input_json, prompt, created_at, started_at, completed_at FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 80").all(canvasId) as Array<{ id: string; operation: string; status: string; input_json: string; prompt: string; created_at: string; started_at?: string; completed_at?: string }>;
    const executions = recent.filter(task => task.operation !== "cloud_agent" && task.operation !== "cloud_agent_step").slice(0, 30).map(task => {
        const input = parse(task.input_json);
        const provider = db.query("SELECT count(*) AS calls, sum(duration_ms) AS ms FROM api_call_logs WHERE task_id = ?").get(task.id) as { calls: number; ms?: number };
        const operation = task.prompt.includes("你是短剧修订编剧") ? "repair" : task.prompt.includes("你是短剧质量诊断员") ? "audit" : input.metadata?.batchKey || input.metadata?.workflowStep || task.operation;
        return { operation, episode: input.metadata?.episodeNumber, status: task.status, promptChars: task.prompt.length, queueSeconds: elapsed(task.created_at, task.started_at), executionSeconds: elapsed(task.started_at, task.completed_at), providerCalls: provider.calls, providerSeconds: provider.ms == null ? undefined : Math.round(provider.ms / 1000) };
    });
    const row = db.query("SELECT value_json FROM system_settings WHERE key = ?").get("runtime_policy") as { value_json: string } | null;
    const taskPolicy = row && parse(row.value_json).task;
    const policy = taskPolicy ? Object.fromEntries(Object.entries(taskPolicy).filter(([key]) => /Concurrency$/.test(key))) : undefined;
    console.log(JSON.stringify({ policy, contexts, executions }, null, 2));
} finally { db.close(); }
