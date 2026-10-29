import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import type { PlannedAssetKind } from "../production-plan";
import { nodeWorkflow } from "./canvas-short-drama-workflow";

/** Rebuild only plan-group links whose relationship is confirmed by both nodes. */
export function restorePlanGroupConnections(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const additions: CanvasConnection[] = [];
    for (const root of nodes) {
        const rootData = nodeWorkflow(root);
        if (root.type !== CanvasNodeType.Frame || rootData?.role !== "collection" || !rootData.planGroups) continue;
        for (const [kind, groupId] of Object.entries(rootData.planGroups) as [PlannedAssetKind, string][]) {
            if (!groupId || connections.some((edge) => edge.fromNodeId === root.id && edge.toNodeId === groupId) || additions.some((edge) => edge.fromNodeId === root.id && edge.toNodeId === groupId)) continue;
            const group = byId.get(groupId);
            const groupData = nodeWorkflow(group);
            if (group?.type !== CanvasNodeType.Frame || groupData?.role !== "collection" || groupData.pipelineId !== rootData.pipelineId ||
                groupData.planGroup?.rootFrameId !== root.id || groupData.planGroup.kind !== kind) continue;
            additions.push({ id: nanoid(), fromNodeId: root.id, toNodeId: groupId });
        }
    }
    return additions.length ? [...connections, ...additions] : connections;
}
