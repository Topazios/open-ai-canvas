import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { buildNodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import type { CanvasNodeData, CanvasConnection } from "../src/types/canvas";

const [path, canvasId] = process.argv.slice(2);
if (!path || !canvasId) throw new Error("Usage: bun scripts/storyboard-frame-diagnostic.ts <database> <canvas-id>");
const db = new Database(resolve(path), { readonly: true });
try {
    const saved = db.query("SELECT payload_json FROM canvas_projects WHERE id = ?").get(canvasId) as { payload_json: string } | null;
    if (!saved) throw new Error("Canvas not found");
    const canvas = JSON.parse(saved.payload_json) as { nodes: CanvasNodeData[]; connections: CanvasConnection[] };
    const results = canvas.nodes.filter(node => node.metadata?.storyboardFrame).slice(0, 40).map(node => {
        const context = buildNodeGenerationContext(node.id, canvas.nodes, canvas.connections, node.metadata!.composerContent || node.metadata!.prompt || "", []);
        return { nodeId: node.id, previousPromptChars: node.metadata?.prompt?.length, currentPromptChars: context.prompt.length, referenceImages: context.referenceImages.length, taskCreated: Boolean(node.metadata?.taskId), status: node.metadata?.status };
    });
    console.log(JSON.stringify(results, null, 2));
} finally { db.close(); }
