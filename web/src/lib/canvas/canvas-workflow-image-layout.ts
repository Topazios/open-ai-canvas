import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { layoutCanvasGridGroups } from "./canvas-group-grid";

export { WORKFLOW_IMAGE_GRID } from "./canvas-group-grid";

/** Only production image containers participate; ordinary canvas images keep their sizing. */
export function layoutWorkflowImageGroups(nodes: CanvasNodeData[], groupIds?: ReadonlySet<string>): CanvasNodeData[] {
    const ids = new Set(nodes.filter(node => node.type === CanvasNodeType.Frame && node.metadata?.shortDrama?.mediaKind === "image" && node.metadata.shortDrama.mediaGroup && (!groupIds || groupIds.has(node.id))).map(node => node.id));
    const laidOut = layoutCanvasGridGroups(nodes, ids);
    const patches = laidOut.map(node => ids.has(node.id) && node.metadata?.shortDrama?.mediaGroup?.layout !== "grid"
        ? { ...node, metadata: { ...node.metadata, shortDrama: { ...node.metadata!.shortDrama!, mediaGroup: { ...node.metadata!.shortDrama!.mediaGroup!, layout: "grid" as const } } } }
        : node);
    return patches.some((node, i) => node !== laidOut[i]) ? patches : laidOut;
}
