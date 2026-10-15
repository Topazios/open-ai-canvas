import { cancelAgentRun, reconcileCanvasNodeTasks } from "./api/agent";
import { cancelGenerationTask } from "./api/task-center";
import type { CanvasNodeData } from "@/types/canvas";

export async function cancelRemovedCanvasNodeTasks(removed: CanvasNodeData[], remaining: CanvasNodeData[]) {
    const agents = new Set(removed.flatMap((node) => node.metadata?.shortDrama?.productionAgent?.runId || []));
    const retained = new Set(remaining.flatMap((node) => node.metadata?.taskId || []));
    const tasks = new Set(removed.flatMap((node) => node.metadata?.taskId && !retained.has(node.metadata.taskId) && ["queued", "running"].includes(node.metadata.taskStatus || "") ? [node.metadata.taskId] : []));
    for (const id of agents) await cancelAgentRun(id);
    for (const id of tasks) await cancelGenerationTask(id);
}

export { reconcileCanvasNodeTasks };
