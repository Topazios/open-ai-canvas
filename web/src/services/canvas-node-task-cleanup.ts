import { cancelAgentRun, reconcileCanvasNodeTasks } from "./api/agent";
import { cancelGenerationTask } from "./api/task-center";
import type { CanvasNodeData } from "@/types/canvas";

export async function cancelRemovedCanvasNodeTasks(removed: CanvasNodeData[], remaining: CanvasNodeData[]) {
    // A removed container does not carry the run itself; the run lives on its target node (manifest or plan root).
    const known = new Map([...remaining, ...removed].map((node) => [node.id, node] as const));
    const targetIds = removed.flatMap((node) => {
        const data = node.metadata?.shortDrama;
        return [data?.assetGroup?.manifestId, data?.planGroup?.rootFrameId].filter((id): id is string => Boolean(id));
    });
    const agents = new Set([...removed.map((node) => node.id), ...targetIds].flatMap((id) => known.get(id)?.metadata?.shortDrama?.productionAgent?.runId || []));
    const retained = new Set(remaining.flatMap((node) => node.metadata?.taskId || []));
    const tasks = new Set(removed.flatMap((node) => node.metadata?.taskId && !retained.has(node.metadata.taskId) && ["queued", "running"].includes(node.metadata.taskStatus || "") ? [node.metadata.taskId] : []));
    for (const id of agents) await cancelAgentRun(id);
    for (const id of tasks) await cancelGenerationTask(id);
}

export { reconcileCanvasNodeTasks };
